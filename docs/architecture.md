# 藝術設計部專案管理系統 · 技術架構文件

> 對應 commit `190fd03`。業務規格見 [system-spec.md](./system-spec.md)，API 細節見 [api.md](./api.md)。

---

## 1. 技術棧

| 層 | 技術 |
|----|------|
| Runtime | Node.js ≥ 20（ESM） |
| Web 框架 | Express 4 |
| 資料庫 | PostgreSQL（Zeabur 託管） |
| ORM | Prisma 5 |
| 驗證 | JWT（cookie）+ bcryptjs |
| 安全 | helmet（CSP）、express-rate-limit、cors |
| 驗證/Schema | zod |
| Email | nodemailer（SMTP，選用） |
| 前端 | 原生 HTML/CSS/JS 單檔 SPA（無打包工具） |
| 字體 | LINE Seed Sans（自架 OTF）、LINE Seed TW（自架 WOFF2 子集）、Chiron Hei HK（Google Fonts） |
| 部署 | Zeabur（Dockerfile，多階段建置） |

## 2. 系統架構

單體服務：同一個 Express 程序同時提供 **REST API**（`/api/*`）與**靜態 SPA**（`public/`）。

```
瀏覽器 (SPA: public/index.html)
   │  fetch /api/*  (JWT cookie)
   ▼
Express (src/index.js)
   ├─ middleware: helmet CSP / cors / rate-limit / cookie / JWT auth
   ├─ routes: auth, cases, staff, notifications, analytics,
   │          hotels, units, vacations, business-trips, shoots, admin
   ├─ services: workload, analytics, changelog, notify
   └─ lib: db(Prisma), ids(案號生成)
   ▼
PostgreSQL (Prisma)
```

啟動序列（Dockerfile CMD）：`prisma db push`（同步 schema，自動建表/欄位）→ `prisma/seed.js`（空庫才灌範例）→ `node src/index.js`。

## 3. 資料模型（Prisma，10 models）

| Model | 用途 | 關鍵欄位 |
|-------|------|----------|
| **Staff** | 同仁 | name/email/role(admin\|member)/active/seniority/color |
| **Case** | 案件 | id(字串案號)/title/status/level/各日期/items(Json)/logs(Json)/deliverables(Json)/contact/copyPath/source/printDate/needsOutsourcing/designerId/collaborators |
| **Vacation** | 休假 | staffId/起訖/type |
| **BusinessTrip** | 出差 | staffId/起訖/hotel/task |
| **Shoot** | 拍攝行程 | desc/mode/起訖/photographer/hotel/createdById |
| **ChangeLog** | 稽核記錄 | caseId/field/from/to/reason/operator |
| **TransferLog** | 轉派記錄 | caseId/from/to/reason |
| **Notification** | 站內/Email 通知 | recipientId/type/subject/body |
| **Hotel** | 館別字典 | region/name/sortOrder/active |
| **RequestUnit** | 需求單位字典 | name/sortOrder/active |

> 子案件與日誌刻意存於 Case 的 JSON 欄位（items/logs），減少表數量、避免 migration；子項目本身亦含 logs 陣列。

## 4. API 端點總覽

所有 `/api/*` 需 JWT（除 `/api/auth/login`）。完整請見 [api.md](./api.md)。

- **auth**：`POST /login`、`POST /logout`、`GET /me`、`POST /change-password`
- **cases**：`GET /`、`GET /:id`、`POST /`、`PATCH /:id`、`DELETE /:id`、`POST /:id/approve`、`POST /:id/transfer`、`POST /:id/archive`、`POST /:id/clone`、`PATCH /:id/items`、`PATCH /:id/logs`、`GET /:id/changelog`、`GET /pending-approval/list`、`POST /bulk-import`
- **staff**：`GET /`、`GET /workload`、`POST /`、`PATCH /:id`、`DELETE /:id`、`GET /:id/departure-preview`、`POST /:id/departure`
- **vacations / business-trips / shoots**：各 `GET / POST / PATCH /:id / DELETE /:id`
- **hotels / units**：字典 CRUD
- **notifications**：`GET /`、標記已讀
- **analytics**：`GET /`（貢獻分析）

## 5. 前端架構

單檔 `public/index.html`（~8000 行）。採**漸進增強的 wrapper 疊加**模式：核心函數（如 `bootstrap`、`renderGantt`、`renderKanban`、`openDrawer`）被各版本以 `const _orig = fn; fn = async () => { await _orig(); …加強… }` 包覆，依版本（v3.3 → v5.6）累加功能。

關鍵全域：
- `CASES / STAFF / HOTELS / REQUEST_UNITS / VACATIONS / TRIPS / SHOOTS`：記憶體資料。
- `normalizeCase(b)`：後端 row → 前端案件物件（轉日期、補欄位）。
- `decorateCases()`：計算衍生欄位（overdue / daysLeft / reviewDate / gateActive）。
- `STATUSES / FINAL_STATUS_KEYS`：狀態定義與終態集合。
- 主題：`data-theme`(日/夜) × `data-season`(四季) 驅動 CSS 變數。
- 右下角 FAB（v5.6）收納「建立專案／休假出差／拍攝」。

## 6. 安全機制

- **CSP**（helmet）：`script-src 'self' 'unsafe-inline'`、`font-src 'self' data: fonts.gstatic.com`、`style-src 'self' 'unsafe-inline' fonts.googleapis.com`。
- **JWT**：登入後以 httpOnly cookie 帶 token；SPA 外殼於伺服器端 gate（未登入 302 → /login）。
- **限流**：登入 10 次/15 分；一般 API 全域限流。
- **密碼**：bcrypt 雜湊；預設密碼首次登入後應更換。

## 7. 部署（Zeabur）

- 以 **Dockerfile**（多階段：deps → runner）建置為 Node app。**不使用 zbpack.json**（曾因被誤判為靜態站導致 502，已移除）。
- 推送 main → Zeabur 自動建置部署；`prisma db push` 於啟動時同步 schema（新增欄位/表免手動 migration）。
- 若建置時出現「git 認證失敗」→ 於 Zeabur 後台「重新部署」重抓即可；持續失敗則需重新授權 GitHub。
- 詳見 [zeabur-deploy.md](./zeabur-deploy.md)、[local-dev.md](./local-dev.md)。

## 8. 已知技術債 / 注意事項

- `public/index.html` 單檔過大、wrapper 疊加多層，後續宜模組化/打包。
- 子案件與日誌存 JSON 欄位：查詢/統計彈性受限（目前需求未涉子項目層級的跨案統計）。
- `nextCaseId` 已加併發撞號重試（commit 190fd03）；極端高併發仍建議改用資料庫序列。
- 範例資料 `seed.js` 僅空庫灌入；正式環境資料以實際輸入為準。
