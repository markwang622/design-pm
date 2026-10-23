# Design-PM 維護工具包

這是可獨立安裝的備份、baseline 與隔離還原工具。沒有網站程式、啟動指令、seed、排程、`.env`、帳密或業務資料。安裝只執行 `prisma generate`，不連線資料庫、不套用 migration、不建立資料。

維護腳本、runtime 檢核、schema、migration SQL 與 preflight SQL 均逐位元複製自待發佈主程式；`SOURCE-MANIFEST.json` 記錄各檔 SHA256。此包保持原本相對路徑，執行時使用**此資料夾內固定的 CLI/client**，不會沿用 `/app` 的 Prisma 5.22。不要以未固定版本的 `npx prisma` 取代。

## 執行環境

- Prisma CLI 與 client 精確固定 `6.19.3`，dotenv 固定主程式現用 `16.6.1`，deepmerge-ts override `8.0.2`。
- 目前服務 Node `20.20.2` 符合 Prisma v6 對 Node20 的最低 `20.9.0` 要求。[Prisma 官方 v6 升級指南](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v6)
- Alpine 需可用的 OpenSSL、zlib、libgcc 與 musl；安裝時在目標 Alpine 自行 generate，**不要將本機 macOS 的 node_modules／engine 上傳**。[Prisma 官方系統需求](https://docs.prisma.io/docs/orm/v6/reference/system-requirements)
- 工具包不包含 PostgreSQL 原生工具。來源 PG `18.4` 須另備可支援它的 `pg_dump`／`pg_restore`（建議相同18.x）；不可用舊 pg_dump17 或 Prisma JSON 匯出取代完整備份。

## 安裝與本機無資料庫驗證

先以 immutable commit 的工具包與 SHA256 核對檔案；不要直接下載會移動的 branch head。工作目錄為解壓後這個資料夾，不是現有 `/app`。

```sh
set +x
npm ci --no-audit --no-fund
node -e "console.log(JSON.stringify({node:process.version,cli:require('prisma/package.json').version,client:require('@prisma/client/package.json').version,dotenv:require('dotenv/package.json').version}))"
```

若只測試安裝／generate／schema validate，使用以下**合成且不可用**的 URL，僅作用於單一命令；不用、也不讀真實連線。

```sh
DATABASE_URL='postgresql://unused:unused@127.0.0.1:1/never_connect?schema=public' npm run generate
DATABASE_URL='postgresql://unused:unused@127.0.0.1:1/never_connect?schema=public' npm run validate
```

## 已核對來源的備份與只讀 baseline 預覽

以下命令只由操作者在正確環境、明確授權後執行。來源 DATABASE_URL 由平台既有秘密環境提供；不要 `echo`、`printenv`、貼到命令列或寫入公開工具分支。

```sh
set +x
pg_dump --version
node scripts/database-maintenance.mjs baseline
node scripts/database-maintenance.mjs backup /tmp/private-backups/release-ENVIRONMENT-UNIQUE
```

baseline 不帶 `--apply` 是唯讀結構比對。backup 只讀來源 DB，建立包外全新700目錄、600 dump與manifest；不修改資料、不寄信。目的地必須在這個工具包以外。Demo與正式分別使用不同目錄，安靜時段執行；資料若在備份間變動，應重取備份而非修改manifest。

使用 Zeabur 已驗證的 File Manager Download，分別下載 `database.dump`、`manifest.json` 到本機700私有目錄，保持兩檔600；不要以終端base64、公開網址、issue／聊天附件傳送。下載後重新計算archive SHA256並核對manifest。

## 隔離還原及明確 baseline

隔離還原先以獨立 shell 配置全新空白 loopback DB，名稱必須為 `design_pm_restore_*` 或 `design_pm_phase3_*`；移除 SMTP，不啟動網站或外部流量。

```sh
node scripts/database-maintenance.mjs restore-check /private-backups/verified-copy/manifest.json
```

成功會比較完整public表摘要與sequence。正式備份內的環境identity會原樣保留，不會因為還原到本機變成Demo；真實復原時需另規劃舊會話／訂閱／token的撤銷。

只有在本次完整備份已下載、校驗、成功隔離還原，並重新核對原來源後，才可用**原來源自己的manifest**明確標記0001。這是資料庫metadata寫入，安裝／預覽不會自動做：

```sh
BASELINE_CONFIRM='BASELINE EXISTING DATABASE' node scripts/database-maintenance.mjs baseline /tmp/private-backups/release-ENVIRONMENT-UNIQUE/manifest.json --apply
```

勿修改manifest指紋、刪掉preflight差異、標記0002已完成或用reset繞過。若對本機還原DB演練baseline，應先對該還原DB另做自己的新備份；原來源manifest的目標指紋本來就不應相同。此包的操作範圍不包含啟動app、執行seed或發佈服務。
