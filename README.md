# 星宇航空動態航班看板

這是一個星宇航空（STARLUX Airlines）動態航班看板，用於顯示桃園機場相關的星宇航班資訊。畫面以機場看板風格呈現，支援起飛與降落航班、機型、登機門、時間倒數與狀態判斷。

## 功能特色

- 只顯示星宇航空航班。
- 欄位包含 `ARR / DEP / TYPE / IATA / BAY / STA / STD / 倒數 / 狀態`。
- 抵達航班顯示在 `ARR` 欄，起飛航班顯示在 `DEP` 欄。
- 使用 TDX 作為主要航班資料來源，提供班表、登機門、時間與狀態資料。
- 使用 Flightradar24 補充抵達航班 ETA。
- 註冊編號目前先隱藏不顯示，避免額外查詢 FR24 Summary Light。
- 隱藏已完成航班，只保留尚未完成或仍被 FR24 追蹤的航班。
- 後端使用記憶體快取降低 API 呼叫量。

## 資料來源

### TDX

使用 TDX 航空 FIDS 航班資料：

```text
GET /api/tdx/fids/tpe
```

後端會代理到 TDX：

```text
https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Flight
```

TDX 主要提供：

- 航班號
- 起飛 / 抵達機場
- 表定時間
- 預計時間
- 登機門
- 航廈
- 狀態
- 機型

### Flightradar24

使用 FR24 live flight positions：

```text
GET /api/fr24/starlux-live
```

FR24 目前只用來補充：

- 抵達航班 ETA

若之後需要補註冊編號，後端可再使用 Summary Light：

```text
GET /api/fr24/flight-summary?ids=<fr24_id>
```

## API 快取策略

為了減少 API 額度消耗，外部 API 呼叫集中在後端並使用記憶體快取：

- TDX FIDS：15 分鐘
- FR24 live：2 小時
- FR24 Summary Light：15 分鐘

前端每分鐘更新畫面倒數；FR24 每 2 小時更新一次；TDX 每 15 分鐘更新一次。

## 啟動方式

需要 Node.js 18 或以上版本。

先設定環境變數：

```bash
export FR24_API_TOKEN="你的 Flightradar24 API token"
export TDX_CLIENT_ID="你的 TDX Client ID"
export TDX_CLIENT_SECRET="你的 TDX Client Secret"
```

`TDX_API_TOKEN` 也支援，但 TDX access token 會過期；建議使用 `TDX_CLIENT_ID` 和 `TDX_CLIENT_SECRET` 讓後端自動換 token。

啟動本機伺服器：

```bash
PORT=4173 node server.js
```

開啟瀏覽器：

```text
http://127.0.0.1:4173/
```

## 專案檔案

- `index.html`：看板 HTML 結構
- `styles.css`：看板視覺樣式
- `script.js`：前端資料整合、倒數與渲染邏輯
- `server.js`：本機靜態伺服器與 API proxy
- `starlux-flights.json`：本地星宇資料快照
- `taoyuan-flights.json`：本地桃機資料快照
- `fetch-starlux.js`、`fetch-taoyuan.js`：資料抓取輔助腳本

## 注意事項

- 不要把 API token 寫進前端檔案或提交到 Git。
- `.env`、`.env.*` 已加入 `.gitignore`。
- 後端記憶體快取在伺服器重啟後會清空。
- 註冊編號欄位目前隱藏，之後需要時可以再開啟。
