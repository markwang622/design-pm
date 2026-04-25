# 本機開發指南

兩種方式：Docker Compose（推薦，0 配置）、或 Node + 外部 Postgres。

---

## A. Docker Compose（推薦）

需要 Docker Desktop 或 Podman。

```bash
cd design-pm-zeabur
docker compose up --build
# 第一次啟動約 90 秒（拉 Node / Postgres image + prisma generate + seed）
```

打開：

- 前端：http://localhost:3000
- 登入：mark@company.com / design2026!
- 資料庫：localhost:5432 / postgres / postgres

停止：`docker compose down`。資料保存在 `db-data` volume，下次啟動仍在。

完整重置：

```bash
docker compose down -v   # -v 同時刪 volume
docker compose up --build
```

---

## B. 本機 Node（不用 Docker）

**前置**：Node 20+、Postgres 14+。

```bash
# 1. 安裝
npm install

# 2. 複製環境變數
cp .env.example .env
# 編輯 .env，把 DATABASE_URL 改成你本機 Postgres 的連線字串

# 3. 建 schema + seed
npm run migrate:dev -- --name init
npm run seed

# 4. 啟動（--watch 會自動重啟）
npm run dev
```

---

## 常用指令

| 指令 | 作用 |
| --- | --- |
| `npm run dev` | 啟動開發伺服器（會 watch 檔案變更） |
| `npm run start` | 啟動正式伺服器（不 watch） |
| `npm run migrate:dev` | 建立並套用新 migration（會互動提示名稱） |
| `npm run migrate:deploy` | 套用 production migration（不建新檔） |
| `npm run generate` | 重生 Prisma client（改 schema 後需執行） |
| `npm run seed` | 跑 seed，idempotent |

---

## 開發小技巧

### 查 DB 現況

用 Prisma Studio（推薦）：

```bash
npx prisma studio
# 打開 http://localhost:5555
```

或用 psql：

```bash
psql postgresql://postgres:postgres@localhost:5432/design_pm
```

### 模擬不同使用者

新增一位 admin：

```bash
node -e "
import('./src/lib/db.js').then(async ({prisma}) => {
  const bcrypt = (await import('bcryptjs')).default;
  await prisma.staff.create({ data: {
    name: 'Tester', email: 'tester@company.com',
    password: await bcrypt.hash('test1234', 10),
    joined: new Date('2026-01-01'),
    seniority: 'mid', role: 'member',
  }});
  console.log('created');
});
"
```

### 清空 DB（開發環境）

```bash
npx prisma migrate reset
# 會完整 drop、重建、重跑 seed
```

### 看後端錯誤

後端 log 走 morgan + console.error。預設 `NODE_ENV=development` 時 morgan 用 `tiny` 模式。

### 除錯 API 請求

前端的 API 客戶端在 `public/index.html` 最底部的 `window.api`。在 DevTools Console 可直接呼叫：

```js
await api.cases.list()
await api.staff.workload()
```

---

## 改 schema 的流程

1. 編輯 `prisma/schema.prisma`
2. `npm run migrate:dev -- --name your_name` — 建 migration 檔
3. commit `prisma/migrations/xxx_your_name/` 與更新後的 schema
4. Push → CI / Zeabur 上會自動 `prisma migrate deploy`

**千萬不要** 手動改 DB schema——一律走 migration。
