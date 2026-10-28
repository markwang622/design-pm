// REPORTS-P3-E1b: work-report snapshots — generate (initial version), revise (next version of the latest), read.
//
// Publication = fixed K → settle(K) → ONE new repeatable-read transaction that (1) re-reads and FOR SHARE-locks the
// operator (active, activated, admin, same sessionVersion as the authenticated session), (2) re-checks the idempotency
// key and the latest revision, (3) reconstructs the sources at C (end state) and at K (knowledge) and (4) inserts the
// snapshot. Initial version: K = C. Revision: K = the DB clock now. Any failure before/while inserting rolls the whole
// transaction back: no half snapshot. A conflicting writer is caught by the unique keys (idempotencyKey; period + rules
// version + revision) or by PostgreSQL serialization; the loser is re-read and translated (same key → replay, otherwise
// an explicit 409), never a bare 500.
//
// Idempotency: the fingerprint is the request's meaning (action, period, parent, expectedLatestRevision, reason, operator,
// rules version) — never K, ids or times that differ per retry. After the operator passes as a real admin, an existing key
// is handled first: same fingerprint → the original result (200, replayed), different → 409. A key cannot be claimed by
// another route or another operator, and a legal retry still replays after newer revisions exist.
//
// Timestamps are read and written as microsecond strings in SQL (never through a JS Date).
// createWorkReportService({ readSources }) exists for tests only (synthetic C/K sources over a real publication); it is
// not reachable from HTTP, env or any production switch.
//
// REPORTS-P3-E3: generateScheduled({ jobId, leaseToken }) is the internal entry of the scheduler worker
// (src/services/workReportScheduler.js) — no HTTP route reaches it. The operator is the claimed durable job, not a person:
// inside the publication transaction the job row is FOR SHARE-locked and must still be running under this lease token
// (lease not expired) in the scheduler's current epoch with an unchanged source coverage. Initial version only (K = C);
// trigger 'scheduled', generatedById/Name and payload generatedBy null. Its key and fingerprint are derived from the
// period and rules version only (own fingerprint domain; never lease, attempt or time). Any existing version of the period
// → skipped_existing linked to the real initial version; a committed snapshot of this key → replayed. Manual keys cannot
// use the reserved 'sched-' prefix.
import crypto from 'node:crypto';
import { prisma } from './db.js';
import { periodFromStart, periodInstants, listPeriods } from './reportPeriods.js';
import { withConsistentSources, fixKnowledgeCutoff, ReportSourceError } from './reportSources.js';
import { RULES_VERSION, MAX_PAYLOAD_BYTES, buildWorkReportPayload, canonicalJson, payloadSha256, filterPayload } from './workReportPayload.js';

const ISO_US = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const ts = col => `to_char(${col} AT TIME ZONE 'UTC', '${ISO_US}')`;
const META = `"id", "periodKind", to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDateExclusive", 'YYYY-MM-DD') AS "endDateExclusive",
  ${ts('"cutoffInstant"')} AS "cutoffInstant", ${ts('"knowledgeCutoff"')} AS "knowledgeCutoff", ${ts('"observedAt"')} AS "observedAt",
  ${ts('"generatedAt"')} AS "generatedAt", ${ts('"coverageStart"')} AS "coverageStart", "rulesVersion", "revision", "supersedesId", "revisionReason",
  "generatedById", "generatedByName", "trigger", "payloadSha256", "sourceCompleteness", "endStateMaxEventId"::text AS "endStateMaxEventId",
  "knowledgeMaxEventId"::text AS "knowledgeMaxEventId", "idempotencyKey", "requestFingerprint"`;
export const TRANSACTION_TIMEOUT_MS = 60000;

export class WorkReportError extends Error {
  constructor(status, code, message, details) { super(message); this.name = 'WorkReportError'; this.status = status; this.code = code; if (details) this.details = details; }
}
const fail = (status, code, message, details) => new WorkReportError(status, code, message, details);
const keyConflict = () => fail(409, 'idempotency_conflict', '這個操作識別碼已用於其他內容（或其他操作者／動作）；既有報告未更動。');
const sha = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
export const generateFingerprint = (actorId, period) => sha(['work-report.generate.v1', actorId, period.kind, period.startDate, RULES_VERSION, 'manual']);
export const scheduledFingerprint = period => sha(['work-report.generate.scheduled.v1', period.kind, period.startDate, RULES_VERSION, 'scheduled']);
export const scheduledIdempotencyKey = period => `sched-${period.kind}-${period.startDate.replaceAll('-', '')}-${crypto.createHash('sha256').update(RULES_VERSION).digest('hex').slice(0, 12)}`;
const SCHEDULED_KEY_PREFIX = 'sched-';
const reservedKey = () => fail(400, 'reserved_idempotency_key', '識別碼不可使用系統排程保留的前綴。');
export const revisionFingerprint = (actorId, parent, input) => sha(['work-report.revision.v1', actorId, parent.id, parent.periodKind, parent.startDate,
  parent.rulesVersion, input.expectedLatestRevision, input.reason]);

// PostgreSQL SQLSTATE behind a Prisma error (raw queries report P2010 + meta.code).
export function pgCode(e) {
  if (e?.meta?.code && /^[0-9A-Z]{5}$/.test(e.meta.code)) return e.meta.code;
  if (e?.code === 'P2002') return '23505';
  if (e?.code === 'P2034') return '40001';
  const m = String(e?.message || '');
  if (/could not serialize access/.test(m)) return '40001';
  if (/deadlock detected/.test(m)) return '40P01';
  if (/duplicate key value/.test(m)) return '23505';
  return null;
}

export function serializeMeta(row) {
  if (!row) return null;
  const p = periodFromStart(row.periodKind, row.startDate);
  return { id: row.id, periodKind: row.periodKind, startDate: row.startDate, endDateExclusive: row.endDateExclusive, label: p.label,
    cutoffInstant: row.cutoffInstant, knowledgeCutoff: row.knowledgeCutoff, observedAt: row.observedAt, generatedAt: row.generatedAt,
    coverageStart: row.coverageStart ?? null, rulesVersion: row.rulesVersion, revision: row.revision, supersedesId: row.supersedesId ?? null,
    revisionReason: row.revisionReason ?? null, generatedById: row.generatedById ?? null, generatedByName: row.generatedByName ?? null,
    trigger: row.trigger, payloadSha256: row.payloadSha256, sourceCompleteness: row.sourceCompleteness,
    endStateMaxEventId: row.endStateMaxEventId ?? null, knowledgeMaxEventId: row.knowledgeMaxEventId ?? null };
}

// Production source reader: settle(K) then one new RR snapshot (writable: the snapshot INSERT happens in it).
// Deleted cases: a D event whose transaction was recorded in [S, C) — the period's own population (a case created and
// deleted only after C never had period activity). Deleted after C but present at C stays a row with a limitation.
export async function readReportSources(db, { cutoff, knowledgeCutoff, startInstant, timeout }, fn) {
  return withConsistentSources(db, { knowledgeCutoff, writable: true, timeout }, async (tx, read, info) => {
    const endState = await read(cutoff);
    const knowledge = endState.status !== 'ok' ? null : knowledgeCutoff === cutoff ? endState : await read(knowledgeCutoff);
    let deletedCaseIds = [];
    if (endState.status === 'ok') {
      const rows = await tx.$queryRawUnsafe(`
        WITH t AS (SELECT "transactionId", max("capturedAt") AS eff FROM "report_source_events" GROUP BY "transactionId")
        SELECT DISTINCT e."rowKey" AS id FROM "report_source_events" e JOIN t ON t."transactionId" = e."transactionId"
         WHERE e."tableName" = 'cases' AND e."op" = 'D' AND t.eff >= $1::timestamptz AND t.eff < $2::timestamptz`, startInstant, cutoff);
      deletedCaseIds = rows.map(r => r.id);
    }
    return fn(tx, { endState, knowledge, deletedCaseIds, coverageStart: endState.coverageStart ?? null, observedAt: info.observedAt, knowledgeCutoff: info.knowledgeCutoff });
  });
}

export function createWorkReportService({ db = prisma, readSources = readReportSources, timeout = TRANSACTION_TIMEOUT_MS } = {}) {
  const findByKey = async (q, key) => (await q.$queryRawUnsafe(`SELECT ${META} FROM "report_snapshots" WHERE "idempotencyKey" = $1`, key))[0] ?? null;
  const findById = async (q, id) => (await q.$queryRawUnsafe(`SELECT ${META} FROM "report_snapshots" WHERE "id" = $1`, id))[0] ?? null;
  const initialOf = async (q, kind, startDate, rulesVersion) => (await q.$queryRawUnsafe(`SELECT ${META} FROM "report_snapshots"
    WHERE "periodKind" = $1 AND "startDate" = $2::date AND "rulesVersion" = $3 AND "revision" = 1`, kind, startDate, rulesVersion))[0] ?? null;
  const jobSql = `SELECT j."id", j."status", j."leaseToken", j."epoch", j."periodKind", to_char(j."startDate", 'YYYY-MM-DD') AS "startDate", j."rulesVersion",
      j."idempotencyKey", (j."leaseUntil" > clock_timestamp()) AS "leaseLive", s."epoch" AS "stateEpoch", s."status" AS "stateStatus",
      (s."coverageStart" = c."coverageStart") AS "coverageSame"
    FROM "report_job_runs" j LEFT JOIN "report_scheduler_state" s ON s."id" = 1 LEFT JOIN "report_source_coverage" c ON c."id" = 1 WHERE j."id" = $1`;
  // The claimed job is the scheduled operator: still running under this lease, current epoch, coverage unchanged.
  function checkJob(row, leaseToken) {
    if (!row || row.status !== 'running' || row.leaseToken !== leaseToken || !row.leaseLive) throw fail(409, 'lease_lost', '排程工作的租約已失效或被其他程序接手；這次沒有保存。');
    if (row.stateStatus !== 'active' || row.stateEpoch !== row.epoch || row.coverageSame !== true) throw fail(409, 'scheduler_epoch_changed', '排程已暫停或來源版本起點已改變；需由維運重新初始化。');
    return row;
  }
  const latestOf = async (q, kind, startDate, rulesVersion) => (await q.$queryRawUnsafe(`SELECT ${META} FROM "report_snapshots"
    WHERE "periodKind" = $1 AND "startDate" = $2::date AND "rulesVersion" = $3 ORDER BY "revision" DESC LIMIT 1`, kind, startDate, rulesVersion))[0] ?? null;
  const replayOrConflict = (prior, fingerprint) => {
    if (prior.requestFingerprint !== fingerprint) throw keyConflict();
    return { status: 200, replayed: true, snapshot: serializeMeta(prior) };
  };
  function checkActor(row, user, auth) {
    if (!row || !row.active || row.pendingActivation) throw fail(403, 'actor_inactive', '帳號已停用或尚未啟用，無法產生報告。');
    if (auth?.sessionVersion == null || row.sessionVersion !== auth.sessionVersion) throw fail(401, 'session_expired', '登入狀態已失效，請重新登入。');
    if (row.role !== 'admin') throw fail(403, 'admin_only', '只有在職的管理員可以產生或修訂報告。');
    return { id: row.id, name: row.name };
  }
  const actorSql = `SELECT "id", "name", "role", "active", "pendingActivation", "sessionVersion" FROM "staff" WHERE "id" = $1`;
  const requireAdminNow = async (user, auth) => checkActor((await db.$queryRawUnsafe(actorSql, user?.id ?? -1))[0], user, auth);

  async function publish(ctx) {
    const { user, auth, job, period, cutoff, knowledgeCutoff, revision, parent, reason, key, fingerprint, onConflict } = ctx;
    const { startInstant } = periodInstants(period);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await readSources(db, { cutoff, knowledgeCutoff, startInstant, timeout }, async (tx, src) => {
          const actor = job ? (checkJob((await tx.$queryRawUnsafe(jobSql + ' FOR SHARE OF j', job.id))[0], job.leaseToken), null)
            : checkActor((await tx.$queryRawUnsafe(actorSql + ' FOR SHARE', user?.id ?? -1))[0], user, auth);
          const trigger = job ? 'scheduled' : 'manual';
          const prior = await findByKey(tx, key);
          if (prior) return replayOrConflict(prior, fingerprint);
          const latest = await latestOf(tx, period.kind, period.startDate, RULES_VERSION);
          if ((latest?.revision ?? 0) !== revision - 1 || (parent && latest.id !== parent.id)) throw ctx.staleError(latest);
          const payload = buildWorkReportPayload({ period, cutoff, knowledgeCutoff: src.knowledgeCutoff, observedAt: src.observedAt, coverageStart: src.coverageStart,
            revision, supersedesId: parent?.id ?? null, revisionReason: reason ?? null, generatedBy: actor ? { id: actor.id, name: actor.name } : null, trigger,
            endState: src.endState, knowledge: src.knowledge, deletedCaseIds: src.deletedCaseIds });
          const body = canonicalJson(payload);
          if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) throw fail(422, 'report_too_large', '報告內容超過上限，未保存任何版本；請改用較短期間。', { maxBytes: MAX_PAYLOAD_BYTES });
          const [row] = await tx.$queryRawUnsafe(`INSERT INTO "report_snapshots" ("id", "periodKind", "startDate", "endDateExclusive", "cutoffInstant",
              "knowledgeCutoff", "observedAt", "coverageStart", "rulesVersion", "revision", "supersedesId", "revisionReason", "generatedById", "generatedByName",
              "trigger", "idempotencyKey", "requestFingerprint", "payload", "payloadSha256", "sourceCompleteness", "endStateMaxEventId", "knowledgeMaxEventId")
            VALUES ($1, $2, $3::date, $4::date, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12, $13, $14, $15, $16, $17,
              $18::jsonb, $19, $20, $21::bigint, $22::bigint) RETURNING ${META}`,
          'wr_' + crypto.randomUUID(), period.kind, period.startDate, period.endDateExclusive, cutoff, src.knowledgeCutoff, src.observedAt, src.coverageStart,
          RULES_VERSION, revision, parent?.id ?? null, reason ?? null, actor?.id ?? null, actor?.name ?? null, trigger, key, fingerprint, body, payloadSha256(payload),
          payload.sourceCompleteness.status, payload.meta.sources.endStateMaxEventId, payload.meta.sources.knowledgeMaxEventId);
          return { status: 201, replayed: false, snapshot: serializeMeta(row) };
        });
      } catch (e) {
        if (e instanceof WorkReportError) throw e;
        if (e instanceof ReportSourceError) throw fail(e.status, e.code, e.message, e.details);
        if (e?.code === 'P2028') throw fail(503, 'report_timeout', '產生報告逾時，未保存任何版本；請稍後再試。');
        const code = pgCode(e);
        if (code === '23505' || code === '40001' || code === '40P01') {
          const resolved = await onConflict();
          if (resolved) return resolved;
          if (code !== '23505' && attempt === 0) continue;   // fresh snapshot: a concurrent revocation is then seen as such
          throw fail(409, 'report_conflict', '報告同時被其他操作更新，這次沒有保存；請重新整理後再試。');
        }
        if (code === '23514') throw fail(409, 'report_rejected', '資料庫拒絕這個報告版本（版本鏈或時間不一致），未保存。');
        throw e;
      }
    }
    throw fail(409, 'report_conflict', '報告同時被其他操作更新，這次沒有保存；請重新整理後再試。');
  }

  return {
    async generate(user, auth, input) {
      const period = periodFromStart(input.periodKind, input.startDate);
      const { cutoffInstant: cutoff } = periodInstants(period);
      await requireAdminNow(user, auth);
      if (String(input.idempotencyKey).startsWith(SCHEDULED_KEY_PREFIX)) throw reservedKey();
      const fingerprint = generateFingerprint(user.id, period);
      const prior = await findByKey(db, input.idempotencyKey);
      if (prior) return replayOrConflict(prior, fingerprint);
      const [clock] = await db.$queryRawUnsafe('SELECT clock_timestamp() >= $1::timestamptz AS "ended"', cutoff);
      if (!clock.ended) throw fail(422, 'period_not_ended', '期間尚未結束，不能產生報告。', { cutoffInstant: cutoff });
      const exists = latest => fail(409, 'report_exists', '此期間已有初版報告；如需更新請建立修訂版本。', latest ? { snapshotId: latest.id, latestRevision: latest.revision } : undefined);
      const current = await latestOf(db, period.kind, period.startDate, RULES_VERSION);
      if (current) throw exists(current);
      return publish({ user, auth, period, cutoff, knowledgeCutoff: cutoff, revision: 1, parent: null, reason: null, key: input.idempotencyKey, fingerprint,
        staleError: exists,
        onConflict: async () => {
          const again = await findByKey(db, input.idempotencyKey);
          if (again) return replayOrConflict(again, fingerprint);
          const latest = await latestOf(db, period.kind, period.startDate, RULES_VERSION);
          if (latest) throw exists(latest);
          return null;
        } });
    },

    async revise(user, auth, targetId, input) {
      await requireAdminNow(user, auth);
      if (String(input.idempotencyKey).startsWith(SCHEDULED_KEY_PREFIX)) throw reservedKey();
      const target = await findById(db, targetId);
      if (!target) throw fail(404, 'not_found', '找不到報告版本。');
      const fingerprint = revisionFingerprint(user.id, target, input);
      const prior = await findByKey(db, input.idempotencyKey);
      if (prior) return replayOrConflict(prior, fingerprint);
      if (target.rulesVersion !== RULES_VERSION) throw fail(409, 'rules_version_mismatch', '此版本採用不同的規則版本，不能在目前規則下修訂。');
      const stale = latest => fail(409, latest && latest.id !== target.id ? 'not_latest_revision' : 'revision_conflict',
        '只能對此期間最新的版本續修訂；請重新載入後再操作。', latest ? { latestRevision: latest.revision, latestId: latest.id } : undefined);
      const latest = await latestOf(db, target.periodKind, target.startDate, target.rulesVersion);
      if (!latest) throw fail(404, 'not_found', '找不到報告版本（可能已由全站重置清除）。');   // purged between the two reads
      if (latest.id !== target.id) throw stale(latest);
      if (input.expectedLatestRevision !== latest.revision) throw fail(409, 'revision_conflict', '最新版本已不是你看到的版本；請重新載入後再操作。', { latestRevision: latest.revision, latestId: latest.id });
      const period = periodFromStart(target.periodKind, target.startDate);
      const knowledgeCutoff = await fixKnowledgeCutoff(db);
      return publish({ user, auth, period, cutoff: target.cutoffInstant, knowledgeCutoff, revision: target.revision + 1, parent: target, reason: input.reason,
        key: input.idempotencyKey, fingerprint, staleError: stale,
        onConflict: async () => {
          const again = await findByKey(db, input.idempotencyKey);
          if (again) return replayOrConflict(again, fingerprint);
          const now = await latestOf(db, target.periodKind, target.startDate, target.rulesVersion);
          if (now && now.id !== target.id) throw stale(now);
          return null;
        } });
    },

    // REPORTS-P3-E3: internal scheduler entry (see header). Returns { outcome: 'succeeded' | 'skipped_existing', replayed, snapshot }.
    async generateScheduled({ jobId, leaseToken }) {
      const job = checkJob((await db.$queryRawUnsafe(jobSql, jobId))[0], leaseToken);
      if (job.rulesVersion !== RULES_VERSION) throw fail(409, 'rules_version_changed', '排程工作的規則版本與目前規則不同。');
      const period = periodFromStart(job.periodKind, job.startDate);
      const { cutoffInstant: cutoff } = periodInstants(period);
      const key = scheduledIdempotencyKey(period), fingerprint = scheduledFingerprint(period);
      if (job.idempotencyKey !== key) throw keyConflict();
      const replay = prior => { if (prior.requestFingerprint !== fingerprint) throw keyConflict(); return { outcome: 'succeeded', replayed: true, snapshot: serializeMeta(prior) }; };
      const skipped = async () => {
        const initial = await initialOf(db, period.kind, period.startDate, RULES_VERSION);
        if (!initial) throw fail(409, 'report_conflict', '報告同時被其他操作更新，這次沒有保存。');
        return { outcome: 'skipped_existing', replayed: false, snapshot: serializeMeta(initial) };
      };
      const prior = await findByKey(db, key);
      if (prior) return replay(prior);
      const [clock] = await db.$queryRawUnsafe('SELECT clock_timestamp() >= $1::timestamptz AS "ended"', cutoff);
      if (!clock.ended) throw fail(422, 'period_not_ended', '期間尚未結束，不能產生報告。', { cutoffInstant: cutoff });
      if (await latestOf(db, period.kind, period.startDate, RULES_VERSION)) return skipped();
      const exists = () => fail(409, 'report_exists', '此期間已有初版報告。');
      try {
        const r = await publish({ job: { id: jobId, leaseToken }, period, cutoff, knowledgeCutoff: cutoff, revision: 1, parent: null, reason: null, key, fingerprint,
          staleError: exists,
          onConflict: async () => {
            const again = await findByKey(db, key);
            if (again) return replay(again);
            if (await latestOf(db, period.kind, period.startDate, RULES_VERSION)) throw exists();
            return null;
          } });
        return r.outcome ? r : { outcome: 'succeeded', replayed: r.replayed, snapshot: r.snapshot };
      } catch (e) {
        if (e instanceof WorkReportError && e.code === 'report_exists') return skipped();   // a manual (or other) version won the race: never overwritten
        throw e;
      }
    },

    // Read-only: periods (≤ 60) with the meta of existing versions.
    // REPORTS-P3-E3a: plus the current source coverage start (the same clock read, SELECT only; no snapshot, no write) so the
    // UI can say before generating whether a period's report could only be insufficient (C < coverage), partial
    // (S < coverage ≤ C) or covered in time (coverage ≤ S). Additive: existing fields are unchanged; null = no coverage row.
    async periods(kind, from, to) {
      const list = listPeriods(kind, from, to);
      const [clock] = await db.$queryRawUnsafe(`SELECT ${ts('clock_timestamp()')} AS "now",
        (SELECT ${ts('"coverageStart"')} FROM "report_source_coverage" WHERE "id" = 1) AS "coverageStart"`);
      const rows = await db.$queryRawUnsafe(`SELECT ${META} FROM "report_snapshots" WHERE "periodKind" = $1 AND "startDate" = ANY($2::text[]::date[])
        ORDER BY "startDate", "rulesVersion", "revision"`, kind, list.map(p => p.startDate));
      return { kind, rulesVersion: RULES_VERSION, coverage: { coverageStart: clock.coverageStart ?? null, observedAt: clock.now }, periods: list.map(p => {
        const { startInstant, cutoffInstant } = periodInstants(p);
        return { ...p, startInstant, cutoffInstant, ended: cutoffInstant <= clock.now, versions: rows.filter(r => r.startDate === p.startDate).map(serializeMeta) };
      }) };
    },
    async versions(kind, startDate) {
      const p = periodFromStart(kind, startDate);
      const rows = await db.$queryRawUnsafe(`SELECT ${META} FROM "report_snapshots" WHERE "periodKind" = $1 AND "startDate" = $2::date ORDER BY "rulesVersion", "revision"`, p.kind, p.startDate);
      return { period: { ...p, ...periodInstants(p) }, versions: rows.map(serializeMeta) };
    },
    // One stored version; a filter produces a view computed only from the stored payload (never live tables).
    async get(id, { hotel, staffId } = {}) {
      const [row] = await db.$queryRawUnsafe(`SELECT ${META}, "payload" FROM "report_snapshots" WHERE "id" = $1`, id);
      if (!row) throw fail(404, 'not_found', '找不到報告版本。');
      if (payloadSha256(row.payload) !== row.payloadSha256) throw fail(500, 'snapshot_integrity_failed', '報告內容與保存的雜湊不一致。');
      const snapshot = serializeMeta(row);
      if (hotel == null && staffId == null) return { snapshot, payloadSha256: row.payloadSha256, payload: row.payload };
      const view = filterPayload(row.payload, { hotel, staffId });
      return { snapshot, payloadSha256: row.payloadSha256,
        view: { filter: view.filter, derivedFrom: { snapshotId: row.id, payloadSha256: row.payloadSha256 }, viewSha256: payloadSha256(view), payload: view,
          note: 'view = stored payload filtered and re-summarised; viewSha256 hashes this view, payloadSha256 is the stored original' } };
    },
  };
}

export const workReports = createWorkReportService();
