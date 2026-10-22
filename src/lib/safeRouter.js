// ─────────────────────────────────────────────────────────────
// safeRouter — Express 4 的 async 錯誤收斂（v9.6）
//
// 問題：Express 4 不會把 async handler 的 rejection 交給 error middleware，
// 未捕捉的 rejection 在 Node ≥15 會讓整個程序退出。
//
// 做法：回傳一個 Router，其 get/post/patch/put/delete/all/use 會把「一般
// handler（參數 ≤3 的函式）」包成 Promise.resolve(fn(...)).catch(next)。
//   · error middleware 保留 4 參數，並收斂本身的 async rejection
//   · 遞迴處理 handler 陣列；巢狀 router 仍沿用 Express 的掛載語意
//   · 一般函式若回傳 promise 也會被 catch；同步 throw 由 Express 自行處理
// 不做全域 monkey patch、不靠 process.on('unhandledRejection') 吞錯。
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';

export function asyncHandler(fn) {
  if (Array.isArray(fn)) return fn.map(asyncHandler);
  if (typeof fn !== 'function') return fn;
  let wrapped;
  if (fn.length >= 4) {
    // error middleware：必須維持 4 個參數，Express 才會把它當 error handler；
    // 但 async error middleware 自己 reject 時同樣要交給下一個 next。
    wrapped = function (err, req, res, next) {
      try {
        const r = fn.call(this, err, req, res, next);
        if (r && typeof r.then === 'function') r.then(undefined, next);
        return r;
      } catch (e) { next(e); }
    };
  } else {
    wrapped = function (req, res, next) {
      try {
        const r = fn.call(this, req, res, next);
        if (r && typeof r.then === 'function') r.then(undefined, next);
        return r;
      } catch (e) { next(e); }
    };
  }
  Object.defineProperty(wrapped, 'name', { value: fn.name || 'asyncHandler' });
  return wrapped;
}

// 遞迴展開任意深度的 handler 陣列（Express 允許 [a,[b,[c]]]）
function wrapDeep(a) {
  return Array.isArray(a) ? a.map(wrapDeep) : asyncHandler(a);
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use'];

export function safeRouter(opts) {
  const router = Router(opts);
  for (const m of METHODS) {
    const orig = router[m];
    router[m] = function (...args) {
      // 第一個參數可能是 path（字串/regex/陣列）；其餘展平後逐一包裝
      const out = args.map(wrapDeep);
      return orig.apply(this, out);
    };
  }
  return router;
}

// 數字資源的 :id 統一驗證：正整數且 safe integer，不合法回 400、不碰 DB。
// 用法：router.param('id', intIdParam)
export function intIdParam(req, res, next, val) {
  if (!/^[0-9]{1,15}$/.test(String(val))) return res.status(400).json({ error: 'invalid_id', message: 'id 必須為正整數' });
  const n = Number(val);
  if (!Number.isSafeInteger(n) || n <= 0) return res.status(400).json({ error: 'invalid_id', message: 'id 必須為正整數' });
  next();
}

export default safeRouter;
