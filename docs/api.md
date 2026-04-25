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
