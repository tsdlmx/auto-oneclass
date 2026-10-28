# auto-oneclass

一套基于 **Chrome DevTools Protocol (CDP)** 的 [一课英语学生端](https://stu.oneclass.cn) 精讲计划自动化工具。

- 不注入脚本、不改前端代码，只用 `Runtime.evaluate` 在已登录的真实页面里操作 DOM
- 复用**你原本的浏览器登录态**（cookie / token 全都保留），无需账号密码
- 覆盖全部题型：听力（新闻 / 长对话 / 篇章）、选词填空、段落匹配、阅读理解、翻译、作文
- 每个题目一个 JSON「答案载荷」，脚本负责导航 → 校验上下文 → 填答 → 提交 → 回读结果

> ⚠️ 仅供学习 CDP 自动化 / 个人复习自测使用，请遵守学校与平台的规则。

---

## 0. 懒人版：本地 Web 控制台

不想敲命令行就用这个：

```powershell
node web/server.mjs        # 打开 http://127.0.0.1:7788
```

首页直接出微信登录二维码 → 扫码确认 → 勾选要刷的第几周、选「全对」或「故意错 N 道」→ 点开始，自动抓题、解题、填答、提交并回读正确率。浏览器由服务自己拉起（独立 profile、无窗口、调试端口 9333），不动你日常的 Edge。实现细节见 [web/README.md](web/README.md)。

> 解题需要一个大模型 key：写进仓库根目录的 `llm-key.txt`（已 gitignore），或在页面「模型」栏里填，默认走 DeepSeek 的 OpenAI 兼容接口。

---

## 1. 原理

平台题目页把题目元数据挂在全局变量 `info` 上，作答后由页面自带的 `submit()` 发请求：

```js
function submit(){
  let params = {sid: 1401755, sweek: 1, timelength: ...}
  ...
}
```

所以自动化只需要三件事：

1. 打开 `https://stu.oneclass.cn/plan/exercise?id=<sid>&week=<week>`
2. 按题型把答案写进 DOM（`input[type=radio]` / `.blank_select` / `.question_letter` / `#answertext`）
3. 调用 `submit()`（`BC.confirm` 会被临时改成直接放行，跳过弹窗）

**关键坑：`sweek`。** 练习记录按「题目 + 周」存储，`week` 查询参数必须与练习所属周一致，
否则答案会写进错误的一周（页面仍会跳转到解析页，看起来"成功"，但计划表里仍是 0%）。
`play.mjs` 会在填答前校验 `info.week === week`，不匹配就告警。

---

## 2. 环境准备（Windows）

Chrome 136+ 对**默认用户目录**启动了 `--remote-debugging-port` 的封锁，
所以不能直接对官方 profile 开调试端口。做法是建一个目录联接（junction）指向真实配置目录，
再用它作为 `--user-data-dir`：

```powershell
# 1) 建联接（只需一次）
New-Item -ItemType Junction -Path C:\edgeLink `
  -Target "$env:LOCALAPPDATA\Microsoft\Edge\User Data"

# 2) 关闭正在运行的 Edge，然后带调试端口启动
taskkill /F /IM msedge.exe
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --user-data-dir=C:\edgeLink --profile-directory=Default `
  --remote-debugging-port=9222 --no-first-run `
  https://stu.oneclass.cn/plan/index
```

`scripts/launch-edge.ps1` 就是上面两步的封装。

> 该 profile 里已有登录态，页面直接是登录后的状态；
> 若掉登录，手动登录一次即可（不要清理该 profile）。

需要 Node.js 18+（用到内置 `fetch` / `WebSocket`，Node 22+ 更稳）。

---

## 3. 使用

```bash
# 列出当前可调试页面
node src/cdp.mjs list

# 任意 JS 求值（文件或 stdin）
node src/cdp.mjs eval probe.js
node src/cdp.mjs nav "https://stu.oneclass.cn/plan/index" 3000
```

### 3.1 抓题

```bash
node src/extract.mjs <sid> <week>
# -> 生成 x-<sid>.json
```

输出结构随题型变化：`{sid,type,tname,total,parse,passage,bank,qs,prompt,...}`，
其中 `parse` 常含**听力原文**或**全文翻译**，`bank` 是选词填空词库。

### 3.2 作答并提交

```bash
node src/play.mjs <sid> <week> <payload.json>
```

载荷格式（按题型选其一，可组合）：

| 题型 | payload | 说明 |
|---|---|---|
| 听力 / 阅读（单选） | `{"letters":["A","C","B"]}` | 按题号顺序的选项字母 |
| 段落匹配 | `{"match":["F","L","A", ...]}` | 10 个陈述对应的段落字母 |
| 选词填空 | `{"blanks":["simply","opposite", ...]}` | 10 个空的单词 |
| 作文 / 翻译 | `{"text":"..."}` | 写入 `#answertext` |

示例见 `examples/`。

### 3.3 回读进度

```js
// plan/index 的周表在 changeWeek(n) 里异步加载，n 从 0 开始
window.__wk = 3;            // 第 4 周
changeWeek(window.__wk);
// 等 1.8s 后收集 tr 里的 a[href*="exercise?id="] 与单元格文本
```

计划表每行给出：题目类型 / 题数 / 首次完成时间 / 首次正确率 / 练习次数 / 当前正确率。
（作文、翻译按满分百分比折算，常见 102.2% / 106.5%。）

---

## 4. 题型与 DOM 对应

| `info.type` | 题型 | 作答控件 |
|---|---|---|
| 19 / 30 / 31 / 32 | 听力（新闻 / 长对话 / 篇章） | `.question_options` 里的 `input[type=radio]` |
| 18 | 阅读理解 | `.question_list li` 里的 `input[type=radio]` |
| 6 | 段落匹配（拖拽题） | `ul.question_list li .question_letter`（直接写字母即可，无需真拖拽） |
| 4 | 选词填空 | `.blank_select`（下拉），`change` 事件需触发 |
| 15 / 16 | 作文 / 翻译 | `#answertext`，字数由页面实时统计 |

作文最少 120 词、最多 180 词；翻译不限字数但按覆盖率给分。

---

## 5. 目录

```
src/cdp.mjs       极简 CDP 客户端（list / nav / eval）
src/extract.js    页面内执行的题目提取表达式
src/extract.mjs   导航 + 提取 → x-<sid>.json
src/play.mjs      导航 + 校验周次 + 填答 + 提交 + 回读
src/peek.mjs      把 x-<sid>.json 打印成可读文本
scripts/launch-edge.ps1  带调试端口启动 Edge（junction 方案）
examples/         各类题型答案载荷样例
```

## 6. 注意事项

- **不要**把 `x-*.json`（题库原文）或答案载荷提交到公开仓库，版权与风控都在你这一侧。
- 提交后**务必回读计划表**，只有表里出现正确率才算真正记入。
- 页面偶发 `Index: 0, Size: 0` 报错，说明该 (题目, 周) 组合没有记录，多因 `sweek` 不匹配。
- 听力题 `qs[].q` 可能为空，题干不总在 DOM 文本里；此时依据选项与原文推理。

MIT License.
