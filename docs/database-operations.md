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

## 0003 交付明細（REPORTS-P1-A）

`0003_case_deliveries` 只新增 `case_deliveries` 表、索引、RESTRICT 外鍵、CHECK 與觸發器；不讀寫、不回填任何既有列。套用方式與其他 migration 相同：先完成新的完整備份與隔離還原演練（不能沿用舊證據），再以 `db:deploy` 執行；不要 `db push`、reset 或手動改表。

- 紀錄為只增不刪的證據：唯一允許的 UPDATE 是一次性作廢戳記；DELETE／TRUNCATE 會被觸發器拒絕。案件有交付紀錄時無法刪除（含併發）。
- 只有明確的全站重設（admin factory reset、Demo reset）會在同一交易內 `SELECT set_config('design_pm.allow_delivery_purge','on',true)` 後先刪交付再刪案件；此開關僅限該交易。
- 備份／還原沿用既有指令，`case_deliveries` 由動態表清單自動納入，觸發器與約束一併還原。
- `legacy-upgrade-preflight.sql` 已同步新增此表；未經 migration 歷史的舊庫 baseline 仍須先比對通過。
- 交付 API 預設關閉（`DELIVERY_RECORDS_ENABLED`）；套用 0003 不會改變現有畫面或送審行為。

## 0004 送審依據（REPORTS-P1-C1）

`0004_delivery_submissions` 只新增：`cases` 的 `deliveryMode`（預設 legacy，既有列不重寫）與導入章／待審指標欄位、`case_delivery_submissions` 表、索引、RESTRICT 外鍵、null-safe CHECK（決議章與導入章「全空或全有效」）、兩個觸發器（送審依據只增、決議章只蓋一次；records 模式單向且導入章不可改）。套用前同樣需新的完整備份＋隔離還原演練，再 `db:deploy`。

- 全站重設（factory reset、Demo reset）在既有 `design_pm.allow_delivery_purge` 交易內先刪送審、交付，再刪案件；未新增其他繞過。
- `legacy-upgrade-preflight.sql` 已更新為真實舊庫對目前 schema 的 `migrate diff` 輸出（含 0003／0004）。
- 還原演練目標名稱另接受 `design_pm_delivery_<字母>_*`（仍限 loopback 與空庫），供交付批次隔離測試使用。
- 開關 `DELIVERY_WORKFLOW_ENABLED` 預設關閉；套用 0004 不改變既有畫面或 legacy 流程。

## 真實災難回復

停止應用寫入，保存事故當下快照，再由負責人核對要回復的時間點與遺失範圍。先還原到獨立目標並完成驗收，才決定切換；不要直接覆蓋唯一一份正式資料庫。

回復舊帳號資料可能恢復舊的 sessionVersion、calendarVersion、啟用與重設 token。正式重新開放前，必須依事故範圍安排撤銷舊會話與訂閱、清除不該復活的 token，必要時輪替簽章密鑰並通知重新登入；這是人工核對的回復步驟，工具不擅自執行。確認資料、權限與對外通知後才恢復 SMTP／流量。

## REPORTS-P2-D1a：0005_schedule_requests

- 增量：`cases` 新增 `scheduleMode`（預設 legacy）、導入章、`scheduleBaseline`、`pendingScheduleRequestId`；新表 `case_schedule_requests`（FK RESTRICT）。既有列不改寫，全部維持未受控的 legacy。
- 約束：NULL 安全的導入章／基準 CHECK（基準必須含四個主案里程碑與 `source:'observed_at_adoption'`）；申請內容、原因、影響區間與時程快照 CHECK；決議一次性 CHECK（核准時 `approvedSchedule` 必須等於提案）；每案最多一筆待決的部分唯一索引；申請只增、決議只能蓋一次章；DELETE／TRUNCATE 只在既有的交易內 `design_pm.allow_delivery_purge` 開關下允許（admin 全量重設、Demo seed）；managed 單向。
- `legacy-upgrade-preflight.sql` 以真實 0001 舊庫對目前 schema 的 `migrate diff` 重新產生（含 0005）。維護腳本動態列出所有資料表，備份／還原自動涵蓋新表。演練只用 `design_pm_delivery_d_*` 合成資料庫。

## REPORTS-P2-D1b：0006_case_lifecycle

- 增量：`cases` 生命週期欄位、`case_cycles`、`case_lifecycle_requests`、`case_deliveries.cycleId`（既有列為 null＝歸屬未知，不回填）。
- SQL-only（schema.prisma 未建模）：同案複合外鍵（案件→目前週期／待決申請為 deferred NO ACTION，子表→案件維持 RESTRICT）、NULL 安全 CHECK（含快照必要鍵）、部分唯一（每案一個開放週期、一筆待決申請）、只增觸發器、單向／狀態轉換觸發器、提交時圖一致性 constraint trigger、鎖定案件列的交付歸屬觸發器、三種待決指標互斥。不可用 db push 或未審 migrate diff 重建。
- 完整重設（admin reset、demo-seed）在同一交易依序刪除申請、交付、週期、案件；`legacy-upgrade-preflight.sql` 以真實 0001 舊庫重新產生；維護腳本動態涵蓋新表。演練只用 `design_pm_delivery_e_*`。

## REPORTS-P2-D2：0007_member_notice_dismissals

- 增量：`member_notice_dismissals`（staffId FK ON DELETE CASCADE、noticeId CHECK、每帳號每公告唯一）。已讀紀錄不是業務證據，隨帳號刪除；admin reset／demo-seed 刪除人員時一併清除。
- `legacy-upgrade-preflight.sql` 以真實 0001 舊庫重新產生（含 0007）；維護腳本動態涵蓋新表與其序列。演練只用 `design_pm_delivery_f_d2_author_*`。

## REPORTS-P3-E1a：0008_report_sources

報表來源版本（只建來源基礎；報表快照、API、介面與排程屬後續批次）。只新增，不改任何業務列。

- `report_source_events`：白名單觸發器在來源列更新後（持有列鎖時）寫入。來源表（真實表名）：`cases`、`_collaborators`（A=caseId、B=staffId）、`case_deliveries`、`case_cycles`、`case_lifecycle_requests`、`case_schedule_requests`、`case_delivery_submissions`、`staff`、`hotels`，以及 `change_logs` 中只限四個里程碑欄位（dispatchDate/copyDate/printDate/goLiveDate）的列——受控案件提前／新增日期的具體原因只記在這裡。
- 每張表的投影函式逐欄列出（`report_project_*`），不使用 `row_to_json`。`staff` 只記 id、name、role、active、departedOn，永遠不記 email、密碼、啟用／重設 token 及到期、sessionVersion、calendarVersion。沒有白名單欄位變動就不寫事件；U 只含有變的欄位並保留明確 null；D 是 tombstone；ChangeLog 列移入或移出里程碑集合時轉成 I／D。`cases.updatedAt`／`createdAt` 是來源列本身的欄位（只供顯示「上次更新」），不是事件時間。
- 事件 id 由序列 `report_source_events_id_seq` 分配（CACHE 1、NO CYCLE）。只能由觸發器帶預設值取得，不可手填、預取或重設；`capturedAt` 是 DB `clock_timestamp()`，`transactionId` 是完整 64 位交易 ID，兩者都由 guard 強制寫入。
- 時間語意：一筆交易的 effectiveRecordedAt＝它所有來源事件的最大 capturedAt（「交易最後一筆報表來源異動的系統記錄時間」，**不是 commit 時間**）。讀取時先在同一 REPEATABLE READ 快照內對全部可見事件依交易分組，再以 `< cutoff` 選整筆交易、依事件 id 重播；跨截止的交易整筆歸後側。
- 一致讀取（`src/lib/reportSources.js`）的順序是：先由 DB 時鐘固定知識截止 K；再 `settle(K)`；之後才開新的 RR 快照讀取。`settle(K)` 會先 `pg_stat_clear_snapshot()`，再看同一資料庫中除自己以外的 client 連線：
  - 只要有 xact_start 早於 K 的交易（包括 idle in transaction）就等待，等待有上限；
  - 看不到交易資訊的連線，或有 2PC prepared transaction，直接回 `source_not_settled`。

  前提如下：單一應用程式 DB role、不使用 2PC、DB 牆鐘不會倒退。`clock_timestamp()` 不保證單調；明顯不一致時（事件或 coverage 晚於 DB 目前時間）會 fail closed，但無法完全排除時鐘倒退。正式啟用前須明示此限制，並能停止產生。多 role 的可見性只在單一 superuser 隔離環境驗過，沒有改權限來測。
- `report_source_coverage`（單列）：migration 在同一交易內先鎖住全部來源表，然後依序做三件事：
  1. 建立觸發器；
  2. 以 READ COMMITTED 新鮮快照為每一列寫入 B baseline；
  3. 最後以 DB 時鐘記錄 `coverageStart`。

  早於 coverageStart 的截止一律回「資料不足」，不以目前狀態推造。`report_source_baseline()` 有兩條限制：非 READ COMMITTED 呼叫會被拒絕；已有 coverage 時，只能在明確的報表 purge（`design_pm.allow_report_purge=on`）且舊事件已清空時重建。
- 只增保護：事件與 coverage 不可 UPDATE、DELETE、TRUNCATE，只有明確的報表 purge 可以 DELETE 事件。十張來源表一律禁止 TRUNCATE，包括原本在 `allow_delivery_purge` 下可清除的證據表，以免繞過記錄。
- 管理者全站重置（`POST /api/admin/factory-reset`）在同一交易內依序：刪除並重建資料、開啟報表 purge、刪除舊事件、重建 baseline 並重設 coverage。任一步失敗就整個回滾。
- 維運：`prisma/legacy-upgrade-preflight.sql` 以真實 `migrate diff` 重產（只新增兩表與索引）；`prisma/seed.js` 的空庫判定加入 `reportSourceEvent`（coverage 單列不算業務資料）。現有 backup／restore 會連同新表、序列與觸發器完整還原（真 PG drill 已驗證）。
- 不在本批：既有 writer 的 `voidedAt`／`endedAt`（app 時鐘）不修改，以事件的 capturedAt 判斷知識可見性；館名改名不連動 `Case.hotel`；事件保留與清理政策另列。


## REPORTS-P3-E1b：0009_report_snapshots

工作報告（週／月／季）的不可變快照與修訂。只新增 `report_snapshots`，不改 0001–0008、不改任何業務列或來源事件（真 PG：0008→0009 前後業務表、事件、coverage、序列逐表 digest 相同）。

- 欄位：期間（periodKind、startDate、endDateExclusive）、`cutoffInstant`（C＝endDateExclusive 台北 00:00 的真實 instant）、`knowledgeCutoff`（K）、`observedAt`、`generatedAt`（DB `clock_timestamp()`，由觸發器蓋，不接受呼叫端值）、`coverageStart`、`rulesVersion`、`revision`、`supersedesId`、`revisionReason`、`generatedById/Name`、`trigger`（manual；scheduled 為 E3 預留）、`idempotencyKey`、`requestFingerprint`、`payload`、`payloadSha256`、`sourceCompleteness`、`endStateMaxEventId`／`knowledgeMaxEventId`（C、K 兩份來源分列）。
- SQL-only 約束：週一／每月 1 日／季首對齊且 end 正確；C 必為台北午夜；K ≥ C、observedAt ≥ K、generatedAt ≥ observedAt；初版無 parent／原因，後版必有；parent 必為同期間同規則版本、相鄰 revision、K 不倒退；唯一 (periodKind,startDate,rulesVersion,revision) 與 idempotencyKey；payload 必要鍵（meta、sourceCompleteness、summary、rows、unresolved、hotelOrder、staff）與 status／rulesVersion／revision 一致（整段 `IS TRUE`，缺鍵不會因 NULL 放行）。`payloadSha256` 在 SQL 只驗格式，與 canonical JSON 的一致性由 service 計算並在讀取時驗證。
- 不建任何外鍵指向可刪的 Case／Staff／Hotel；只有 `supersedesId` 自連（NO ACTION，不連鎖刪除）。改名、刪案不改舊報告。
- 不可 UPDATE；DELETE 只在明確全站 purge（`design_pm.allow_report_purge=on`）；TRUNCATE 一律拒絕。管理者全站重置在同一交易內先清 snapshots，再清來源事件與重建 baseline。Demo reset 與 E1a 同：保留報表歷史（快照照原樣可讀）。
- 時間欄位一律以 SQL 微秒字串讀寫（`src/lib/workReports.js`），Prisma model 只建標量欄位供計數與 schema 對齊，不用 Prisma DateTime 讀寫。
- 維運：`prisma/legacy-upgrade-preflight.sql` 以真實 0001 舊庫 `migrate diff` 重產（只新增一表兩唯一索引）；`prisma/seed.js` 空庫判定加入 `reportSnapshot`；備份／還原動態涵蓋新表，真 PG drill 驗證兩個版本（含微秒時間、payload、hash、版本鏈）完全還原且不可變保護仍生效。
- 本批不含前端、CSV、圖表、排程或 JobRun。

## REPORTS-P3-E3：0010_report_jobs（自動週／月／季初版）

只新增兩張空表，不改 0001–0009、業務列、來源事件／coverage 或既有快照（真 PG：0009→0010 前後逐表 digest 相同，既有快照 hash 不變）。

- `report_job_runs`：每個 (periodKind, startDate, rulesVersion) 一筆，穩定 `idempotencyKey`（`sched-<kind>-<YYYYMMDD>-<rules hash>`）、`status`（pending／running／succeeded／skipped_existing／blocked）、`attemptCount`／`maxAttempts`、`nextAttemptAt`、租約（leaseToken／leaseOwner／leaseUntil）、`snapshotId`（外鍵 → report_snapshots，NO ACTION）、`lastErrorCode`、人工重試次數與原因、`epoch`。SQL-only：期間對齊、`dueAt`＝台北 00:05（C＋5 分）、狀態／租約／快照／完成時間一致性 CHECK；時間由 DB 時鐘蓋；身分欄不可改；完成（succeeded／skipped_existing）後不可再改；DELETE 只在明確全站 purge；TRUNCATE 一律拒絕。
- `report_scheduler_state`（單列）：首次啟用時寫入 `startDate`（設定的下界）、`activatedAt`（DB 時鐘）、`coverageStart`（當時的來源 coverage＝epoch）、`epoch`、各期別游標、`status`（active／paused）與暫停原因。idle 檢查不寫 heartbeat 或游標（不破壞備份前後摘要比對的安靜期）。
- 全站重置（admin factory reset）在既有 purge 交易內先刪 job（外鍵），再刪快照與來源事件、重建 baseline；排程狀態保留，下一次檢查發現 coverage 已變即暫停（只寫一次），須明確重新初始化。Demo reset 不動報表歷史與排程。
- `prisma/seed.js` 空庫判定加入 `reportJobRun`、`reportSchedulerState`；`legacy-upgrade-preflight.sql` 以真實 0001 舊庫 `migrate diff` 重產（只新增兩表三索引）。備份／還原動態涵蓋新表；真 PG drill 驗證 job、狀態、外鍵、CHECK 與觸發器完整還原且仍生效。

### 維運 CLI（`npm run reports:jobs -- …`）

不出版報告、不建立 job、不接受操作者／C／K。寫入需 `WORK_REPORT_JOB_CONFIRM`。

```bash
npm run reports:jobs -- status
WORK_REPORT_JOB_CONFIRM='RETRY WORK REPORT JOB' npm run reports:jobs -- retry <wj_…> --reason "<具體原因>"
WORK_REPORT_JOB_CONFIRM='REINITIALIZE WORK REPORT SCHEDULER' WORK_REPORT_SCHEDULER_START_DATE=<YYYY-MM-DD> npm run reports:jobs -- reinit --start-date <YYYY-MM-DD> --reason "<具體原因>"
```

- `retry`：只限目前 epoch 的一筆 blocked job，回到 pending（同 key，attempt 歸零，記錄原因）。先排除原因（例如資料庫時鐘、來源 coverage）再重試。
- `reinit`：排程暫停後（`coverage_epoch_changed`：全站重置／換庫；`clock_regressed`：DB 時鐘早於排程自己的寫入），或要刻意更改起始日時使用。須與伺服器設定的起始日相同；仍有有效租約的 job 時拒絕。新 epoch、游標重來、未完成 job 改回 pending，已完成 job 與其快照不變。
- 停用：把 `WORK_REPORT_SCHEDULER_ENABLED` 改回 false（或移除）並重啟；只停止後續認領，不改已存報告。執行中的 job 若被中斷，租約到期後由下一個程序以同一 key 接手（已提交的快照會被回放，不會出第二份）。
- 還原到別的環境：job 與快照一起還原、coverage 相同，因此一致；還原／測試機請保持排程關閉。換到另一個資料庫時，該庫第一次啟用即以其 coverage 建立自己的狀態。
- 前提沿用 E1a：單一應用 DB role、不用 2PC、DB 牆鐘不倒退；排程只看 DB 時鐘，不依主機時區。
