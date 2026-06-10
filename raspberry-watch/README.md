# 星宇航空樹莓派追蹤版

這個資料夾是樹莓派專用版本，和主網站、Cloudflare 版本分開。

## 啟動

```bash
cd ~/STARLUX-Airlines01/raspberry-watch
HOST=0.0.0.0 PORT=4173 node server.js
```

## 頁面

- 樹莓派螢幕：`http://localhost:4173/`
- 手機設定：`http://樹莓派IP:4173/admin.html`

## 環境變數

- `FR24_API_TOKEN`
- `TDX_CLIENT_ID`
- `TDX_CLIENT_SECRET`

追蹤名單會保存在 `watch-config.json`。
