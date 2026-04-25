# 藝術設計部 · 專案管理系統 (Design-PM) — Zeabur 全端封包 v3.4

> 前端（SPA） + 後端（Express + Prisma） + Postgres，單一服務部署於 [Zeabur](https://zeabur.com)。

## 功能概覽

| 模組 | 內容 |
| --- | --- |
| **個人 Dashboard** | 本週 / 逾期 / 急件 / 確稿卡控 KPI；卡牌列表 |
| **看板 (Kanban)** | 5 個狀態欄（尚未開始 → 已完成），拖拉式設計預留 |
| **甘特圖** | 週 / 月兩種尺度，專案 + 子案展開，4 條關鍵日期標示 |
| **Admin Dashboard** | 部門工作量熱度、確稿卡控名單、逾期警報、急件 |
| **人員管理** | 新增同仁、離職流程（自動算繼承人 + 單筆 transaction 完成移轉 / 封存 / 解除協作）|
| **通知（DB）** | 新案派發、協作邀請、結案、離職公告……寫入 `notifications` 表，介接 SMTP 後可直寄 Email |
| **權限** | Admin 可建案、轉派、管理人員；Member 僅能更新自己的案 |
| **案件刪除（v3.3）** | admin 可刪任何案、建立者可刪自己 todo 狀態的案 |
| **變更追蹤（v3.3）** | 時程／分級／負責人／狀態／急件變更必填原因，全部寫入 ChangeLog 時間軸 |
| **貢獻分析（v3.3）** | 週／月／半年／年切片，全加權公式（級別×角色×準時×急件）算每位設計師貢獻指標 |
| **批次匯入（v3.4）** | admin 上傳 CSV → 預覽 → 一鍵建立大量案件 |
| **個人檔案編輯（v3.4）** | 全員可改自己（姓名/Email/職稱/密碼）；admin 可改任何人 + 重設他人密碼 |

## 技術棧

- **前端**：單一 HTML（2000+ 行 vanilla JS），原型 v3.2
- **後端**：Node 20 · Express 4 · Prisma 5 · Zod · JWT (httpOnly cookie) · bcrypt
- **DB**：PostgreSQL 16
- **部署**：Zeabur（zbpack.json 自動辨識）或 Docker Compose（本機）

## 快速上手（本機）

```bash
# 1. 啟動 DB + app
docker compose up --build

# 2. 登入
open http://localhost:3000/login
# Email:    mark@company.com
# Password: design2026!
```

## 部署至 Zeabur

詳見 [`docs/zeabur-deploy.md`](docs/zeabur-deploy.md) — 10 步驟含截圖指引。摘要：

1. 在 Zeabur 專案中 **Add Service → PostgreSQL**。
2. **Add Service → Git / ZIP**，指向本專案。
3. 設定環境變數：
   - `DATABASE_URL` = `${POSTGRES.POSTGRES_CONNECTION_STRING}`
   - `JWT_SECRET` = 用 `openssl rand -base64 48` 產生的隨機字串
4. Deploy。啟動指令由 `zbpack.json` 自動執行 `prisma db push → seed → node src/index.js`（首次啟動會自動建立 Postgres 表）。

## 目錄結構

```
design-pm-zeabur/
├── prisma/
│   ├── schema.prisma         # Staff / Case / TransferLog / Notification 四個 model
│   └── seed.js               # 9 筆人員 + 16 筆示範案件（idempotent）
├── src/
│   ├── index.js              # Express 入口：helmet + cors + cookie + 靜態 + SPA fallback
│   ├── lib/
│   │   ├── db.js             # 共用 PrismaClient instance
│   │   └── ids.js            # nextCaseId(level, date) → e.g. SS-2026-04-001
│   ├── middleware/
│   │   └── auth.js           # signToken / setAuthCookie / requireAuth / requireAdmin
│   ├── services/
│   │   ├── workload.js       # workloadScore / workloadForAll / suggestSuccessor
│   │   └── notify.js         # DB-only 通知（要改寄 Email 時把 deliver() swap 為 SMTP 即可）
│   └── routes/
│       ├── auth.js           # POST /login · /logout · GET /me · POST /change-password
│       ├── cases.js          # GET/POST/PATCH /api/cases + /archive + /transfer
│       ├── staff.js          # GET/POST/PATCH /api/staff + /departure-preview + /departure
│       └── notifications.js  # GET / · POST /:id/read · POST /read-all
├── public/
│   ├── index.html            # 單頁 SPA（前端）
│   ├── login.html
│   └── favicon.svg
├── docs/
│   ├── zeabur-deploy.md
│   ├── local-dev.md
│   └── api.md
├── Dockerfile
├── docker-compose.yml
├── zbpack.json               # Zeabur 建置與啟動腳本
├── package.json
└── .env.example
```

## 環境變數

| 變數 | 必要 | 說明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Postgres 連線字串 |
| `JWT_SECRET` | ✅ | JWT 簽章密鑰（>= 32 bytes） |
| `SEED_DEFAULT_PASSWORD` | | 首次啟動時賦予所有 seed 帳號的預設密碼，預設 `design2026!` |
| `SEED_ADMIN_EMAIL` | | 哪一位 seed 同仁標記為 admin，預設 `mark@company.com` |
| `NODE_ENV` | | `production` / `development` |
| `PORT` | | 預設 `3000` |

## 初始帳號

seed.js 會建立以下 9 人（密碼皆為 `SEED_DEFAULT_PASSWORD`）：

| 名字 | Email | 角色 | 年資 |
| --- | --- | --- | --- |
| Mark | wasimark0622@gmail.com | admin | senior |
| Sunny | sunny@company.com | member | senior |
| Milo | milo@company.com | member | senior |
| Michelle | michelle@company.com | member | senior |
| Amanda | amanda@company.com | member | mid |
| Jhen | jhen@company.com | member | mid |
| Ruby | ruby@company.com | member | mid |
| Agnes | agnes@company.com | member | junior |
| Mandy | mandy@company.com | member | junior |

**首次登入後請每位同仁至 `/change-password` 自行變更密碼。**

## 開發 / 除錯

```bash
npm run dev          # 本機開發模式（需要 DATABASE_URL）
npm run migrate:dev  # 套用 Prisma 結構變更
npm run seed         # 重跑 seed（idempotent，不會覆蓋現有資料）
```

## 版本

- **v3.4** (2026-04-25) — 批次匯入 CSV、個人檔案編輯（自己 / admin 編輯任何人）
- **v3.3** (2026-04-25) — 案件刪除、變更追蹤（ChangeLog）、貢獻指標分析（週／月／半年／年）
- v3.2 (2026-04-24) — Zeabur 全端封包，Email + 密碼登入，JWT cookie，Postgres 持久化
- v3.1 — 靜態部署 + Docker / IIS 選項
- v3.0 — 原型 (artifact-only)

## 授權

內部使用。Apache-2.0 for the framework code; bundled content proprietary.
