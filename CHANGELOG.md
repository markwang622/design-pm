# Changelog

## v3.6 (2026-04-26) · Medium 批次（三段式結案 + 審核流 + 歷史 + 安全）

### 新增（後端）

- **狀態擴增**：`todo → wait → doing → review → review_done → closed`（取代過去的 `done`，舊 `done` 視為等同 `closed`）
- **審核 API** `POST /api/cases/:id/approve`（admin only） — body `{ decision: 'approve' | 'reject', comment? }`
  - approve：status → closed、archived → true、closedOn 自動填入；通知設計師
  - reject：status → doing；通知設計師（附評語）
- **待審清單 API** `GET /api/cases/pending-approval/list`（admin）— 列出 `status = review_done` 的所有案
- **`review_done` 觸發通知** — 設計師 PATCH 把案件推到 review_done 時，自動寄 notification 給所有 admin
- **`closed` 自動 archive** — PATCH 或 approve 把案件設成 closed 時，archived 同步設為 true
- **權限收緊** — 非 admin 的 PATCH /api/cases/:id 限定該案件的主負責人；協作者只能讀
- **member 不能直接設 closed** — 必須走 `review_done` → admin 審核

### 新增（前端）

- **新分頁「審核中心」** (admin) — 列出待審案件、通過/退回按鈕、評語欄；nav 上有未審計數紅點徽章（每 60 秒更新）
- **新分頁「歷史案件」**（全員）— 列出 closed/archived 案，可搜尋、分級／設計師篩選；唯讀
- **看板 / 甘特** — 取消「設計師只看自己」限制：member 可以看全部，但編輯（狀態、轉派、刪除）只能在自己的案件上（抽屜會顯示「僅可瀏覽」橫幅）
- **header 使用者選單** — admin 取代原本 role-switch，改用：自己（Admin）按鈕 + 切換到任何成員視角的下拉
- **甘特工具列** — 加上年/月區間標籤
- **狀態 UI** — 抽屜下拉新增「確稿完成（送 admin 審核）」；新增 `status-review_done`、`status-closed` chip 樣式

### 安全強化（#22）

- **密碼複雜度**：至少 10 字元、大小寫字母 + 數字、不允許常見字串
- **bcrypt rounds 提到 12**（從 10 升級）
- **JWT TTL 縮短到 2 天**（從 7 天）— 失竊 cookie 暴露時間減少 70%
- **登入限速**：每 IP 15 分鐘最多 10 次失敗，超過回 429
- **全域 API 限速**：每 IP 每分鐘 300 req
- **HSTS** 啟用（生產環境，6 個月）— 強制瀏覽器走 HTTPS
- **Cross-Origin-Opener-Policy** 設為 same-origin — 阻擋同源 popup 攻擊
- **Referrer-Policy** 設為 strict-origin-when-cross-origin

### 變更

- 分析計算同時納入 `done`（舊資料）+ `closed`（新資料）
- 確稿日待簽核倒數：把 `review`、`review_done`、`closed`、`done` 全當「不需倒數」狀態

## v3.5 (2026-04-26) · Quick 修補批次

### 修正

- **館別字串** — 宜蘭．新竹湖濱館 / 新竹都會館 / 台南館 改為正確區域；移除「宜蘭・宜蘭行銷」「花蓮・花蓮行銷」（這兩個是需求單位、不是館）
- **文字** — 「近確稿」→「確稿中」、「卡控」→「待簽核」全站替換
- **管理通知段** — 通知設定頁的「管理相關」區塊只給 admin 看見

### 新增

- **需求單位** 下拉新增 4 項：宜蘭行銷、花蓮行銷、嘉義行銷、台中行銷
- **「其他」類別** 選擇後展開「自訂類別項目」文字欄，必填；存進 case 的 `category` 欄位為 `7 其他 — {自訂}`
- **admin「刪除該人員」按鈕** — 人員列表新增此按鈕（藍色「離職申請」旁邊紅色），呼叫既有離職流程：已完成案件自動封存、開放案件需指定繼承人

## v3.4 (2026-04-25) · 批次匯入 + 個人檔案編輯

### 新增

- **批次匯入** — 新路由 `POST /api/cases/bulk-import`（admin only）
  - 接收 `{ rows: [{ title, designerName, ... }] }`
  - designer 用「姓名」對應到 ID（避免 CSV 沒有 ID）
  - status 預設 todo，全部欄位皆有合理預設值
  - 狀態 = done 但沒填 archivePath 時，自動產出占位路徑
  - 回傳 `{ summary, created, errors }` — 每筆失敗都有詳細錯誤訊息
- **管理員「資料匯入」分頁**
  - 上傳 CSV → 客戶端解析 → 預覽表格
  - 預覽列可現場修改 designerName、勾選跳過
  - 自動驗證：title 必填、designerName 必須在系統內、狀態翻譯
  - 一鍵送出，顯示成功 / 失敗清單
  - 內建中文狀態翻譯（進行中→doing、等待中→wait、已完成→done…）
- **個人檔案編輯** — 全員可編輯自己；admin 可編輯任何人
  - 入口 1：頁面右上角「編輯個人檔案」連結（自己的）
  - 入口 2：人員分頁每一列的「編輯」按鈕（admin 看到所有人；非 admin 只看到自己）
  - 可編輯欄位：姓名、Email、職稱、資歷（admin 限定）、角色（admin 限定）
  - 自己改密碼：填舊密碼 + 新密碼 + 確認新密碼
  - admin 重設他人密碼：直接覆蓋（PATCH /api/staff/:id 帶 resetPassword）

### 變更

- **PATCH /api/staff/:id** body 新增可選 `resetPassword` 欄位（admin only，僅限用於他人）
- 錯誤處理擴增：P2002 → 409、P2025 → 404
- CSV 解析：支援帶引號欄位、逃逸雙引號、多種行尾

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
