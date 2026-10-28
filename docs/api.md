# REST API 參考

所有 `/api/*` 端點（除 `/api/auth/login`）都需要有效的 `designpm_token` httpOnly cookie。未登入回 401。

Base URL：`https://<你的網域>/api`

---

## Auth

### `POST /api/auth/login`

```json
Request:
{ "email": "mark@company.com", "password": "design2026!" }

Response 200:
{ "id": 1, "name": "Mark", "email": "mark@company.com", "role": "admin", "seniority": "senior" }
Set-Cookie: designpm_token=<jwt>; HttpOnly; Path=/; Max-Age=604800

Response 401:
{ "error": "invalid_credentials" }
```

Rate-limit：每 IP 15 分鐘 50 次（`express-rate-limit`）。

### `POST /api/auth/logout`

清 cookie。永遠回 `{ ok: true }`。

### `GET /api/auth/me`

回目前登入者：

```json
{ "id": 1, "name": "Mark", "email": "...", "role": "admin", "seniority": "senior", "active": true }
```

### `POST /api/auth/change-password`

```json
Request: { "currentPassword": "...", "newPassword": "..." }  // new min 8
Response 200: { "ok": true }
Response 401: { "error": "wrong_current_password" }
```

---

## Cases

### `GET /api/cases`

Query: `?includeArchived=1` (default: 只列未封存)

回陣列，每筆包含：

```json
{
  "id": "SS-2026-04-001", "title": "...", "subTitle": "...",
  "requester": "...", "hotel": "...", "level": "SS", "category": "...",
  "status": "doing", "urgent": false, "note": "...",
  "openDate": "2026-04-02T00:00:00.000Z",
  "dispatchDate": "...", "copyDate": "...", "goLiveDate": "...",
  "archived": false, "archivePath": null, "closedOn": null,
  "designer": { "id": 2, "name": "Sunny", "seniority": "senior", "active": true },
  "collaborators": [ { "id": 7, "name": "Michelle", ... } ]
}
```

### `GET /api/cases/:id`

單筆（含 `transferLogs` + `changeLogs`，倒序）。404 若不存在。

### `GET /api/cases/:id/changelog` · v3.3

單獨取此案的變更記錄列表，最新在前：

```json
[
  { "id": 17, "caseId": "A-2026-04-019", "field": "goLiveDate",
    "fromValue": "2026-04-30", "toValue": "2026-05-07",
    "reason": "客戶延後上線", "operator": "Mark",
    "createdAt": "2026-04-25T08:42:11.123Z" }
]
```

### `POST /api/cases`

```json
{
  "title": "...", "subTitle": "...", "requester": "客房行銷",
  "hotel": "宜蘭館", "level": "B", "category": "2 數位廣宣",
  "designerId": 2, "collaboratorIds": [5, 7],
  "openDate": "2026-04-23", "dispatchDate": "2026-04-23",
  "copyDate": "2026-04-25", "goLiveDate": "2026-05-06",
  "urgent": false, "note": "..."
}
```

自動產生 `id`（格式 `LEVEL-YYYY-MM-SEQ`）；自動寄通知給 designer + collaborators。

### `PATCH /api/cases/:id`

任意 field。特殊規則：

- 改 `designerId` → 自動寫入 `TransferLog`（`reason: 主管派發`）
- `status: "done"` 且無 `archivePath` → **422** `{ error: "archive_path_required", message: "未填寫檔案歸檔位置，無法結案" }`
- `status: "done"` 首次切入 → 自動填 `closedOn = now`
- **v3.3**：改追蹤欄位（`goLiveDate / dispatchDate / copyDate / designerId / status / level / urgent`）必填 `reason` 字串，否則 **422** `{ error: "reason_required", message: "時程或任務欄位調整時，必須填寫調整原因", changedFields: [...] }`。每個變更會寫入一筆 `ChangeLog`。

### `DELETE /api/cases/:id` · v3.3

權限：

- admin：可刪除任何案件
- 案件建立者：僅當 `status === 'todo'` 時可刪除自己建立的案
- 其他狀況回 **403** `{ error: "forbidden", message: "..." }`

成功回 `{ ok: true, deleted: "<id>" }`。Cascade 刪除 ChangeLog 與 TransferLog；Notification 的 `relatedCaseId` 改為 `null`。

### `POST /api/cases/:id/archive`

**Admin only**。把 `archived: true`。

### `POST /api/cases/:id/transfer`

**Admin only**。

```json
Request: { "toDesignerId": 5, "reason": "同週撞期" }
```

寫 TransferLog + 通知新負責人。

---

### 交付明細（REPORTS-P1-A，預設關閉）

伺服器旗標 `DELIVERY_RECORDS_ENABLED=1` 才啟用；未啟用時三個端點一律回 `404 {error:"feature_disabled"}`。本批不改送審／核可規則、不改既有結案數量 UI，舊 `requestCount`／`outputCount` 不會被讀寫或推算。

- `GET /api/cases/:id/deliveries`：與 `GET /api/cases/:id` 相同可見範圍，不寫入。回傳 `records`（含作廢紀錄與原因）、`summary`（僅依 kind × unit 分組，不跨類型加總；無有效紀錄時 `status:"unknown"`，不是 0）、`legacy`（舊總數與 `unknown`／`legacy_total` 狀態）、`updatedAt`、`contentVersion`。
- `POST /api/cases/:id/deliveries`：`{ id, itemKey?, itemName?, kind: main|extension|support, quantity: 0–1000000 整數, unit: "件", deliveredOn: YYYY-MM-DD（真實日期，2000-01-01 至台北今日）, note?, expectedUpdatedAt, expectedContentVersion }`。`id` 為用戶端產生的穩定識別碼兼冪等鍵（8–100 個英數／_／-）。記錄者由登入身分決定，多餘欄位一律 400。未指定 `itemKey` 時 `itemName` 必填；有 `itemKey` 時必須是此案已存在的子案件，品名預設取子案件名稱（快照）。數量 0 只限 `support` 且需具體說明（≥4 字、非佔位詞）。主負責人／協作者／管理員可寫，觀察者與無關成員 403；`review_done`、`done`、`closed`、`cancelled` 或已封存案件 409 `case_locked`。成功 201，並與案件版本同交易前進；同一登入者＋案件＋id＋完全相同的送出意圖（含「是否自填品名」）回 200 `replayed:true`（即使版本已過期）；同 id 不同意圖 409 `delivery_request_conflict`；版本過期 409 `edit_conflict`。
- `POST /api/cases/:id/deliveries/:rid/replace`（REPORTS-P1-B，原子更正）：body 為新紀錄的一般建立欄位（`id` 為這次更正操作的穩定識別碼）＋必填 `reason`（≥2 字）＋`expectedUpdatedAt`／`expectedContentVersion`。單一 Serializable 交易：重新檢查登入者／指派／案件狀態／版本 → 建立替代紀錄 → 以 `voidRequestId = 新 id`、`voidReason = reason` 作廢原紀錄 → 案件版本只前進一次；任一步失敗兩筆都不變。成功 201 回 `{ original, replacement, case }`。同一登入者＋案件＋原紀錄＋原因＋替代內容的完整重送回 200 `replayed:true`；任何一項不同、或把一般新增的 id 當成更正（反之亦然）皆 409 `delivery_request_conflict`。原紀錄已作廢 409 `delivery_already_voided`；原紀錄不屬於此案 404。既有 create／void 端點不變。
- 前端（`public/case-deliveries.js`／`.css`）：案件抽屜「交付成果」區塊，伺服器回 404 `feature_disabled` 時整區隱藏。只有真實登入者為管理員／主負責人／協作者（以 ID 判斷）且案件未送核可／結案／取消／封存時可新增、更正（呼叫 replace）、作廢；草稿依登入者＋案件＋操作存於 sessionStorage（失敗時改用記憶體）；結果不明時保留完全相同的請求並要求先「重新確認送出」。
- `POST /api/cases/:id/deliveries/:rid/void`：`{ requestId, reason（≥2 字）, expectedUpdatedAt, expectedContentVersion }`。一次性作廢戳記，原紀錄保留且不再計入摘要；同 requestId 重送回 200 replay，其他請求 409。更正方式＝作廢＋新增一筆；不提供編輯或刪除。原子「替換」端點留待 B/C 視需要加入。
- 子案件 `items[].key`：伺服器在建案與 `PATCH /items` 時產生／保留；帶入不存在、重複或格式錯誤的 key 回 422。舊畫面未送 key 時，內容相同（套用 itemSchema 預設值後）或唯一同名且未被交付引用的子案件保留原 key；被有效交付引用的子案件若被移除或在未帶 key 下修改，整筆 409 `linked_item_removed`。
- `DELETE /api/cases/:id`：案件有任何交付紀錄（含已作廢）時 409 `case_has_deliveries`；資料庫 RESTRICT 外鍵在併發時仍會擋下。

### 交付明細制送審與核可（REPORTS-P1-C1，預設關閉）

開關：`DELIVERY_RECORDS_ENABLED=1`（明細）＋`DELIVERY_WORKFLOW_ENABLED=1`（流程）；兩者皆開才可新建 records 案、導入、送審、核可。案件欄位 `deliveryMode` 為 `legacy`／`records`，既有資料一律 legacy；records 單向不可退回（DB 觸發器）。開關關閉不會讓 records 案退回舊流程：新送審／核可回 409 `delivery_workflow_paused`，明細與送審紀錄仍可讀；撤回與退回仍可用（避免死路）。legacy 案沿用原契約（`PATCH status:'review_done'`、`POST /approve {decision, comment?}`）。

- `POST /api/cases/:id/delivery-mode/adopt`（admin）：`{ requestId, reason(2–500), expectedUpdatedAt, expectedContentVersion }`。僅未封存、在辦、非 `review_done`／終態／取消的 legacy 案；記錄操作者 ID／姓名／時間／原因。201；同 requestId＋同原因重送 200 replay；不同內容 409 `delivery_request_conflict`；已是 records 409 `already_records`；不符資格 409 `adoption_not_allowed`；流程未啟用 404 `feature_disabled`。
- `POST /api/cases/:id/delivery-submissions`（admin／主負責人／協作者）：`{ id, completenessConfirmed: true, expectedUpdatedAt, expectedContentVersion }`。交易內重驗有效登入者、指派、records 模式、在辦狀態、瀏覽器版本、非空歸檔、≥1 筆有效交付（全部作廢＝沒有）。建立不可改的送審依據（有效紀錄 ID＋內容指紋、kind×unit 摘要、support 0 清單與說明、歸檔快照、子案件快照、舊數量），案件改 `review_done` 並記 `pendingDeliverySubmissionId`。201 `{ submission, case }`；精確重送 200 replay（不重寫、不重發通知）；同 id 不同登入者／案件 409。缺版本 409 `client_update_required`；`completenessConfirmed` 非 true 422；缺歸檔 422 `archive_path_required`；無有效交付 422 `deliveries_required`；已送審 409 `already_submitted`；legacy 409 `not_records_mode`。
- `POST /api/cases/:id/delivery-submissions/:submissionId/withdraw`（admin／主負責人／協作者）：`{ id, reason(2–500), expectedUpdatedAt, expectedContentVersion }`。一次性決議章 `withdrawn`，案件回 `doing`；再以 B 的 replace／void 更正後重新送審。
- `POST /api/cases/:id/approve`（records 案，admin）：`{ decision:'approve'|'reject', submissionId, operationId, expectedUpdatedAt, expectedContentVersion, comment?, zeroSupportApproved? }`。缺 `submissionId`／`operationId`／版本 409 `client_update_required`（舊畫面）。approve：交易內重驗歸檔與有效紀錄指紋＝送審依據（否則 409 `submission_evidence_changed`）；有任何有效 support 0 時 `zeroSupportApproved` 必須為 true（422 `zero_support_confirmation_required`）；案件 `closed + archived + closedOn`。reject：`comment` 必填（≥2 字，422 `reject_reason_required`），不要求補齊歸檔／交付，案件回 `doing`。回 `{ submission, case }`；同 operationId 精確重送 200 replay；不同決議／評語／確認／登入者 409。
- `GET /api/cases/:id/delivery-submissions`：可見案件皆可讀；`{ mode, status, pendingSubmissionId, updatedAt, contentVersion, workflow:{recordsEnabled, workflowEnabled, workflowActive, paused}, submissions:[{ id, status: pending|approved|rejected|withdrawn|cancelled, summary, zeroSupport, recordIds, archivePath, itemsSnapshot, legacyCounts, submittedBy…, decidedBy…, decisionReason, zeroSupportApproved }] }`。legacy 案在明細開關關閉時 404。`GET /deliveries` 另回 `mode`、`status`、`pendingSubmissionId`、`workflow`。
- 其他入口（含 admin）：records 的 `PATCH status` 改 `review_done`／`done`／`closed` 一律 409（請改用上列端點）；待審中改狀態 409 `delivery_withdraw_required`；待審或已核可時改 `archivePath`、`requestCount`／`outputCount`、`PATCH /items` 409 `delivery_evidence_frozen`；已核可 records 不可重啟（409 `records_reopen_unavailable`）；待審不可 `POST /archive`（409 `delivery_pending_review`）；取消會在同一交易把待審送審蓋章 `cancelled`（交易內重新讀取登入者：須為**目前**有效的 admin 或**目前**主負責人，協作者不可；停用／未啟用 403 `actor_inactive`、觀察者 403 `read_only`、降級且非主負責人 403 `forbidden`，皆整筆回滾；蓋章與稽核使用交易內讀到的 ID／姓名），還原取消回 `doing`（不回 `review_done`）。CSV 匯入一律 legacy；clone 依新建規則且不複製交付／送審。`GET /api/cases`、`GET /api/cases/:id` 另回 `_count.{deliveries, deliverySubmissions}`。
- `PATCH /api/cases/:id` 的證據欄位（`archivePath`、`requestCount`／`outputCount`）一律在 Serializable 交易內以讀取當下的快照（狀態、`deliveryMode`、`updatedAt`、`contentVersion`、主責）作條件寫入，並在交易內重新驗證登入者（有效、已啟用、目前角色）與指派；期間若有送審／核可／導入／交付寫入成立，這次 PATCH 回 409 `case_conflict`，路徑、版本、稽核皆不變（含同一毫秒）。records 案的證據 PATCH 會讓 `contentVersion` 前進，之後帶舊版本的送審回 409 `edit_conflict`；legacy 案不前進 `contentVersion`。非證據欄位的編輯行為不變。
- 前端（REPORTS-P1-C2，`public/case-workflow.js`／`.css`，載入於 B 之後）：案件抽屜「送審與核可」區塊與主管核可清單共用同一份送審依據（`GET …/delivery-submissions`）。權限一律以真實 `ME.id`／`ME.role` 與主責／協作者 ID 判斷（view-as、姓名不擴權；觀察者唯讀）。records 案的狀態選單與看板拖曳改 `review_done`／`done`／`closed`、或待審中改狀態，一律在任何樂觀更新前改開送審／撤回／審核流程，不再呼叫舊 `PATCH status`；核可清單的 records 列不顯示舊的 `{decision, comment}` 按鈕。送審前先等未儲存的歸檔位置存好，再權威讀取 `GET /deliveries` 與 `GET /api/cases/:id`（兩者版本一致）呈現歸檔位置、主設計／延伸／支援分開摘要、0 件支援說明與有效交付清單；「完整登錄」確認只對當下檢視的版本有效，版本變動（409 或重新開啟）須重新勾選。支援 0 件的核可須另勾主管確認；退回原因至少 2 字。送審中歸檔、子案件、交付、結案數量唯讀；已核可 records 不顯示舊版結案數量補填與「原案重啟」。開關暫停時仍可讀取與撤回／退回。每個操作有穩定 id；結果不明時保留完全相同的請求，需「重新確認送出」（伺服器 replay，不產生第二筆）；案件快照以 (contentVersion, updatedAt) 單調合併。舊制案件於明細功能關閉時（404 `feature_disabled`）安靜隱藏，records 不會降級。
- Demo 複製：來源案件必須帶 `deliveryMode` 與 `_count`（同版 `GET /api/cases` 匯出）；records 模式或任何交付／送審證據 → preview `delivery_records_not_supported`，缺標記 → `delivery_markers_missing`，import 一併拒絕（不剝除後偽裝 legacy）。
- 通知只在交易成功後送出、重送不重發；不保證 exactly-once（通知失敗不回滾已成立的送審／決議）。

### 時程受控與改期申請（REPORTS-P2-D1a，後端，預設關閉）

規則（Mark 2026-10-26 確認）：主案四個里程碑 `dispatchDate`、`copyDate`、`printDate`（送印日）、`goLiveDate` 任一延後都須主管核准；提前須留具體原因；清除已填的可選日期（copyDate／printDate）也須核准（防繞過）；原本未填的可選日期補上只需原因，導入前未記錄的日期維持未知。子案件日期不在本批。原因分類只供申請與查閱，不代表免責、不改 KPI 分母或完成量。

開關：`SCHEDULE_WORKFLOW_ENABLED=1`。案件欄位 `scheduleMode` 為 `legacy`／`managed`，與 `deliveryMode` 互相獨立；既有資料一律 legacy；managed 單向（DB 觸發器）。關閉開關不會讓 managed 案退回：新導入／申請／核准回 409 `schedule_workflow_paused`（導入 404 `feature_disabled`），歷史可讀，撤回與退回仍可用，PATCH 日期守衛照常生效。

- `GET /api/cases/:id/schedule-requests`：可見案件皆可讀；`{ mode, status, archived, updatedAt, contentVersion, schedule, baseline, adoption, pendingRequestId, reasonCategories, workflow:{workflowEnabled, paused}, requests:[{ id, status: pending|approved|rejected|withdrawn|invalidated, requestedBy…, reasonCategory, reason, impactFrom, impactTo, currentSchedule, proposedSchedule, caseUpdatedAt, caseContentVersion, assignmentSnapshot, decidedBy…, decisionReason, approvedSchedule }] }`。舊制案件無歷史且開關關閉時 404。`baseline` 是「導入當下觀測到的日期」（`source:'observed_at_adoption'`），不是歷史原始承諾。
- `POST /api/cases/:id/schedule-mode/adopt`（admin）：`{ requestId, reason, expectedUpdatedAt, expectedContentVersion }`；僅未封存、未結案、未取消的 legacy 案；同交易記導入章、基準與稽核。同 requestId＋同原因 200 replay；不同內容 409 `schedule_request_conflict`；已受控 409 `already_managed`；不符資格 409 `case_locked`。
- `POST /api/cases/:id/schedule-requests`（admin／主負責人／協作者，交易內重讀）：`{ id, reasonCategory, reason, proposedDates:{dispatchDate?, copyDate?(可 null), printDate?(可 null), goLiveDate?}, impactFrom?, impactTo?, expectedUpdatedAt, expectedContentVersion }`。正式日期不變；保存原時程、完整提案、瀏覽器版本與指派快照；案件記 `pendingScheduleRequestId`、版本 +1。每案同時最多一筆（DB 部分唯一索引）。待交付核可中 409 `delivery_pending_review`；已有待決 409 `schedule_request_pending`；與正式時程相同 422 `schedule_no_change`。
- `POST …/schedule-requests/:rid/withdraw`：`{ operationId, reason, versions }`（目前指派者）。
- `POST …/schedule-requests/:rid/decide`（admin）：`{ operationId, decision:'approve'|'reject', reason?, versions }`。退回須具體原因（422 `reject_reason_required`）。核准時正式時程與主責／協作者須仍等於申請快照，否則 409 `schedule_base_changed`（不會套到新時程上，請退回重新申請）；核准只套用該不可變提案一次，日期、決議、指標清除、版本與逐欄稽核同交易。同 operationId 精確重送 200 replay；不同內容 409。
- 原因：2–500 字，不可只有符號／數字，不可是「—」「N/A」「看板拖曳」「改期」等動作佔位字。日期：嚴格 YYYY-MM-DD 真實日曆日（2000–2100）。缺版本 409 `client_update_required`；版本過期 409 `edit_conflict`。
- 受控案的既有 `PATCH /api/cases/:id`：追蹤欄位（狀態、四個里程碑、建案日更正、主責、協作者名單、等級、急件）異動須具體原因＋`expectedUpdatedAt`／`expectedContentVersion`（交易內重驗登入者與指派，版本 +1）；延後或清除里程碑 409 `schedule_approval_required`（含 `fields`）；有待決申請時改里程碑或送審／結案 409 `schedule_request_pending`；原始日期不是真實日曆日 400 `invalid_date`；送出值與讀取值相同的受保護欄位不寫入（協作者以穩定 ID 集合比較，順序／重複／含主責皆視為相同；真正 no-op 不寫入、不產生稽核）；協作者名單異動在交易內重驗目前的主責／管理者權限。舊制案件行為不變（日期寫入會鎖定讀到的 `scheduleMode`，與導入競爭時回 409）。
- 交付流程：有待決改期時，records 送審回 409 `schedule_request_pending`；取消案件會在同一交易把待決改期蓋章 `invalidated`；封存在有待決改期時回 409。刪案在有改期紀錄時回 409 `case_has_schedule_requests`。`GET /api/cases`、`GET /api/cases/:id` 的 `_count` 另含 `scheduleRequests`。Demo 複製拒絕受控或含改期紀錄的來源（`schedule_history_not_supported`），缺標記拒絕（`schedule_markers_missing`）。本批不寄通知或信件。

### 生命週期：未完成封存與原案號復工（REPORTS-P2-D1b，後端，預設關閉）

規則（Mark 2026-10-26 確認）：未完成封存＝設計師（目前主責／協作者，管理者可代提）申請、主管核准；可明確聲明「無可歸檔檔案」並附原因。復工＝同一案號，設計師申請、主管核准。封存不算完成也不算取消；產出、正式日期、逾期與既有證據保留；原因分類不代表免責、不改 KPI。

開關 `LIFECYCLE_WORKFLOW_ENABLED=1`。`lifecycleMode` legacy／managed 與交付／時程模式互相獨立，單向；`lifecycleStatus` active｜sealed_incomplete｜completed｜cancelled；`currentCycleId` 指向同案週期。

- `GET /api/cases/:id/lifecycle`：一次一致快照（案件＋週期＋申請＋交付）；`outputs.currentCycle`（本期，導入前歸屬未知時 `partially_unknown`）、`outputs.cumulative`（每筆交付 ID 只算一次）、`legacyCounts` 另列不相加。
- `POST /api/cases/:id/lifecycle/adopt`（admin）`{ requestId, reason, expectedUpdatedAt, expectedContentVersion }` → 週期 1（導入時觀測、既有交付歸屬未知）。
- `POST /api/cases/:id/lifecycle/requests` `{ id, kind:'seal'|'resume', reasonCategory, reason, evidence?:{type:'archive', archivePath}|{type:'no_file', reason}, expectedUpdatedAt, expectedContentVersion, expectedCycleId }`；`…/:rid/withdraw` `{ operationId, reason, versions, expectedCycleId }`；`…/:rid/decide`（admin）`{ operationId, decision, reason?, versions, expectedCycleId }`。封存須無待決交付送審／改期；封存證據的歸檔位置須等於已儲存位置。核准前重比對狀態／時程／指派／歸檔／有效交付，否則 409 `lifecycle_base_changed`。封存核准：週期結束為 sealed_incomplete、`archived=true`、狀態與日期不變、無 closedOn。復工核准：新增序號＋1 週期、`status='doing'`、`archived=false`、正式日期不變。
- 受控案所有瀏覽器寫入（PATCH、items、logs、交付、送審、改期、生命週期、取消、轉派、legacy 核可）都需 `expectedCycleId`（409 `client_update_required`／`cycle_conflict`）。sealed 全部唯讀（`lifecycle_sealed`）；有待決封存／復工時證據類寫入 409 `lifecycle_request_pending`（日誌可寫）；completed／cancelled 唯讀（`lifecycle_closed`），唯一例外是 completed 的舊版結案數量更正；不提供重新啟動（`lifecycle_reopen_unavailable`）。完成（PATCH 終態、legacy 核可、records 核可）與取消在同一交易以 completed／cancelled 結束週期。archive 不能代替封存（`lifecycle_seal_required`）；clone 不能代替復工（`lifecycle_resume_required`）。新交付歸屬目前週期；前期交付不可經一般作廢／更正修改（`delivery_previous_cycle`）。刪案 409 `case_has_lifecycle_history`；Demo 複製拒絕（`lifecycle_history_not_supported`／`lifecycle_markers_missing`）。不寄通知或信件。

### D2 操作畫面、讀取整合與成員更新通知（REPORTS-P2-D2）

- 讀取：`GET /:id/schedule-requests`、`GET /:id/deliveries`、`GET /:id/delivery-submissions` 另回與版本同一列讀取的 `lifecycleMode`、`lifecycleStatus`、`currentCycleId`（後兩者另含 `pendingLifecycleRequestId`）；`GET /:id/lifecycle` 另回 `reasonCategories`；analytics `workCases` 另回 `lifecycleMode`／`lifecycleStatus`。
- `GET /api/cases/pending-requests/list`（admin）：有待決改期或封存／復工申請的案件（含已封存 archived 的復工申請），附申請種類與原因；決議在案件抽屜進行。
- 成員更新通知：`GET /api/notices`（`{ staffId, notices:[{id,title,items,dismissed,dismissedAt}], pending }`，只含 `RELEASE_NOTICES_PUBLISHED` 列出的白名單公告；預設空）；`POST /api/notices/:id/dismiss`（身分只取自登入 session；`expectedStaffId` 僅為前提檢查，不同則 409 `notice_actor_changed`；重複關閉冪等；未發布或不存在 404）。觀察者可關閉自己的公告（僅精確的 `POST /api/notices/:id/dismiss` 免除唯讀攔截；全域攔截與 `requireAuth` 兩處一致，其他觀察者寫入仍 403）。公告內容在 `src/lib/releaseNotices.js`，只寫一般成員可用功能，不含主管功能或 HTML。
- 前端：`public/case-lifecycle.js`／`.css`（抽屜「時程與週期」、受控案件寫入綁定使用者所見快照、看板受控案件改開抽屜、審核中心改期／封存／復工清單）、`public/release-notice.js`（每帳號每版本一次；按鈕／×／Esc／背景同一關閉流程；失敗可重試；頂端「更新紀錄」可重讀）。

## Staff

### `GET /api/staff`

Query: `?includeInactive=1` (default: 只列在職)

回陣列，每筆含 `workload`（即時計算）。

### `GET /api/staff/workload`

`[ { id, name, seniority, score }... ]`，按 score 升序（最閒的在前）。

### `POST /api/staff` · Admin

```json
{
  "name": "Tester", "email": "tester@company.com",
  "joined": "2026-04-01", "seniority": "mid",
  "roleTitle": "設計師", "role": "member",
  "password": "..." // 可選，未填則用 SEED_DEFAULT_PASSWORD
}
```

Response 201 含 `tempPassword`（若沒傳 password）。Response 409 若 email / name 重複。

### `PATCH /api/staff/:id`

自己或 admin 才能改。`role` 只有 admin 能設。

### `GET /api/staff/:id/departure-preview` · Admin

預覽離職影響：

```json
{
  "leaver": { "id", "name", "joined", "seniority" },
  "toArchive":    [ { "id": "B-...", "title": "..." }, ... ],
  "toTransfer":   [ { "id", "title", "level", "status", "goLiveDate",
                      "collaborators": [...], "suggestion": { "id", "name", "seniority", "score" } }, ... ],
  "toRemoveCollab": [ { "id", "title", "designerId" } ]
}
```

### `POST /api/staff/:id/departure` · Admin

```json
Request: { "successors": { "A-2026-04-019": 3, "SS-2026-04-002": 7, ... } }
```

每個 `toTransfer` 的 caseId 都要給一個 successor staff id，否則 400。

交易內：封存已完成案件、轉派未完成案件（附 TransferLog）、解除協作、`staff.active = false`、`departedOn = now`。

Response:
```json
{ "ok": true, "transferred": [...], "archived": [...], "removedCollab": [...] }
```

### `DELETE /api/staff/:id` · Admin

僅能刪除已離職（`active: false`）者。

---

## Analytics · v3.3

### `GET /api/analytics` · Admin

Query：

| 參數 | 預設 | 說明 |
| --- | --- | --- |
| `period` | `month` | `week` / `month` / `half` / `year`，自然週／月／半年／整年 |
| `offset` | `0` | `0` = 本期、`-1` = 上一期、`-2` = 上上期…（`-52`～`0`） |
| `staffId` | — | 只取單一同仁的彙總（不傳則所有人） |

回應：

```json
{
  "period": { "period": "month", "offset": 0,
              "start": "2026-04-01T00:00:00.000Z",
              "end":   "2026-05-01T00:00:00.000Z",
              "label": "2026-04" },
  "totals": { "count": 12, "score": 47.3, "onTimeRate": 0.83,
              "byLevel": { "SS":1, "S":2, "A":4, "B":3, "C":2, "D":0 } },
  "perStaff": [
    {
      "staffId": 2, "name": "Sunny", "seniority": "senior",
      "primary": { "count": 4, "score": 16.9 },
      "collab":  { "count": 1, "score": 0.8 },
      "totalCount": 4, "totalScore": 17.7,
      "onTimeCount": 3, "overdueCount": 1, "onTimeRate": 0.75,
      "urgentCount": 1,
      "byLevel": { "SS": 0, "S": 1, "A": 2, "B": 1, "C": 0, "D": 0 }
    }
  ],
  "cases": [
    { "id": "A-2026-04-019", "title": "...", "level": "A",
      "urgent": false, "onTime": true, "score": 3.3,
      "designerId": 3, "designerName": "Milo", "collaboratorNames": ["Agnes"],
      "goLiveDate": "...", "closedOn": "..." }
  ]
}
```

公式（全加權）：

```
score(case, role) = LEVEL_WEIGHT[level]
                  × ROLE_COEF[role]      // primary 1.0 / collab 0.4
                  × TIMELY_COEF(case)    // 準時 ×1.1 / 逾期 ×0.8
                  × URGENT_COEF(case)    // 急件 ×1.3 / 一般 ×1.0
```

僅計入 `status === 'done'` 且 `closedOn` 落在 `[period.start, period.end)` 內的案。

---

## Work reports · REPORTS-P3-E1b · Admin

隔離於 `/api/work-reports`。全部端點需登入（真 session）且為管理員；觀察者、成員、停用、未啟用、session 已撤銷一律拒絕。產生與修訂在發布交易內再次鎖定並確認操作者仍為在職、已啟用的管理員且 sessionVersion 未變（同時被降權／撤 session／停用時回 403／401，不保存）。GET 不寫入。未知的 body／query 欄位（例如偽造的 role、actorId）回 400。

期間為台北自然週（週一起）／月／季，日期半開 `[startDate, endDateExclusive)`；C＝endDateExclusive 台北 00:00 的真實時刻。初版 K＝C；修訂 K＝DB 目前時間。C 決定期末狀態、主責／協作、時程、館名館序與人名；K 決定已知的期間交付、進度與作廢更正。無法證明的總數為 `null`（另給 `knownSubtotal`），未知不當 0。

### `GET /api/work-reports/periods?kind=&from=&to=`
最多 60 期；每期含 `startInstant`、`cutoffInstant`、`ended` 與已有版本的 meta。

另附唯讀的 `coverage: { coverageStart, observedAt }`（REPORTS-P3-E3a，附加欄位，既有欄位不變）。它與 DB 時鐘在同一個查詢中讀取，只 SELECT `report_source_coverage` 的 id 1，不建立快照、不寫入。`coverageStart` 為 null 表示尚未建立歷史追蹤起點。

畫面用它在產生前預估可用性：

| 條件 | 預估 | 畫面行為 |
|---|---|---|
| C < coverageStart | 只會資料不足 | 不提供產生 |
| S < coverageStart ≤ C | 部分可重建 | 可產生 |
| coverageStart ≤ S | 時間上涵蓋整期 | 可產生；期間內刪除的案件仍可能使報告只有部分 |

舊伺服器沒有這個欄位時，畫面不預估，也不阻擋。發布規則與排程契約都不變。

### `GET /api/work-reports/history?kind=&start=`（REPORTS-P4-E4）
唯讀的「歷史工作回顧（依現有資料）」，不是正式報告。同一管理員守門；query 為 strict；回應帶 `Cache-Control: no-store`。

- **讀取方式**：在一個 RepeatableRead `READ ONLY` 交易裡讀目前仍保存的資料，observedAt 取 DB 時鐘。不建立快照或版本，不寫入，不碰 coverage 或排程。
- **結果性質**：不是當時的期末狀態；之後補登或更正會改變結果；已刪除的資料無法還原。館別、主責／協作、狀態都是目前值。
- **列入依據**：
  - `evidence`：期間內有有效日期的主案或子項目日誌、未作廢交付、狀態變更紀錄、工作週期重疊、完成的週期，或目前結案且 closedOn 落在期間內；
  - `inferred`：只有日期區間推估；
  - `unresolved`：日期不足，另列，不計 0。
- **結案紀錄**：每案只計一次，不是完成總數。
- **交付**：依 kind×unit 的已記錄小計。只有在全部列入案件都是明細制、涵蓋整期，且沒有待確認案件時，才給 total。
- **上限**：
  - 載入 JSON 前，先以 SQL 預檢候選案件數（≤ 5000）與 logs/items 原始 JSON 位元組（≤ 8 MB）；
  - 回應本身 ≤ 8 MB；
  - 超過任一上限回 422 `history_too_large`。
  - 每案進度只預覽 200 筆、每則 500 字，都帶截斷旗標；總筆數、摘要與最近紀錄日都依全部筆數計算。
- **錯誤**：期間尚未開始回 422 `period_not_started`。

### `GET /api/work-reports?kind=&start=`
該期間所有版本的 meta（依規則版本、revision 排序）。

### `GET /api/work-reports/:id?hotel=&staffId=`
無篩選：`{ snapshot, payloadSha256, payload }`（讀取時重算 canonical hash，不符回 500 `snapshot_integrity_failed`）。有篩選：`{ snapshot, payloadSha256, view: { filter, derivedFrom, viewSha256, payload } }`——view 只由已存 payload 篩選並以同一純函式重算 summary，`viewSha256` 是這個 view 的雜湊，`payloadSha256` 仍是原版本。`hotel` 為 `hotelOrder[].key`（`hotel:<id>`、`unmatched:<原值>`、`none`、`not_recorded_at_cutoff`）；`staffId` 為「期末（C）指派參與的案件」（主責或協作；K-only 列以標示的 K 指派），不是個人產出分攤。

### `POST /api/work-reports/generate`
Body `{ periodKind, startDate, idempotencyKey }`（rulesVersion 由伺服器固定）。201 `{ snapshot, replayed:false }`；同 key 同內容 200 replayed；同 key 不同內容／操作者／動作 409 `idempotency_conflict`；期間未結束 422 `period_not_ended`；已有初版 409 `report_exists`；來源未穩定 409 `source_not_settled`；逾時 503 `report_timeout`；過大 422 `report_too_large`（皆不保存）。

### `POST /api/work-reports/:id/revisions`
Body `{ reason, expectedLatestRevision, idempotencyKey }`，原因沿用既有具體原因驗證。只能對該期間最新版本續修訂：非最新 409 `not_latest_revision`、預期版本不符 409 `revision_conflict`；同 key 重送在已有更新版本後仍回放原結果。舊版本 payload 與 hash 不變。

並行：同一新版本只會原子發布一份；落敗請求依唯一鍵或 PostgreSQL 序列化錯誤重讀後回放或回明確 409，不回裸 500。

### `GET /api/work-reports/scheduler/status`（REPORTS-P3-E3）
只讀，同樣需真 admin session；不接受任何 query（有參數回 400），不寫入。回 `{ enabled, configuredStartDate, now, rulesVersion, initialized, state:{status,pausedReason,epoch,startDate,activatedAt,startDateMatches,coverageMatches}|null, next:[{kind,startDate,endDateExclusive,label,dueAt}], counts, recent, attention }`；`attention` 列出 blocked 與重試中的 job（代碼、次數、下次嘗試），不含報告內容。

自動初版（`WORK_REPORT_SCHEDULER_ENABLED=true` 時由伺服器內部 worker 執行，**沒有任何 HTTP 端點可觸發或出版排程報告**）：每期結束後台北 00:05 起產生 revision 1，`trigger='scheduled'`、`generatedById/Name=null`、payload `generatedBy=null`，K=C。已有任何版本則略過（`skipped_existing`），不自動修訂、不覆蓋人工版本。人工 `generate`／`revisions` 的 `idempotencyKey` 不可以 `sched-` 開頭（400，該前綴保留給排程的穩定 key）。人工 generate 遇到排程初版一樣回 409 `report_exists`；對排程初版可照常建立人工修訂版。

前端：工作報告頁頁首下方一行顯示自動彙整狀態（未啟用／已啟用與下一次到期／已暫停／需維運處理的 job），排程版本的「產生」欄顯示「系統自動彙整」，CSV 另有「產生方式」列，「產生者」欄維持空白。

**前端（REPORTS-P3-E2）**：`public/work-reports.js`／`.css`，管理員側欄「工作報告」。只在真實 `ME.role=admin` 且目前為管理員視角（無 view-as、非觀察者預覽）時可進入與操作；伺服器仍是權限邊界。畫面、兩個輔助 bar 圖（本期交付依種類×單位、列入案件的期末狀態）、館別分組明細與 CSV 一律取自同一份已載入的快照或篩選 view，不讀即時案件補洞；`total=null` 只顯示「已知部分」，insufficient 顯示「期末來源資料不足」且不畫圖。產生／修訂不自動重送：每次新操作一個穩定 `idempotencyKey`，結果不明（逾時、5xx、非 JSON、缺 `snapshot.id` 的 2xx、`source_not_settled`）保留原 body＋key，由使用者明確「以同一請求重試」；409 衝突提示重新載入，不換 key 自動重建。CSV 為 UTF-8 BOM＋CRLF，含快照 ID／版本／C／K／完整性／篩選／兩種雜湊，使用者文字做公式注入防護，種類與單位各自一欄。

## Notifications

### `GET /api/notifications`

Query: `?unread=1`

回自己的通知，最新 200 筆。

### `GET /api/notifications/unread-count`

`{ "count": 3 }`

### `POST /api/notifications/:id/read`

### `POST /api/notifications/read-all`

---

## 錯誤格式

所有錯誤都回 JSON：

```json
{ "error": "...", "message": "...", "issues": [...] }
```

| 狀態碼 | 意義 |
| --- | --- |
| 400 | 請求格式錯（`invalid_body`） |
| 401 | 未登入或 token 無效 |
| 403 | 已登入但權限不足（member 嘗試 admin 操作） |
| 404 | 資源不存在 |
| 409 | 衝突（email / name 重複） |
| 422 | 業務規則不符（如結案未填歸檔路徑、追蹤欄位變更未填 reason） |
| 500 | 伺服器錯（請看 Zeabur logs） |

---

## Health

`GET /healthz` — 不需驗證，`{ ok: true, ts: ISO8601 }`。可接 UptimeRobot。
