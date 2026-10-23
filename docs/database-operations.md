# 資料庫維護與回復

維護工具只在明確指令時執行，不由定時工作擅自套用。任何來源／目標先核對 environment、連線指向與備份；命令不輸出連線帳密、密碼雜湊、重設 token 或資料列內容。

## 完整備份

```bash
npm run db:backup -- /private-backups/release-unique-id
```

目的地必須是 Git repo 外全新的目錄。輸出目錄權限700、`database.dump` 和 `manifest.json` 權限600。archive 使用 pg_dump custom format，含帳號、密碼雜湊、JSON 日誌、協作與會議關聯、sequence 及 migration history；它是敏感資料，應依團隊政策加密保存、限權與到期刪除。不可上傳公開 issue／PR。

Manifest 記錄 archive SHA256、PostgreSQL／Node／Prisma 版本、來源目標指紋、每張表列數／摘要及 sequence。備份前後資料不一致會停止並刪除未驗證 archive；請在無人修改的時段重做。工具不輪替帳密、不修改業務資料。

## 隔離還原演練

建立全新、空的本機 PostgreSQL 資料庫，名稱必須以 `design_pm_restore_` 或 `design_pm_phase3_` 開頭。設定 DATABASE_URL 指向 loopback；維護工具拒絕非本機、非指定名稱或非空的還原目標。

```bash
# 在獨立 shell 設好還原目標 DATABASE_URL，不要沿用正式連線。
npm run db:restore-check -- /private-backups/release-unique-id/manifest.json
```

工具驗證 SHA256 後以單一交易還原，逐表比較完整資料摘要與 sequence。演練另應驗證外鍵／協作關聯、日期與 JSON、案件版號、登入的密碼驗證與可撤銷訂閱邏輯；移除 SMTP 設定，使用隔離的 JWT secret，不啟動對外流量。正式資料庫身分標記會一併保留，因此把正式備份還原到測試機，也不會自動獲准 Demo reset。

本機演練不能證明尚未取得的正式備份可用。發佈記錄必須區分「合成 fixture 演練」與「本次正式快照實際還原」。

## 既有資料庫 baseline

舊版使用 db push，沒有 `_prisma_migrations`。先執行 `npm run db:baseline`；預覽只接受與已審查舊版結構相同的差異，遇到缺欄位／未知結構不會自行修補。

通過完整備份與隔離還原演練後，在原資料庫執行：

```bash
BASELINE_CONFIRM='BASELINE EXISTING DATABASE' npm run db:baseline -- /private-backups/release-unique-id/manifest.json --apply
npm run db:deploy
```

只有 baseline metadata 先被記錄；業務表不重建。然後 migrate deploy 套用已提交且可審查的增量 SQL。結構漂移、備份目標或資料摘要不符，都先停止調查，禁止以 reset 繞過。

## 獨立資料庫身分

`deployment_identity` 是單筆、不可任意 UPDATE／DELETE／TRUNCATE 的環境標記；由操作者核對資料庫後獨立建立，網站啟動與重設腳本不建立或改寫它。instance UUID 是識別資料，不是登入憑證。

```bash
# UUID 由操作者事先產生並保存，environment 可為 production / demo / restore。
IDENTITY_CONFIRM='PROVISION DATABASE IDENTITY' npm run db:identify -- demo '<已核對的UUID>' --apply
```

Demo reset 另外要求：精確 Demo APP_BASE_URL、DEMO_SEED=yes、DEMO_RESET_CONFIRM='RESET DEMO DATABASE'、DEMO_INSTANCE_ID 與資料庫標記相符，以及明確的強 DEMO_PASSWORD。任一不符都拒絕。清除與完整重建共用一個交易，失敗不留下半套資料。**此命令只供已確認可以丟棄的 Demo 資料，禁止用在正式機或一般發佈。**

## 真實災難回復

停止應用寫入，保存事故當下快照，再由負責人核對要回復的時間點與遺失範圍。先還原到獨立目標並完成驗收，才決定切換；不要直接覆蓋唯一一份正式資料庫。

回復舊帳號資料可能恢復舊的 sessionVersion、calendarVersion、啟用與重設 token。正式重新開放前，必須依事故範圍安排撤銷舊會話與訂閱、清除不該復活的 token，必要時輪替簽章密鑰並通知重新登入；這是人工核對的回復步驟，工具不擅自執行。確認資料、權限與對外通知後才恢復 SMTP／流量。
