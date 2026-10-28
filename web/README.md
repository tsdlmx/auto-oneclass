# 本地刷题控制台（web/）

把 `src/` 的 CDP 脚本包成一个本地网页：首页出微信二维码 → 扫码登录 → 选周次和模式 → 自动抓题、解题、填答、提交。

```powershell
node web/server.mjs          # 打开 http://127.0.0.1:7788
```

## 它做了什么

| 步骤 | 实现 |
|---|---|
| 二维码 | 服务端直接走微信 `qrconnect`：`/login` 里取 appid/state → `open.weixin.qq.com/connect/qrconnect` 拿到 `uuid` → 二维码图片 `connect/qrcode/<uuid>` 代理到首页；`long.open.weixin.qq.com` 长轮询只有 200（已确认）时才收手 |
| 登录 | 拿到 `wx_code` 后让本机无窗口 Edge 打开 `/wechatcallback?code=...&state=...`，会话写进 `web/.edge-profile`，下次启动仍在 |
| 浏览器 | `--remote-debugging-port=9333` + 独立 profile，不动你日常的 Edge；`--headless=new`，桌面不会弹窗 |
| 抓题 | 复用 `src/extract.js`，在真页面 `Runtime.evaluate` |
| 解题 | 一次 OpenAI 兼容的 chat completion（默认 DeepSeek），按题型返回 `letters / match / blanks / text` |
| 作答 | 复用 `play.mjs` 的填答表达式：radio `.click()`、`.question_letter` 直写、`select` 派发 change、`#answertext` 派发 input |
| 校验 | 提交后回读计划表/解析页，只有出现正确率才算记上 |

## 安全边界

- key 存在 `web/config.json`（已 gitignore），或放仓库根 `llm-key.txt`；不上传任何地方。
- 只操作你自己的账号；刷题会覆盖同一 (题目, 周) 的记录。
- `web/.edge-profile` 里有你的登录 cookie，别提交、别外发。

## 常见问题

- **二维码过期**：微信码 5 分钟一轮，点「刷新二维码」。
- **登录后计划表空白**：先点「读取计划表」，12 周逐周异步加载需要 ~20 秒。
- **提交后计划表仍是 0**：`week` 上下文不匹配（见根目录 AGENTS.md 的不变量 1/2），脚本会报警告。
- **想看某道题抓到了什么**：`node web/dev/inspect.mjs <sid> <week>`。
