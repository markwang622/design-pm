# Changelog

## v4.8 (2026-05-18) · 個人代表色 + 分級顏色語意化

### Staff.color 個人色（12 色預設盤）
- Prisma：`Staff.color String?`（nullable），存 palette key
- 後端 `staff.js`：create / update schema 接受 `color`，校驗只能是 12 種 key 之一
- 12 色：teal 湖綠 / sea 海藍 / lavender 霧紫 / copper 銅棕 / rose 玫紅 / mustard 芥黃 / forest 深綠 / indigo 靛 / brick 磚紅 / olive 橄欖 / slate 青灰 / plum 莓紫
- 「編輯個人檔案」彈窗加色彩 picker，本人 + admin 都能改
- 套用位置：
  - 「我的任務」招呼語前的 10px 圓點（Morning, Mark · 前面就是個人色）
  - 案件卡左側 4px 邊框
  - 案件卡頭像（avatar）的背景色 + 文字色
  - 甘特圖主案件 bar 改用個人色（先前是狀態色），label 右補上小灰底 status chip 補回狀態資訊
  - 子案件卡保留 v44 狀態色，不打架

### 分級顏色語意化
- 統一處理所有 `class*="level-XX"` 的 chip：
  - SS 金香檳 / S 緋紅 / A 琥珀 / B 藍 / C 中性灰 / D 米
- renderPersonal / renderDashboard / renderKanban / renderHistory / renderGantt 後自動套用 `v48ApplyLevelChips()`

---

## v4.7 (2026-05-18) · 需求單位後台動態管理

### 新增 RequestUnit 字典
- 新 Prisma model `RequestUnit`（name 唯一、sortOrder、active），對應資料表 `request_units`
- Zeabur 用 `prisma db push` 自動同步 schema，不需手動 migration
- seed.js 加 `seedRequestUnits()`，每次部署 upsert 11 個預設單位（集團執辦 / 餐飲行銷 / 客房行銷 / 客務部 / 餐飲部 / 採購 / 工務 / 宜蘭行銷 / 花蓮行銷 / 嘉義行銷 / 台中行銷）

### 後端
- 新 route `src/routes/units.js`，仿 hotels：
  - `GET /api/units` — 所有人可呼叫（建案下拉用），可加 `?includeInactive=1`
  - `POST /api/units` — admin 新增（name 必填、sortOrder 可省略自動 +10）
  - `PATCH /api/units/:id` — admin 改名 / 改順序 / 停啟用
  - `DELETE /api/units/:id` — admin 刪除；若仍有案件 requester 對應此單位則回 409 `in_use`
- `src/index.js` 註冊 `/api/units`

### 前端
- `REQUEST_UNITS` 改為 `let`，bootstrap 時 `v47LoadUnits()` 拉 `/api/units` 取代預設值
- 建案彈窗的「需求單位」下拉動態套用，admin 改完即時更新
- Staff 頁加「📋 需求單位管理」按鈕（admin only），開啟同 v37 館別管理風格的 modal
- 功能：新增 / 停啟用 / 刪除（被引用會出 409 警示請改停用）

---

## v4.6 (2026-05-18) · 修密碼強度檢查 + 修登入後身分閃現

### 新增/重設密碼修正
- **問題**：前端只擋「< 8 字元」，但後端 `validatePasswordStrength` 要求至少 10 字、含大小寫英文、含數字、且不在 banned 清單（password / 12345678 / design2026! / qwertyuiop / admin1234）。所以新增人員後再重設密碼幾乎都會被後端 422 weak_password 退件，使用者只看到「儲存失敗」訊息，誤以為功能壞掉。
- **修正**：
  - 前端 `v34SaveProfile` 改用與後端完全一致的強度規則
  - 編輯表單裡顯示完整密碼規則提示 + 範例 `Welcome2026`
  - 加 `weak_password` / `password_reset_forbidden` 兩種 toast 處理，會把後端訊息原封不動顯示

### 登入後 "Sunny" 閃現修正
- **問題**：HTML 寫死 `<h2>早安，Sunny</h2>` 與 role-switch 「Sunny (設計師)」「Mark (Admin)」，加上 `let ME = { name: 'Sunny' }` 預設值。Bootstrap 拉 `/api/auth/me` 之前頁面已 paint，所以登入後會閃約 1 秒「Sunny」/「Mark」的假身分。
- **修正**：
  - HTML placeholder 清空：`<h2 id="hello"></h2>`、role-switch 改為「設計師 / 管理員」
  - `let ME` 初始 `name: ''`，`ME_NAME()` 回空字串
  - 加 `#app-loading-overlay` 全螢幕 spinner，main 一開始 `visibility:hidden`，bootstrap 跑完才拿掉 overlay 並顯示 main

---

## v4.5 (2026-05-18) · 甘特圖大小月正確化 + 休假/出差也進個人甘特

### 甘特圖月份按實際天數渲染
- 月模式：每欄寬度 = 該月實際天數（fr 比例）。Jan/Mar/May/Jul/Aug/Oct/Dec 為 31 天，Feb 為 28/29 天，欄寬不再均分。
- 日模式：直接看當月完整天數（不再被卡死 30 天，1/3/5/7/8/10/12 月顯示 31 天，2 月顯示 28/29）
- 季模式：每季按 Jan-Mar / Apr-Jun / Jul-Sep / Oct-Dec 實際天數（90/91/92）比例
- 週模式：保留 91 天（13 週）固定
- bar 位置、今日線、分隔線、背景週末/假日：全用 `totalDays` 重算
- v41 假期/出差條同步用日曆 windowEnd

### 個人甘特列入休假/出差
- 在 designer 分群時，當前視窗有 vacation 或 trip 的同事，即使沒主案件，也建一個空群組
- v41InjectVacationTripRows 會自動把休假/出差條注入該群組底下，所以即使沒主案，個人休假/出差仍會顯示在甘特

---

## v4.4 (2026-05-18) · 子案件納入甘特 + 我的任務

### 甘特圖（renderGantt 內 sub-row）
- 展開時，每個子案件 bar 用自己的 `start / end / status` 渲染，未設則 fallback 主案件日期
- bar 顏色用子案件狀態（V43_ITEM_STATUS 的六色：灰/棕/藍/黃/橘/綠），不再跟主案件同色
- 子案件列加狀態 chip、負責人 chip（前 3 字）
- bar tooltip 加上日期區間與負責人

### 我的任務（renderPersonal v4.4 wrap）
- 收集所有 `assigneeId === ME.id`（或 legacy `owner === ME 名字`）的子案件
- 在主案件清單下方加分隔列「📋 我的子案件 N」
- 每筆子案件渲染為獨立卡片：
  - 左邊有狀態色條 + 微漸層底
  - 標籤：「子案件」徽章 + 來源主案 ID + 第 N 件
  - 第三列顯示 開始/結束 日 + 「逾期 X 天 / 剩 X 天 / 今日到期 / 已結案」
- filter 連動：`overdue` 只顯示逾期子案件、`week` 顯示 7 天內到期、`collab` 顯示主案不是我的子案件
- 主負責人 KPI 卡 sub 加「· 子案件 N」

### 子案件編輯 UI 修正（連 v4.3 hotfix）
- 名稱輸入不再丟焦點：取消每按鍵 re-render，改為 in-place 更新頂部預覽
- select 綁 onchange、input 綁 oninput，避免雙觸發

---

## v4.3 (2026-04-29) · 子案件完整功能 + 信件去重 + UX 修補

### A 區（UX 修補）

- **A3 甘特圖排除 admin** — 即使有案件 designerId 指向 admin，gantt 也不再為其建一個群組
- **A5 「已完成（舊）」→「已結案」** — STATUSES 表 done 顯示名統一；視覺與 closed 一致
- **A6 移除「互動原型 v3.2」假註腳** — 之前 footer-note 是 .main 的兄弟元素、不在 view 內，原本 querySelector 抓不到。改用全頁 querySelectorAll 移除
- **D9 通知設定頁示意橫幅** — 在頁面頂端加黃色提示，避免使用者誤以為 toggle 真的會生效

### B 區（子案件完整功能）

- **後端**：新 endpoint `PATCH /api/cases/:id/items`
  - body: `{ items: [{ n, type, assigneeId, start, end, status, owner }], reason? }`
  - 權限：admin / 主負責人 / 協作者皆可改
  - 每次改寫一筆 ChangeLog（field=items、from/to 為項目數量）
  - 每個子案件可有：起訖日、狀態（todo/wait/doing/review/review_done/done）、指派人
- **前端**：抽屜內新增「📋 子案件」面板
  - 表格：名稱 / 主類別 / 負責人 / 開始 / 結束 / 狀態 / 刪除
  - 可新增、可逐欄編輯、可刪除
  - 儲存前必填名稱、結束日不可早於開始日
  - 儲存時必填變更原因（寫入 ChangeLog）
  - 唯讀模式（非 admin / 非主負責 / 非協作者）只顯示「僅可瀏覽」標籤
- **看板 / 甘特圖**：暫不變動視覺；子案件在抽屜內統一管理

### C 區（信件去重）

- **去重機制**：同 `type + recipientId + relatedCaseId` 在 N 小時內只寄一次 email
  - DB 通知仍照寫（系統內 timeline 不變）
  - 視窗預設 6 小時，可用環境變數 `NOTIFY_DEDUPE_HOURS` 改
  - 沒有 relatedCaseId 的通知不去重（避免一般訊息漏發）
- **強制重寄 endpoint**：`POST /api/notifications/:id/resend`
  - 自己的通知 OR admin 可呼叫
  - 帶 `force: true` 繞過去重，直接觸發 SMTP 寄送
  - subject 自動加上 `[重寄]` 前綴

### 影響

- 重複連按「轉派」/「改狀態」不會引發重複 Email
- admin 連續代編多次案件，designer 在 6 小時內只收一次 Email（除非觸發強制重寄）
- 系統內訊息與 Email 寄出**解耦**：DB 通知頻率不變、Email 寄送有頻率上限

## v4.2 (2026-04-28) · 手機版全面重做

### 修正（手機 ≤ 768px）

- **topbar nav 沒顯示**：`.nav` 有 `flex: 1 1 0%`，會吃掉之前設的 `width: 100%`。改用 `flex: 0 0 100%` + `min-width: 100%` 強制讓 nav 占完整一列、橫向捲動
- **Dashboard 三欄擠成 130px 寬**：`.grid-2`、`.grid-3` 在桌面是兩/三欄，沒在 @media 裡覆寫。新增 `.grid-2, .grid-3 { grid-template-columns: 1fr !important; }`
- **建案 modal 兩欄擠**：`.form-grid` 也加 1fr 規則
- **館別分布、近 7 天動態、等待處理** 三欄被壓到單字一行：因為前項規則修好，現在自動單列堆疊
- **設計師工作量 row 跑版**：`.bar-list .bar-row` 改成 `80px 1fr 60px`，姓名/進度條/件數對齊
- **狀態分布圓餅**：強制 160px 大小、置中
- **抽屜 detail-grid**：手機改 `80px 1fr`（桌面是 `90px 1fr`），文字 12px

### 補強（涵蓋所有 view 手機版）

- **看板**：filter 列 (`設計師 / 館別`) flex-wrap、select 等寬填滿剩餘空間
- **甘特圖**：工具列 wrap、容器 `overflow-x: auto`，內部 min-width 600px 用橫向捲動避免擠到不可讀
- **歷史案件**：搜尋框 100% 寬、設計師/分級/排序三個 select flex 等寬
- **資料匯入**：預覽表格隱藏館別/需求單位/上線日三欄（手機留 title/designer/level/status 主欄）；CSV 範例 pre 加 max-height 200px
- **審核中心**：每張卡的內容跟按鈕排成上下，textarea 100% 寬
- **貢獻分析**：期間 buttons flex-wrap，KPI row 兩欄
- **休假/出差 modal、個人檔案 modal、館別管理 modal、factory-reset modal**：所有 grid 強制 1fr，寬度 96%
- **view-as 黃色橫幅**：手機字小 + flex-wrap
- **toast**：max-width 90%

### 補（< 480px）

- KPI 從 2 欄變 1 欄
- detail-grid 進一步壓縮成 `60px 1fr`
- 主要操作按鈕字級再縮一點

## v4.1 (2026-04-27) · 第一輪 UI/UX 修補

### 修正

- **B1 達成率 NaN%** — Dashboard 在零案件時 `done/total*100` 會 NaN，現在 `total>0` 才算
- **B2 假數字 +12%** — 「VS 上月 +X」是寫死的 `total*0.12`，已移除改顯示「含進行中與已結案」
- **B5/B8 唯讀按鈕視覺禁用態** — 抽屜在唯讀模式下，所有 input/button 加 `opacity:0.4` + `cursor:not-allowed` + `pointer-events:none` + `grayscale(0.6)`，再也不會點下去沒反應
- **B9 離職申請 admin only** — designer 角色看不到「離職申請」按鈕

### 新增

- **U1 view-as 提示橫幅** — admin 切到成員視角時，topbar 下方多一條黃色橫幅：「👁 你目前以 XXX 的身份檢視（admin 模擬視角）」+「↩ 回到 admin 視角」按鈕
- **U10 審核中心送審時間** — 每筆待審案件 ID 旁加時間標：剛剛送審 / 送審 X 小時前 / 送審 X 天前（顏色：3 天內灰、1–3 天橘、>3 天紅）

### 確認已實作

- B6「協作中」filter pill 在我的任務頁早已存在

## v4.0 (2026-04-26) · 休假/出差 + 信件通知 + admin 代編

### 新增（後端）

- **`Vacation` model** — 休假申請（任何人填自己的、立即生效）
  - 欄位：`staffId, startDate, endDate, type (annual/sick/personal/other), note`
  - 路由：`GET/POST/PATCH/DELETE /api/vacations`（自己 + admin 可改）
- **`BusinessTrip` model** — 出差登記
  - 欄位：`staffId, startDate, endDate, hotel, task, note`
  - 路由：`GET/POST/PATCH/DELETE /api/business-trips`
- **admin 代編通知** (#1) — `PATCH /api/cases/:id` 當 admin 修改非自己擁有的案件且有 tracked field 變更時，**自動寄通知**給 designer，內容含逐項變更明細與原因
- **Email 服務框架** (#6) — `notify.js` 加 `deliver()`，支援 SMTP（nodemailer）
  - 環境變數：`SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / SMTP_SECURE`
  - 未設 → dry-run（DB 通知照寫，console 提示），設了 → 真寄
  - 接 Gmail：app password；接 SendGrid：apikey；接 SES：IAM 用戶
  - `nodemailer` 加進 dependencies

### 新增（前端）

- **「📅 休假/出差」按鈕**（topbar 右上）
- **休假/出差 modal** — 新增/列出/刪除自己的休假與出差
  - 休假類型下拉：特休 / 病假 / 事假 / 其他
  - 出差欄位：館別（從 Hotel API 拉清單）、任務說明、備註
- **看板上方顯示**「📅 同仁休假/出差（今日 + 未來 7 天）」橫條
- **甘特上方顯示**「📅 同仁休假/出差（未來 60 天）」清單

### 設定 SMTP（之後啟用即可）

```
# Zeabur Variables 加進這幾個 key 就會啟動寄信
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=youraccount@gmail.com
SMTP_PASS=your-16-char-app-password
SMTP_FROM=Design-PM <youraccount@gmail.com>
```

Gmail 必須先去 https://myaccount.google.com/apppasswords 產 app password（不能用一般密碼）。

### 變更

- 版號 → 4.0.0

## v3.8 (2026-04-26) · 主題切換 + 手機 responsive + bug 收尾

### 修正

- **狀態分布圓餅** — 總數與切片加總不一致（16 件，但切片只到 13）：原本 `total = live.length` 把 legacy `done` 也算進去，但切片排除了它。改成 `total = stats.reduce`。
- **狀態分布配色** — 「尚未開始」原本 `#E5E5E5` 跟卡片底色（白）糊在一起，改成 `#B5B5B5`。
- **圓餅副標題**「件 · 進行中」誤導，改為「件 · 未結案」。
- **個人視窗的「本期間完成任務」** — 之前切換成個人視角時左邊 KPI 會更新但右邊案件清單沒變。現在右邊也會過濾為該成員主負責 + 協作的案件，並標明角色。
- **「近 7 天動態」** 是寫死的假資料（Sunny / Mark / Form…），改成從 CASES 動態計算（最近 14 天的開案／結案／確稿完成事件）。
- **「設計師工作量」全處過濾 admin** — 之前只在 dashboard 過濾，其它地方仍可能拉到 Mark；現在全頁 `activeDesigners()` 都排除 admin。
- **拿掉 logo 的「prototype v3.2」** 標籤。

### 新增

- **🌞 / 🌙 / 🌗 主題切換** — header 增加循環按鈕（日間 → 夜間 → 自動 → 日間…）
  - 「自動」= 18:00–06:00 視為夜間，或瀏覽器/系統 prefer dark
  - 設定存 localStorage，下次開啟自動套用
  - 每分鐘重檢自動模式（避免 18:00 過了還停在白）
  - login.html 也支援，且首次載入時 inline script 立即套用，避免「白底閃一下變黑」
- **手機 responsive 全面修**（@media max-width: 768px / 480px）：
  - topbar nav 改成可橫向捲動列；logo dim 隱藏
  - KPI 從 6 欄變 2 欄（手機）/ 1 欄（窄）
  - 看板從 5 欄變 1 欄
  - 抽屜全寬、modal 96% 寬
  - 人員清單從表格改卡片版面
  - dashboard / analytics / approval 卡片自動堆疊
- **`openDrawerById()` 防呆** — 找不到案件時提示而非靜默失敗

## v3.7 (2026-04-26) · Dashboard / 甘特 / 歷史 / 貢獻分析 + 安全補強

### 安全（高優先）

- **修閃畫面** — 伺服器端 SPA shell 守門：未登入直接 302 → /login，從不送出 index.html。原本「打開網址 → 看見內頁畫面 → 才跳登入」的洩露窗口完全消失。
- **/login 已登入時** 自動重導回 / （避免再次登入造成混亂）

### 新增（後端）

- **Hotel CRUD** — 新 model `Hotel(id, region, name, sortOrder, active)`
  - `GET /api/hotels` （全員）— 拉現役館別
  - `POST/PATCH /api/hotels`（admin）— 新增、編輯、停用
  - `DELETE /api/hotels/:id`（admin）— 僅當無案件引用時可刪
- **新增宜蘭・礁溪館**（seed 自動建）
- **原案重啟** `POST /api/cases/:id/clone`
  - admin 或原負責人可重啟已結案／封存案
  - 沿用原 title/level/hotel/category/collaborators/note，新 ID、新 openDate、status=todo
  - 新案 note 自動寫入「🔁 原案重啟：來源 XX-XXXX」與舊 note 內容
- **分析公式 v3.7** — `TIMELY_COEF` 改三段：
  - 提早完成（closedOn ≤ goLiveDate − 1 日）×1.2
  - 準時 ×1.1
  - 逾期 ×0.8
  - rollup 回傳 `earlyCount`、`earlyRate`、每筆案件 `timely: 'early'|'onTime'|'overdue'`

### 新增（前端）

- **Dashboard 改造**
  - 開放給 member：dashboard nav 加進 designer 列；內容自動依登入身份個人化
  - 「設計師工作量」**移除 Mark / 全部 admin**
  - 「館別分布」改成**全部館別、固定順序、即使 0 件也顯示**（區域・名稱：集團本部、新竹・新竹湖濱館 …、宜蘭・礁溪館 等）
  - **新區塊「⏰ 即將到期」** — 列出明天就是確稿日的案件，可點開抽屜
  - 「等待處理」**個人化** — 只顯示登入者主負責或協作的案；admin 看全部
  - **狀態分布圓餅放大**（120 → 180 px）+ 中央顯示總件數 + 加 review_done 與 closed 的配色
- **甘特圖修復**
  - 「今」標記**動態定位** — 根據 ganttStart 與 TODAY 偏移計算 left%
  - **底圖跳色** — 偶數列灰、奇數列白；分組標題深灰
  - **member「只看我的」toggle** — 在工具列右側
- **歷史案件**
  - 抽屜進歷史案件時**全鎖**，並注入「🔁 原案重啟」按鈕（admin / 原負責人可見）
  - **排序下拉**：結案日（新→舊／舊→新）／ 分級（高→低／低→高）／ 案件名稱
  - 搜尋已涵蓋 title（v3.6 已實作）
- **人員管理**
  - 自己列的「編輯個人檔案」按鈕**縮短為「編輯」**（避免擠版）
  - 離職人員「查看歸檔」改成**卡牌列表 modal**，顯示該人所有主負責 + 協作的案件
- **貢獻分析**
  - **個人視圖** — 新「全部設計師 / 個人視圖」下拉，選某人後顯示 4 格 KPI：主負責、協作、提早完成件數、準時率，含分級分布
  - 註腳更新：標明 v3.7 新增的「提早完成 ×1.2」係數
  - 移除誤入分析頁的 footer-note
- **館別管理 admin modal**
  - 「人員」分頁右側新增「🏢 館別管理」按鈕（admin only）
  - 模態：列出所有館別、可啟用/停用、可新增（區域、名稱、順序）

### 變更

- HOTELS 從 hardcode 改成 bootstrap 時從 `/api/hotels` 拉
- 預先寫好 v3.7 seed：上線會自動補入礁溪館（既有 DB 不影響其他館別資料）

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
