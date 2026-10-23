# 本機開發

使用 Node24.22.1 或 Dockerfile 的 Node24 映像。先複製 `.env.example` 成 `.env`，設定自己的本機 PostgreSQL URL；不使用正式連線與 SMTP。

```bash
npm ci
npm run db:deploy
```

新資料庫由 migrations 建表。需要初始帳號時，僅對全新的空庫設定下列環境變數後執行 `npm run seed`：

- `BOOTSTRAP_EMPTY_DATABASE=yes`
- `SEED_ADMIN_EMAIL`：明確的管理員 Email
- `SEED_ADMIN_NAME`：選填顯示名稱
- `SEED_ADMIN_PASSWORD`：自己設定的強密碼，至少12字元，含大小寫與數字，不超過72個UTF-8位元組；不輸出或提交此值。

Bootstrap 只建立一個管理員及館別／需求單位字典，不建立其他假帳號或範例案件。已有業務資料則不改動，也不要求初始密碼。

```bash
npm run dev
npm test
npm run test:node24
```

開啟 http://localhost:3000/login，以剛才自行設定的帳號登入，再從人員管理邀請成員。網站不會提供可讀回的原文密碼。

新 schema 變更透過 `npm run migrate:dev -- --name change_name` 產生 migration，檢查 SQL 並在隔離資料庫驗證後提交。`migrate:dev` 只對拋棄式開發資料庫執行，不能連正式／Demo。

由舊版資料庫繼續開發時，先照[資料庫維護](database-operations.md)做備份、還原與 baseline，不用 db push 或 reset。
