# Zeabur 部署指南（全端 · Postgres + Express）

本文件手把手帶你將 Design-PM 部署到 Zeabur。整個流程約 **10 分鐘**，不需改任何程式碼。

---

## 前置條件

- Zeabur 帳號（[zeabur.com](https://zeabur.com) 登入）
- 此 repo 推到 GitHub／GitLab，或打包成 .zip 直接上傳
- （建議）自訂網域一組，指向 Zeabur

---

## 步驟 1：建立專案

1. 登入 Zeabur Dashboard。
2. 右上角 **New Project** → 命名為 `design-pm-prod`（或任意）。
3. 選擇區域（建議 **East Asia · Tokyo**，對台灣延遲最低）。

## 步驟 2：新增 PostgreSQL 服務

1. 在 Project 頁點 **Add Service**。
2. 左側分類選 **Prebuilt** → **PostgreSQL**。
3. Zeabur 會自動建立 Postgres 實例，資料持久化由平台管理。
4. 等待狀態變為 **Running**（綠燈）。
5. 點進 Postgres 服務 → **Variables** tab，你會看到：
   - `POSTGRES_HOST`
   - `POSTGRES_PORT`
   - `POSTGRES_USERNAME`
   - `POSTGRES_PASSWORD`
   - `POSTGRES_DATABASE`
   - `POSTGRES_CONNECTION_STRING` ← **稍後要引用這個**

## 步驟 3：新增應用服務

**方式 A — 從 Git**

1. **Add Service** → **Git** → 選你推好的 repo／branch。
2. Zeabur 偵測到 `zbpack.json` → 自動辨識為 Node.js 專案。

**方式 B — 從 ZIP**

1. 把整個資料夾（不含 `node_modules`）打包成 `design-pm.zip`。
2. **Add Service** → **Deploy from ZIP** → 上傳。

等待 Zeabur 跑完 install → build（約 90 秒）。

## 步驟 4：設定環境變數

進入剛剛建立的 Node 服務 → **Variables** tab，新增：

| Key | Value | 說明 |
| --- | --- | --- |
| `DATABASE_URL` | `${POSTGRES.POSTGRES_CONNECTION_STRING}` | **字面複製這個字串**，Zeabur 會自動把它替換為 Postgres 實際的連線字串（服務名稱要跟你命名一致，預設是 `postgres`） |
| `JWT_SECRET` | `openssl rand -base64 48` 的輸出 | 生產環境必須用長隨機字串 |
| `NODE_ENV` | `production` | |
| `SEED_DEFAULT_PASSWORD` | `design2026!` | （可選）修改預設密碼 |
| `SEED_ADMIN_EMAIL` | `mark@company.com` | （可選）指定哪個 email 為 admin |

> **Tip**：`${POSTGRES.POSTGRES_CONNECTION_STRING}` 中的 `POSTGRES` 是 Postgres 服務的 name，如果你把服務改名為 `db`，改成 `${db.POSTGRES_CONNECTION_STRING}`。

按 **Save** 後，Zeabur 會自動重啟服務並套用新變數。

## 步驟 5：第一次啟動（自動遷移 + 播種）

Zeabur 執行 `zbpack.json` 中的 `start_command`：

```bash
npx prisma migrate deploy && node prisma/seed.js && node src/index.js
```

- **prisma migrate deploy**：套用 schema，建立 4 個 table
- **node prisma/seed.js**：寫入 9 筆同仁 + 16 筆示範案件（idempotent，只執行一次）
- **node src/index.js**：啟動 Express 於 `$PORT`

到 Zeabur 的 **Logs** tab 確認看到：

```
[seed] creating 9 staff + 16 cases
[seed] done. Login with mark@company.com / design2026!
[design-pm] listening on :3000
```

## 步驟 6：綁定網域

1. 服務頁面 → **Networking** / **Domains** tab。
2. Zeabur 會自動分配一個 `xxx.zeabur.app` 網域，可直接打開測試。
3. 若要綁自訂網域：
   - 點 **Add Domain** 填入 `pm.company.com`
   - 依指示在 DNS 設定 CNAME 指向 Zeabur
   - Zeabur 會自動申請 Let's Encrypt 憑證

## 步驟 7：首次登入與安全強化

1. 打開網址 → 導向 `/login`。
2. 用 `mark@company.com` + seed 密碼登入。
3. 到 `/change-password` 變更密碼（**每位同仁都該做**）。
4. 至 **Admin Dashboard → 人員管理** 確認所有同仁出現。

## 步驟 8：SMTP（選配，之後做）

目前通知寫入 `notifications` table，不主動寄信。若要真正寄 Email：

1. 在 Zeabur 加入 `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` 變數。
2. 安裝 `nodemailer`：`npm i nodemailer`。
3. 修改 `src/services/notify.js` 的 `notify()`：

   ```js
   import nodemailer from 'nodemailer';
   const transporter = nodemailer.createTransport({
     host: process.env.SMTP_HOST,
     port: +process.env.SMTP_PORT,
     auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
   });
   export async function notify({ type, recipientId, subject, body, relatedCaseId }) {
     const rec = await prisma.staff.findUnique({ where: { id: recipientId }, select: { email: true } });
     if (rec?.email) {
       await transporter.sendMail({ from: process.env.SMTP_FROM, to: rec.email, subject, text: body }).catch(() => {});
     }
     return prisma.notification.create({ data: { type, recipientId, subject, body, relatedCaseId: relatedCaseId ?? null } });
   }
   ```

## 步驟 9：備份

Zeabur Postgres 會保留最近 N 天的 volume snapshot（方案不同）。建議：

- **每週匯出**：在 Zeabur console 打開 Postgres 服務的終端：
  ```bash
  pg_dump "$POSTGRES_CONNECTION_STRING" > /tmp/backup.sql
  ```
- **雲端硬碟同步**：把 `/tmp/backup.sql` 複製到 Drive / S3。

## 步驟 10：監控

- **Zeabur Metrics** tab：CPU / RAM / Requests / Latency
- **Logs** tab：Express morgan 日誌 + Express error handler
- `/healthz` 端點會回傳 `{ ok: true, ts: ... }`，可接上 UptimeRobot 之類

---

## 疑難排解

### 啟動時卡在 `prisma migrate deploy`

通常是 `DATABASE_URL` 錯。點 Postgres 服務 → Variables → 複製 `POSTGRES_CONNECTION_STRING` 測試連線：

```bash
psql "<你複製的字串>"
```

若連不上，檢查 Zeabur 網域是否 allow-list 了對應區域。

### 登入失敗（`invalid_credentials`）

1. 確認 seed 跑過（Logs 中應有 `[seed] done`）。
2. 若 seed 沒跑，手動在 Zeabur 服務的 shell：
   ```bash
   node prisma/seed.js
   ```
3. 若已有資料但忘記密碼：
   ```bash
   node -e "import('./src/lib/db.js').then(async ({prisma}) => { const bcrypt = (await import('bcryptjs')).default; const h = await bcrypt.hash('new-password', 10); await prisma.staff.update({ where: { email:'mark@company.com' }, data: { password: h }}); console.log('reset'); })"
   ```

### 前端白畫面 / 連線到 /login 無限迴圈

- 打開 DevTools Network，確認 `/api/auth/me` 回什麼。
- 若回 401 但 cookie 有設，檢查 `JWT_SECRET` 是否被換過（換過會讓舊 cookie 失效）。
- 若回 502 / 503，到 Logs 看後端錯誤。

### 要升級 / 改 schema

1. 修改 `prisma/schema.prisma`
2. 本機 `npm run migrate:dev -- --name your_change_name`
3. Commit migration 到 git
4. Push → Zeabur 自動重建 → `migrate deploy` 套用

---

## 回滾

Zeabur 服務頁面 → **Deployments** tab → 點舊版的 ⋯ → **Rollback**。回滾只改 image，不會動 DB。若 schema 已改過要一併回滾，需手動執行反向 migration。
