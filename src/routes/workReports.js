// REPORTS-P3-E1b: manager work-report API (isolated under /api/work-reports). Every endpoint: requireAuth (real session)
// + admin. Publication re-checks the operator inside its own transaction (src/lib/workReports.js). GETs never write.
// Inputs are normalised and bounded; unknown keys (e.g. a forged role or actor) are rejected, never trusted.
// REPORTS-P3-E3: GET /scheduler/status is read-only (same admin guard). There is no route that runs or publishes a
// scheduled report; keys with the reserved 'sched-' prefix are refused.
// REPORTS-P4-E4: GET /history is the read-only work history review from current retained data (src/lib/workHistory.js):
// same admin guard, strict query, no snapshot/version/write; never a formal report.
import { z } from 'zod';
import { safeRouter } from '../lib/safeRouter.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { PERIOD_KINDS, PeriodError } from '../lib/reportPeriods.js';
import { reasonProblem } from '../lib/scheduleWorkflow.js';
import { workReports, WorkReportError } from '../lib/workReports.js';
import { workHistory } from '../lib/workHistory.js';
import { validateWorkReportScheduler } from '../lib/runtimeConfig.js';
import { readSchedulerStatus } from '../services/workReportScheduler.js';
import { prisma } from '../lib/db.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const SNAPSHOT_ID = /^wr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const kind = z.enum(PERIOD_KINDS);
const day = z.string().regex(DATE, '日期格式須為 YYYY-MM-DD');
const key = z.string().regex(KEY, '識別碼須為 8–100 個英數字、- 或 _').refine(v => !v.startsWith('sched-'), '識別碼不可使用系統排程保留的前綴');
const reason = z.string().max(2000).superRefine((v, ctx) => { const p = reasonProblem(v); if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p }); }).transform(v => v.trim());

const generateBody = z.object({ periodKind: kind, startDate: day, idempotencyKey: key }).strict();
const revisionBody = z.object({ reason, expectedLatestRevision: z.number().int().min(1).max(100000), idempotencyKey: key }).strict();
const periodsQuery = z.object({ kind, from: day, to: day }).strict();
const versionsQuery = z.object({ kind, start: day }).strict();
const historyQuery = z.object({ kind, start: day }).strict();
const viewQuery = z.object({ hotel: z.string().min(1).max(300).optional(), staffId: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).optional() }).strict();

export function createWorkReportsRouter(service = workReports, { schedulerStatus = () => readSchedulerStatus(prisma, validateWorkReportScheduler(process.env)), history = workHistory } = {}) {
  const router = safeRouter();
  router.use(requireAuth, requireAdmin);
  const parse = (schema, value, res, error) => {
    const r = schema.safeParse(value ?? {});
    if (!r.success) { res.status(400).json({ error, message: r.error.issues[0]?.message || '輸入格式不正確', issues: r.error.issues }); return null; }
    return r.data;
  };
  const send = (res, e) => {
    if (e instanceof WorkReportError) return res.status(e.status).json({ error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
    if (e instanceof PeriodError) return res.status(400).json({ error: 'invalid_period', code: e.code, message: e.message });
    throw e;
  };
  const run = async (res, fn) => { try { return await fn(); } catch (e) { return send(res, e); } };

  router.get('/scheduler/status', (req, res) => run(res, async () => {
    if (Object.keys(req.query || {}).length) return res.status(400).json({ error: 'invalid_query', message: '此查詢不接受參數' });
    res.json(await schedulerStatus());
  }));
  router.get('/periods', (req, res) => run(res, async () => {
    const q = parse(periodsQuery, req.query, res, 'invalid_query'); if (!q) return;
    res.json(await service.periods(q.kind, q.from, q.to));
  }));
  // Declared before '/:id' so 'history' is never read as a snapshot id.
  router.get('/history', (req, res) => run(res, async () => {
    const q = parse(historyQuery, req.query, res, 'invalid_query'); if (!q) return;
    const payload = await history.read(q.kind, q.start);
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  }));
  router.get('/', (req, res) => run(res, async () => {
    const q = parse(versionsQuery, req.query, res, 'invalid_query'); if (!q) return;
    res.json(await service.versions(q.kind, q.start));
  }));
  router.get('/:id', (req, res) => run(res, async () => {
    if (!SNAPSHOT_ID.test(req.params.id)) return res.status(404).json({ error: 'not_found', message: '找不到報告版本。' });
    const q = parse(viewQuery, req.query, res, 'invalid_query'); if (!q) return;
    res.json(await service.get(req.params.id, q));
  }));
  router.post('/generate', (req, res) => run(res, async () => {
    const body = parse(generateBody, req.body, res, 'invalid_body'); if (!body) return;
    const r = await service.generate(req.user, req.authSession, body);
    res.status(r.status).json({ snapshot: r.snapshot, replayed: r.replayed });
  }));
  router.post('/:id/revisions', (req, res) => run(res, async () => {
    if (!SNAPSHOT_ID.test(req.params.id)) return res.status(404).json({ error: 'not_found', message: '找不到報告版本。' });
    const body = parse(revisionBody, req.body, res, 'invalid_body'); if (!body) return;
    const r = await service.revise(req.user, req.authSession, req.params.id, body);
    res.status(r.status).json({ snapshot: r.snapshot, replayed: r.replayed });
  }));
  return router;
}

export default createWorkReportsRouter();
