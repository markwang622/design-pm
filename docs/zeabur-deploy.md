# Zeabur 部署與升級

以 Dockerfile 為準：Node24.22.1、Prisma6.19.3、PostgreSQL。`runner` 內含 PostgreSQL18 client；備份前確認其版本不低於實際伺服器版本。

## 部署前

1. 檢查 Git 版本、`npm ci`、`npm test`、`npm run test:node24`、`npm audit`。
2. 確認正式與 Demo 服務各自對應正確的 Git branch、DATABASE_URL 與 APP_BASE_URL。不要把正式資料庫連線複製給 Demo。
3. 檢查 production 設定有效：保留現有安全 JWT_SECRET，APP_BASE_URL 使用本站 HTTPS origin，PORT 為有效整數。設定不足會在執行 migrations 前停止。
4. 現有資料庫依[資料庫維護](database-operations.md)完成完整備份與隔離還原驗證，再執行 baseline。API JSON／CSV 匯出不包含完整認證與關聯結構，不能替代完整備份。

本次包含兩個 migration：`0001_legacy_baseline` 記錄舊 Prisma5 結構；`0002_runtime_safety` 保留協作關聯資料並將唯一索引轉為主鍵，新增空的 deployment_identity 表與防誤改限制。沒有刪除業務資料的 SQL。

## 現有資料庫升級順序

先在 Demo 驗證，再對正式站重複同一流程。使用此版本的獨立維護容器／終端執行前置作業，先不要以尚未 baseline 的資料庫取代正在運行的舊版。

```bash
npm run db:baseline
npm run db:backup -- /private-backups/release-unique-id
# 將備份安全傳到隔離環境，建立全新還原目標，完成 db:restore-check。
# 再回到原本正確的資料庫，在安靜時段執行：
BASELINE_CONFIRM='BASELINE EXISTING DATABASE' npm run db:baseline -- /private-backups/release-unique-id/manifest.json --apply
npm run db:deploy
```

預覽只核對結構，不寫 metadata。套用時再次檢查備份 SHA256、來源目標、所有資料列摘要與 sequence，任何不符都停止。既有庫只記錄 baseline 已套用；**不執行 baseline 的 CREATE TABLE SQL，不 reset**。

完成後 Zeabur 可正常部署此 image；CMD 為 `node scripts/database-maintenance.mjs deploy && exec node src/index.js`。沒有 startup seed。

## 新安裝

全新空庫可直接 `npm run db:deploy`。之後依[本機開發](local-dev.md)的 bootstrap 參數，明確建立一位管理員；在正式安裝請設定正式 origin 與安全環境變數。不要使用範例密碼，也不把密碼放進指令記錄／Git。

## SMTP、密碼與行事曆

SMTP 已內建，不需再安裝套件或修改 notify.js。設定 SMTP_HOST、SMTP_PORT、SMTP_USER、SMTP_PASS、SMTP_FROM 與 SMTP_SECURE，從管理者診斷檢查。測試還原環境一律移除 SMTP 設定。

密碼在帳號頁更新／重設，不能從伺服器讀回原文。部署保留 JWT_SECRET，不輪替既有密碼或有效帳號。行事曆使用個人可撤銷訂閱 token，沒有共用公開固定 key。

## 發佈後與回滾

- 比對 `/healthz`、登入／角色邊界、版本資源、案件／人員／字典／排程資料，並檢查新增、轉派、審核與清單分頁。
- 保存發佈 commit、image digest、migration status、備份 manifest 與驗證結果。
- 一般應用回滾使用上一個已驗證 image。Prisma5 相容的舊程式可讀取本次保留的關聯資料；deployment_identity 是附加表。
- **不要回到含自動 db push／seed 的舊 CMD 操作已遷移資料庫。** 需要舊程式時使用已驗證的應用啟動指令 `node src/index.js`，不自動執行 schema 同步或播種。回滾不等於資料庫回復；真實資料損毀依維護文件在維護時段處理。
- 不用 `migrate reset`、`db push --accept-data-loss` 或 Demo reset 回滾正式資料。

## 自動工作報告排程（REPORTS-P3-E3）

正式站為 Google Compute Engine 常駐 VM（人工部署），排程是同一個 Node 程序內的 worker，不需外部 queue／Cloud Scheduler 或額外付費服務。

- 預設關閉。啟用需同時設定：`WORK_REPORT_SCHEDULER_ENABLED=true`、`WORK_REPORT_SCHEDULER_START_DATE=YYYY-MM-DD`（台北日期；計畫值 2026-10-28，以 root 最後核定為準）。值不合法時啟動前即停止（不印出值）。
- 以 2026-10-28 為起始日時，第一批到期：月報 2026-10（台北 2026-11-01 00:05）、週報 2026-W44（2026-11-02 00:05）、季報 2026-Q4（2027-01-01 00:05）。不掃起始日以前的歷史；更早期間仍由管理員手動產生。
- 先完成 0010 的新完整備份＋隔離還原驗證與 `db:deploy`，再設定旗標並重啟；以 `npm run reports:jobs -- status` 或工作報告頁的狀態列核對 `initialized`、`epoch`、下一次到期。
- 多個程序同時啟用也安全（DB 租約＋唯一鍵），但一般只需正式站一個程序啟用；Demo、還原與測試環境保持關閉。
- 停機後重啟會在一分鐘內補跑已到期的期間（每類每次最多 12 期、依時間排序）。異常與重試只在狀態列與 CLI 顯示，不寄信、不寫入成員公告。
