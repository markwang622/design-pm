// REPORTS-P3-E1a: consistent reconstruction of report sources from "report_source_events" (migration 0008).
//
// Time contract (not commit time):
// - every event carries capturedAt = DB clock_timestamp() when its AFTER ROW trigger ran (source row lock held) and
//   the full 64-bit id of its writing transaction;
// - a transaction's effectiveRecordedAt = MAX(capturedAt) over ALL of its visible events ("when the transaction's last
//   report-source change was recorded"). It is grouped over every visible event first; only then are whole
//   transactions selected with effectiveRecordedAt < cutoff (half-open), so a transaction that straddles a cutoff
//   falls entirely on the later side;
// - selected events are replayed in event-id order. The id is allocated after the source row lock (sequence CACHE 1,
//   NO CYCLE, never caller-supplied), so for each row it is the actual order of its changes.
//
// Knowledge cutoff K: fixed from the DB clock, then settle(K) proves no other transaction that could still record an
// event before K is open, and only after that a NEW repeatable-read snapshot is taken. Cutoffs are passed to SQL as
// microsecond ISO strings and compared as timestamptz — never truncated through a JS Date.
//
// Preconditions (fail closed when they cannot be checked): one application DB role able to see its own sessions in
// pg_stat_activity, no two-phase commit, and a DB wall clock that does not run backwards. clock_timestamp() is NOT
// guaranteed monotonic; obviously inconsistent clock readings are refused, but a backwards step cannot be fully proven
// away here — production enablement must state this and be able to stop generation.
import { normalizeInstant } from './reportPeriods.js';

export const SOURCE_TABLES = Object.freeze(['cases', '_collaborators', 'case_deliveries', 'case_cycles', 'case_lifecycle_requests',
  'case_schedule_requests', 'case_delivery_submissions', 'staff', 'hotels', 'change_logs']);
const ISO_US = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

export class ReportSourceError extends Error {
  constructor(code, message, details) { super(message); this.name = 'ReportSourceError'; this.code = code; this.status = 409; if (details) this.details = details; }
}

// K: the DB clock now, microsecond ISO (UTC).
export async function fixKnowledgeCutoff(db) {
  const [row] = await db.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', '${ISO_US}') AS k`);
  return row.k;
}

// One fresh observation of the transactions that could still record events before K.
export async function settleCheck(db, knowledgeCutoff) {
  const k = normalizeInstant(knowledgeCutoff);
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SELECT pg_stat_clear_snapshot()');   // never reuse a cached statistics snapshot
    const [r] = await tx.$queryRaw`
      SELECT clock_timestamp() >= ${k}::timestamptz AS "reached",
        (SELECT count(*)::int FROM pg_prepared_xacts p WHERE p.database = current_database()) AS "prepared",
        (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
           AND a.backend_type = 'client backend' AND a.state IS NULL AND a.xact_start IS NULL) AS "hidden",
        (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
           AND a.backend_type = 'client backend' AND a.xact_start < ${k}::timestamptz) AS "open"`;
    const reason = !r.reached ? 'cutoff_in_future' : r.prepared ? 'prepared_transactions' : r.hidden ? 'activity_not_visible' : r.open ? 'open_transactions' : null;
    return { settled: !reason, reason, open: r.open, hidden: r.hidden, prepared: r.prepared };
  });
}

// Bounded wait for settle(K). Any other transaction of this database that began before K (active or idle in
// transaction) blocks; so do invisible sessions and prepared transactions. Returns or throws source_not_settled.
export async function settle(db, knowledgeCutoff, { attempts = 10, delayMs = 200, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    last = await settleCheck(db, knowledgeCutoff);
    if (last.settled) return last;
    if (last.reason !== 'open_transactions' || i === attempts - 1) break;   // only open transactions can resolve by waiting
    await sleep(delayMs);
  }
  throw new ReportSourceError('source_not_settled', '仍有在截止時間前開始、尚未結束的資料異動，暫不能產生；請稍後再試。', { reason: last.reason, open: last.open });
}

// Replay whole transactions with effectiveRecordedAt < cutoff, inside the caller's repeatable-read transaction.
export async function reconstructAt(tx, cutoff, { tables = SOURCE_TABLES } = {}) {
  const c = normalizeInstant(cutoff);
  const [cov] = await tx.$queryRawUnsafe(`SELECT to_char("coverageStart" AT TIME ZONE 'UTC', '${ISO_US}') AS "coverageStart",
    "baselineEventMaxId"::text AS "baselineEventMaxId", ("coverageStart" <= $1::timestamptz) AS "covered" FROM "report_source_coverage" WHERE "id" = 1`, c);
  if (!cov) throw new ReportSourceError('source_coverage_missing', '報表來源版本尚未建立（缺少 coverage）。');
  if (!cov.covered) return { status: 'insufficient', cutoff: c, coverageStart: cov.coverageStart, tables: null };
  const rows = await tx.$queryRawUnsafe(`
    WITH t AS (SELECT "transactionId", max("capturedAt") AS eff FROM "report_source_events" GROUP BY "transactionId")
    SELECT e."id"::text AS id, e."tableName", e."rowKey", e."op", e."data", e."transactionId"::text AS "transactionId"
      FROM "report_source_events" e JOIN t ON t."transactionId" = e."transactionId"
     WHERE t.eff < $1::timestamptz
     ORDER BY e."id"`, c);
  const want = new Set(tables), state = Object.fromEntries(tables.map(t => [t, new Map()]));
  const transactions = new Set(); let maxEventId = null;
  for (const e of rows) {
    transactions.add(e.transactionId); maxEventId = e.id;
    if (!want.has(e.tableName)) continue;   // filtered only after whole transactions were selected
    const rowsOf = state[e.tableName], cur = rowsOf.get(e.rowKey);
    if (e.op === 'B' || e.op === 'I') rowsOf.set(e.rowKey, { ...e.data });
    else if (e.op === 'U') {
      if (!cur) throw new ReportSourceError('source_incomplete', '來源版本缺少基準列，無法重建。', { table: e.tableName, rowKey: e.rowKey, eventId: e.id });
      rowsOf.set(e.rowKey, { ...cur, ...e.data });   // explicit JSON null overwrites
    } else if (e.op === 'D') {
      if (!cur) throw new ReportSourceError('source_incomplete', '來源版本刪除了不存在的列，無法重建。', { table: e.tableName, rowKey: e.rowKey, eventId: e.id });
      rowsOf.delete(e.rowKey);
    }
  }
  return { status: 'ok', cutoff: c, coverageStart: cov.coverageStart, maxEventId, transactions: transactions.size,
    tables: Object.fromEntries(Object.entries(state).map(([t, m]) => [t, Object.fromEntries(m)])) };
}

// Fixed K → settle(K) → a NEW repeatable-read snapshot in which every requested cutoff (each ≤ K) is reconstructed.
// `fn(tx, read)` may run more reads in the same snapshot; read(cutoff) reconstructs. Read-only unless writable.
export async function withConsistentSources(db, { knowledgeCutoff, settleOptions, writable = false, timeout = 60000 } = {}, fn) {
  const k = normalizeInstant(knowledgeCutoff ?? await fixKnowledgeCutoff(db));
  await settle(db, k, settleOptions);
  return db.$transaction(async tx => {
    if (!writable) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const [clock] = await tx.$queryRawUnsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', '${ISO_US}') AS "observedAt",
      (SELECT max("capturedAt") FROM "report_source_events") > clock_timestamp() AS "futureEvents",
      (SELECT "coverageStart" FROM "report_source_coverage" WHERE "id" = 1) > clock_timestamp() AS "futureCoverage",
      $1::timestamptz > clock_timestamp() AS "futureCutoff"`, k);
    if (clock.futureEvents || clock.futureCoverage) throw new ReportSourceError('source_clock_unreliable', '資料庫時鐘與已記錄的來源時間不一致，停止產生。');
    if (clock.futureCutoff) throw new ReportSourceError('source_not_settled', '知識截止時間晚於資料庫目前時間。', { reason: 'cutoff_in_future' });
    const read = (cutoff, opts) => {
      const c = normalizeInstant(cutoff);
      if (c > k) throw new ReportSourceError('cutoff_after_knowledge', '期間截止不可晚於知識截止時間。');
      return reconstructAt(tx, c, opts);
    };
    return fn(tx, read, { knowledgeCutoff: k, observedAt: clock.observedAt });
  }, { isolationLevel: 'RepeatableRead', timeout });
}
