# AGENTS.md

Guidance for AI coding agents (and humans) who continue work on this repo.
Read this before touching `src/`. `README.md` is the user-facing quickstart; this
file is the engineering contract.

---

## 1. What this project is

A small, dependency-free toolkit that drives the **一课英语 / OneClass student
site** (`https://stu.oneclass.cn`) through the Chrome DevTools Protocol so a study
plan (`/plan/index` → 精讲计划 第 1..12 周) can be worked through quickly.

The user's own logged-in Edge profile is reused; nothing is scraped offline and no
credentials are stored. All state lives in the site's own session cookie.

**Non-goals:** no headless browsing, no password/login automation, no server, no
database, no browser extension.

## 2. Hard constraints of the environment

These shaped the design; do not "simplify" them away.

| Constraint | Consequence |
|---|---|
| Chrome/Edge >= 136 refuses `--remote-debugging-port` on the **default** `User Data` dir | `scripts/launch-edge.ps1` creates a junction `C:\edgeLink` -> `%LOCALAPPDATA%\Microsoft\Edge\User Data` (Chrome: `C:\chromeLink`) and launches with `--user-data-dir=C:\edgeLink --profile-directory=Default --remote-debugging-port=9222`. Cookies/login survive because the files are the same. **Caution:** the script force-stops the running browser first (`Stop-Process -Name msedge`), so warn the user before running it on a live session. |
| `pwsh` may run with a restrictive execution policy (`*.ps1 cannot be loaded`) | Call the launcher as `powershell -ExecutionPolicy Bypass -File scripts\launch-edge.ps1`; never assume `.ps1` runs directly. |
| `git` is often not installed | Publishing uses the GitHub REST **Contents API** (`upload.mjs`), not `git push`. |
| Windows PowerShell `Set-Content -Encoding UTF8` may emit a BOM | Every JSON reader must strip `^\uFEFF`; writing files from PowerShell should use `[System.IO.File]::WriteAllText($absPath, $s, (New-Object System.Text.UTF8Encoding($false)))`. Note `.NET` calls resolve relative paths against the *process* cwd, not `Set-Location` — always pass absolute paths. |
| Node is provided by the host harness | Do not add npm dependencies. ESM only, plain `fetch` + `WebSocket` (Node >= 22). |

## 3. Architecture

```
scripts/launch-edge.ps1   one-time: junction + launch Edge with CDP on :9222
src/cdp.mjs               tiny CDP client: nav | eval <file|-> | list
src/extract.js            ONE big browser-side expression -> exercise facts as JSON
src/extract.mjs           nav(id, week) + evaluate extract.js + write x-<sid>.json
src/play.mjs              nav(id, week) -> verify ctx -> fill -> submit -> report
src/progress.mjs          read the plan table for one or more weeks
src/peek.mjs              print current tab URL / a slice of body text
```

Data flow:

```
plan table --(progress.mjs)--> exercise ids + week index
        |
        +--(extract.mjs)--> x-<sid>.json   { type, parse/transcript, passage, qs, bank ... }
        |                        |
        |                   (agent reasoning / answer key)
        |                        v
        +--(play.mjs)--< a-<sid>.json  { letters | match | blanks | text }
                                 |
                            submit() --> /plan/analysis?id=<sid>&week=<n>
```

Target resolution: each script hits `http://127.0.0.1:9222/json/list` and picks the
first `page` target whose URL contains `oneclass` (override with `CDP_MATCH`), port
overridable with `CDP_PORT`. `x-<sid>.json` and payload paths are resolved against
the **current working directory** — run scripts from the repo root.

`week` is **0-based everywhere in this repo** (week index), while the site UI shows
1-based labels. `plan/index` week *tables* are addressed with `changeWeek(i)`.

## 4. Contracts

### 4.1 Answer payload (`a-<sid>.json`)

Exactly one shape per exercise, matching `info.type`:

```jsonc
{ "letters": ["B","D","C"] }                 // 19/30/31/32 listening, 18 reading
{ "match":   ["C","I","E", "..."] }           // 6  段落匹配 (10 letters, statement order)
{ "blanks":  ["simply","opposite", "..."] }  // 4  选词填空 (10 words, blank order)
{ "text":    "full essay or translation" }   // 15 作文, 16 翻译
```

### 4.2 Extract output (`x-<sid>.json`)

```jsonc
{ "sid": 684, "type": 19, "tname": "听力——新闻", "total": "3",
  "parse": "<听力原文 or 全文翻译#:#...>", "passage": "<article>",
  "qs": [ { "q": "stem", "opts": { "A": "...", "B": "..." } } ],
  "bank": ["...15 words..."], "prompt": "<directions>", "body": "<visible text>" }
```

Fields are absent when not applicable — always guard with `|| ''` / `|| []`.
`qs[].q` is sometimes empty (the stem then only appears in `body`), and `parse`
doubles as the listening transcript — which is why listening items are answerable
without ever touching the audio.

### 4.3 Type -> DOM map

| `info.type` | 题型 | Controls | Submit reads |
|---|---|---|---|
| 19 / 30 / 31 / 32 | 听力（新闻 / 长对话 / 篇章） | `.question_options` blocks with `input[type=radio][value=A..D]` | checked radios |
| 18 | 阅读理解 | `.question_list li` with radios | checked radios |
| 6 | 段落匹配 | **drag & drop**: paragraph `.question_options.match[data-option]` dropped onto `ul.question_list li .question_letter` | text of each `.question_letter` |
| 4 | 选词填空 | `.blank_select` (10 `<select>`), word bank of 15 | `select.value` |
| 15 / 16 | 作文 / 翻译 | `#answertext` (textarea) | textarea value |

For type 6 we bypass the drag UI: write the letter into `.question_letter` and also
set `data-answer` / `$(li).data('answer', ...)`. The site re-reads
`.question_letter` on submit, and this path is confirmed to score 100 %.

## 5. Invariants — break these and submissions are silently lost

1. **Week context must match before submitting.** `submit()` is generated inline per
   page load and hardcodes `sweek` from `info.week`; the record is stored under that
   week. `play.mjs` polls `info.id === sid && info.week === week` before filling and
   prints `ctx ok ...`. On `WARN ctx mismatch`: re-navigate, do not submit.
2. **Symptom of a week mismatch:** the plan table still shows `0 / 开始练习`, and
   `/plan/analysis?id=<sid>&week=<n>` returns
   `{"status":0,"data":{"msg":"Index: 0, Size: 0"}}`. The record exists under the
   other week; re-submitting with the right context overwrites it cleanly.
3. **`submit()` needs a confirm override.** Set `BC.confirm = (m, cb) => cb()`
   immediately before calling it, otherwise it can wait on an unsaved-work dialog.
4. **Finished 作文/翻译 rows lose their `exercise?id=` href** (the action cell becomes
   查看解析). Any table scraper must key on the `<td>` count, not on the anchor.
5. **The legacy driver's week argument is a flag, not a number.** In the old `run3`
   mode a numeric argument matched `/^\d+$/` and was treated as an exercise id, so a
   "week" of `1` actually loaded `exercise?id=1&week=0` and every later submission
   landed under week 0. `src/extract.mjs` and `src/play.mjs` take an explicit numeric
   `week` — keep that signature stable.
6. **Wait after navigate** (~1.5 s) and after `submit()` (~5 s, then reload
   `/plan/index` to confirm). The AJAX success callback is not observable through
   `BC.ajax`; the plan table is the only reliable oracle.
7. **The page is a jQuery + inline-script site.** `element.value = ...` needs a
   dispatched `input`/`change` event; radios must be `.click()`ed.

## 6. Verification loop (always run it)

```powershell
node src/progress.mjs 0 1 2 3          # per-week table: 练习次数, 首次正确率
node src/peek.mjs                     # where is the tab right now
```

A submission counts as successful only when the row shows a non-zero 练习次数 and a
percentage. `100%` for objective items; 作文/翻译 are scored by length/quality and
legitimately exceed 100 (observed 102.2 and 106.5).

## 7. Conventions

- ESM, `node:` builtins only, top-level `await`, no build step.
- Keep scripts single-purpose and idempotent; re-running `play.mjs` re-submits and
  overwrites the record (练习次数 increments — acceptable, but don't loop it).
- Output is agent-oriented: one status line, JSON where structure matters.
- Never commit `x-*.json`, `a-*.json`, `upload.mjs`, or any token; `.gitignore`
  already covers those.

## 8. Known gaps / roadmap (pick one and keep the invariants)

- **Batch runner** `node src/run-week.mjs <week>`: list the week's ids, then loop
  extract -> (answer source) -> play with the ctx check, retrying failed rows once.
  Biggest ergonomics win; today the loop is manual.
- **Answer source seam.** Answers are hand-written JSON. Introduce a provider
  interface (`answerProvider(extract) -> payload`) so a model call, a cached key, or
  a heuristic parser can be swapped in without touching `play.mjs`.
- **Listening auto-solver.** The transcript already comes back in `info.parse`, so
  this is mostly prompt work: transcript + `qs` -> letters.
- **Robust submit oracle.** Poll the plan table until 练习次数 increments instead of
  sleeping 5 s; exit non-zero on failure.
- **Consolidate** the remaining one-off scripts and drop the lower-level
  `cdp.mjs eval <file>` footgun where inline JS is read as a file path.
- **Multi-week planning**: `/plan/index` exposes 12 weeks; nothing assumes 1..4.

## 9. Ethics / blast radius

This automates *the account owner's own* coursework. Keep it that way: no credential
harvesting, no bypassing rate limits or paywalls, no use against accounts you do not
own. Deliberately wrong answers are acceptable only when the owner asks for them (it
happened once, by request, to make a practice record look human).

## 10. Pre-commit checklist

- [ ] `node src/progress.mjs <weeks>` still reports non-zero 练习次数 rows.
- [ ] Any changed selector was verified against a live page via `eval`, not guessed.
- [ ] No BOM in generated JSON; absolute paths in .NET/PowerShell helpers.
- [ ] `README.md` updated if a command or environment step changed.
- [ ] Publish with `node upload.mjs` (Contents API, upsert by sha) — never `git push`.