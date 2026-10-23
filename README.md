# 藝術設計部 · 專案管理系統

Express、Prisma 與 PostgreSQL 的專案管理工作台，前端採霧藍微透的清晰列表。正式站為 https://artdesign.zeabur.app/，Demo 為 https://artdesign-for-demo.zeabur.app/。

## 開發與驗證

- 執行環境：固定 Node24.22.1 LTS 映像；Prisma CLI／Client 同為6.19.3，Nodemailer10.2.1。精確套件以 package-lock.json 為準。
- `npm ci`：依鎖檔安裝並產生 Prisma Client。
- `npm test`：合成資料、隔離 DOM／API 的回歸測試，不使用正式資料庫或實寄郵件。
- `npm run test:node24`：在正式 Node24 Linux 映像執行相同測試。
- `npm run test:postgres`：需明確啟用且驗證目標的本機 PostgreSQL 遷移／備份還原演練，詳見測試檔開頭與資料庫操作文件。

## 部署與資料保護

Dockerfile 是部署依據。一般啟動只會驗證設定、執行已提交的 migrations，再啟動網站；不執行 db push、重設或 seed。

**由舊版升級的現有資料庫必須先完成備份、隔離還原驗證與 baseline。** 沒有遷移歷史的非空資料庫會停止啟動並提示前置作業，不會自行重建。

| 文件 | 內容 |
| --- | --- |
| [部署指南](docs/zeabur-deploy.md) | 正式／Demo 的設定、升級順序與檢查 |
| [資料庫維護與回復](docs/database-operations.md) | 完整備份、還原演練、既有庫 baseline 與應用回滾 |
| [本機開發](docs/local-dev.md) | 新資料庫 migrations 與明確建立初始管理員 |
| [系統規格](docs/system-spec.md) | 案件、角色與分析規則 |
| [功能手冊](docs/features.md) | 工作台各頁操作 |
| [API](docs/api.md) | 介面參考 |

## 主要設定

| 變數 | 說明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL URL；不加入 Git 或部署記錄 |
| `JWT_SECRET` | 正式環境至少32位元組、無前後空白的隨機密鑰；升級保留原安全值 |
| `APP_BASE_URL` | 對應站台的 HTTPS origin，不含路徑、查詢或帳密 |
| `NODE_ENV` | production／development／test |
| `PORT` | 1–65535，預設3000 |
| `SMTP_HOST/PORT/USER/PASS/FROM/SECURE` | 選用；缺少設定時不寄信，站內通知仍保留 |

初始管理員僅能對**完全空的業務資料庫**以明確指令建立；沒有共用預設密碼、假成員或範例案件。已有資料時 bootstrap 不重建館別／需求單位，也不改動帳號。

Demo 重設具有獨立資料庫身分標記與明確確認檢查，仍屬會清除資料的手動維護操作；禁止把它當部署步驟。正式站回復不使用 Demo 重設或專案資料複製工具。

## 維護版本依據

- [Node24.22.1 安全版本](https://nodejs.org/en/blog/release/v24.22.1)
- [Prisma6 升級說明](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v6)：多對多關聯的唯一索引轉為主鍵，已獨立寫入 migration。
- [Nodemailer 維護版本](https://github.com/nodemailer/nodemailer/releases/tag/v10.2.1)
- `deepmerge-ts` 固定8.0.2，修補 Prisma6 工具鏈的[遞迴合併漏洞](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)；須與 Prisma CLI 操作及完整回歸一併驗證。

內部使用；框架程式依原專案授權，團隊內容為專有資料。
