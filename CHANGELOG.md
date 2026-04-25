# Changelog

## v3.3 (2026-04-25) · 變更追蹤 + 貢獻指標

### 新增

- **案件刪除** — `DELETE /api/cases/:id`
  - admin：可刪除任何案件（不論狀態）
  - 案件建立者：僅當狀態為 `todo` 時可刪除自己建立的案
  - 自動級聯刪除 ChangeLog / TransferLog；Notification 的 `relatedCaseId` 改為 NULL
- **變更追蹤（ChangeLog）** — 新 model `ChangeLog`
  - 追蹤欄位：`goLiveDate` / `dispatchDate` / `copyDate` / `designerId` / `status` / `level` / `urgent`
  - 任一追蹤欄位變更時，PATCH 請求**必填 `reason`**（否則 422 `reason_required`）
  - 每筆變更記錄 `field / fromValue / toValue / reason / operator / createdAt`
  - 案件抽屜底部新增「變更記錄」時間軸；GET `/api/cases/:id/changelog` 可單獨取
- **貢獻指標分析** — 新路由 `GET /api/analytics`（admin only）
  - 期間切片（自然週／月／半年／年）：`?period=week|month|half|year&offset=0`
  - 公式（全加權）：`LEVEL_WEIGHT × ROLE × TIMELY × URGENT`
    - LEVEL：SS=5 · S=4 · A=3 · B=2 · C=1 · D=1
    - ROLE：主負責 1.0 / 協作 0.4
    - TIMELY：準時 ×1.1 / 逾期 ×0.8（以 closedOn ≤ goLiveDate 判定）
    - URGENT：急件 ×1.3 / 一般 ×1.0
  - 僅計入 `status=done` 且 `closedOn` 落在期間內的案件
  - 回傳：部門總數 / 總分 / 準時率 / SS+S 件數；每位設計師的主／協作分數、準時率、急件數、各分級件數
- **前端：管理員「貢獻分析」分頁**
  - 期間按鈕（週／月／半年／年）+ 上一期／下一期切換
  - 部門 KPI、設計師排行（含進度條）、本期間完成案列表（標示準時／逾期、急件、結案日）
- **前端：案件抽屜新增「調整時程／任務」面板** — 一次調整派發日／文案日／上線日／分級／主負責人；變更時統一彈出原因輸入框
- **建立者追蹤** — Case schema 新增 `createdById`，POST 建案時自動填入當前使用者；`createdBy` 隨 GET 回傳

### 變更

- **schema 部署改用 `prisma db push`** — 因為原 v3.2 缺乏 migration 檔案，改用 `db push --skip-generate --accept-data-loss` 直接同步 schema（小型部門應用適用，零停機）
- **POST /api/cases** 自動寫 `createdById = req.user.id`
- **PATCH /api/cases/:id** body 新增可選 `reason` 欄位

### 技術細節

- `src/services/changelog.js` — `detectChanges()` + `writeChangeLog()`
- `src/services/analytics.js` — 期間 bucket（UTC 自然週 ISO Mon–Sun）+ rollup
- `prisma/schema.prisma` — 新增 ChangeLog model + Case.createdById + Staff.createdCases relation

## v3.2 (2026-04-24) · Zeabur 全端封包

### 新增

- **Postgres 持久化** — Prisma schema 四個 model（Staff / Case / TransferLog / Notification），自動 migration
- **JWT Cookie Auth** — Email + 密碼登入，`httpOnly` + `sameSite: lax` cookie，7d TTL；`/login` 登入頁、`/change-password` 改密、登出
- **REST API 覆蓋全功能** — `/api/auth`、`/api/cases`、`/api/staff`（含 departure 流程）、`/api/notifications`；全部有 Zod 請求驗證
- **Admin vs Member 權限** — admin 可建案、轉派、管理人員；member 只能改自己擁有或協作的案
- **業務規則在 API 層強制** — 結案必須填 `archivePath`（否則 422）；TransferLog 自動寫入；離職走單筆 transaction
- **Zeabur 一鍵部署** — `zbpack.json` 直接相容；`${POSTGRES.POSTGRES_CONNECTION_STRING}` 引用 DB
- **Docker Compose** 本機環境含 Postgres + app
- **Seed idempotent** — 第一次部署自動建 9 位同仁 + 16 筆示範案，之後再部署不會覆寫

### 技術棧

- Node 20 · Express 4.21 · Prisma 5.22 · PostgreSQL 16
- bcryptjs · jsonwebtoken · zod · helmet · cors · morgan · express-rate-limit

### 文件

- `docs/zeabur-deploy.md` — 10 步驟 Zeabur 部署（含 SMTP 升級路徑、備份、回滾）
- `docs/local-dev.md` — Docker Compose 及純 Node 本機開發
- `docs/api.md` — 完整 REST 端點參考（含錯誤碼、欄位對照）
- `README.md` — 概覽、環境變數、初始帳號表

### 限制 / 待辦

- **通知只寫入 DB**，未實際寄 Email。文件中提供 nodemailer 升級片段。
- **檔案上傳** 尚未支援，`archivePath` 仍是手打字串。之後可接 S3 / Zeabur Storage。
- **子案 items 與進度日誌 logs** 用 Prisma Json 欄位儲存，結構鬆散；目前前端對它們的寫入仍保留在 client-side optimistic state，未走 API PATCH（下一版會把 `PATCH /api/cases/:id` 擴充為支援這兩個 field）。

## v3.1 (2026-04) · 靜態 + IIS / Docker

（前版，獨立 zip：`design-pm-deploy-v3.2.zip`）

## v3.0 (2026-04) · 原型

- 2000+ 行單一 HTML artifact
- 6 檢視：個人 / 看板 / 甘特 / Admin Dashboard / 人員 / 通知
- ~30 筆假資料
