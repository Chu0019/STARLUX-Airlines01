# 星宇航空指定航班追蹤頁 Cloudflare Pages 版

這個資料夾可以直接用 Cloudflare Pages 部署。

## 部署設定

- Framework preset: `None`
- Build command: 留空
- Build output directory: `/`
- Root directory: `cloudflare-watch`

如果你是直接把本資料夾單獨上傳到 Cloudflare Pages，Root directory 不需要另外設定。

## 環境變數

Cloudflare Pages > Settings > Environment variables 新增：

- `FR24_API_TOKEN`
- `TDX_CLIENT_ID`
- `TDX_CLIENT_SECRET`

可選：

- `TDX_API_TOKEN`
- `TDX_API_KEY`

## 頁面與 API

- 頁面：`/`
- FR24 指定航班 API：`/api/fr24/flights?flights=JX202,JX801`
- TDX 指定航班 API：`/api/tdx/fids/flights?flights=JX202,JX801`

## 注意

- API key 不要寫進前端檔案。
- 按「追蹤」會儲存航班清單，並查詢指定航班。
- 強制更新有 5 分鐘冷卻。
