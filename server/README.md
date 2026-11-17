# focusd：江南入夜专注挂机小游戏的本地小程序

只读 Claude Code、Codex、DeepSeek Harness、Grok Build、Magpie 网关（含经它的 Cursor CLI）的用量日志，算出“AI 在干活 / 你在专注”的状态，用 SSE 推给网页，同时把 `../web/` 当静态网站提供。只用 Node 内置模块（Node 22+），不装依赖。

## 启动

一键启动（推荐，跨平台）。在仓库根目录：

```bash
node start.mjs
# 会自动检查 Node 版本、启动本地服务并打开 http://127.0.0.1:4317/
# 已在运行就直接打开浏览器；加 --no-open 不自动开浏览器
```

如果当前已经在 `server/` 目录里，用 `node ../start.mjs`（手动启动用 `node focusd.mjs`）。

停止：

```bash
node start.mjs --stop
# 在 server/ 目录里则用 node ../start.mjs --stop
```

查看是否在运行：`node start.mjs --status`。

手动前台启动 `node focusd.mjs` 时，Ctrl+C 或 `kill <pid>` 会先保存再退出（SIGINT/SIGTERM）。

测试：`node test/run.mjs`（全部用临时目录和 fixtures，不碰真实日志和存档）。

## 端口和环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| JN_PORT | 4317 | 监听端口，只监听 127.0.0.1；0 表示随机端口 |
| JN_HOME | ~/.jiangnan-focus | 存档目录（save.json）。不允许放在任何被读取的 AI 工具日志目录里 |
| JN_CLAUDE_DIR | ~/.claude/projects | Claude Code 日志根目录（含子目录）；设为空串可停用该来源 |
| JN_CODEX_DIR | ~/.codex/sessions | Codex 日志根目录（含子目录）；设为空串可停用该来源 |
| JN_DSH_DIR | ~/.dsh/sessions | DeepSeek Harness 会话目录（session.v4.jsonl.zstd）；设为空串可停用该来源 |
| JN_GROK_DIR | ~/.grok | Grok Build 根目录（读 logs/unified.jsonl，sessions/ 只看文件夹名）；设为空串可停用该来源 |
| JN_MAGPIE_FILE | ~/.config/magpie/usage.jsonl 或 %APPDATA%\magpie\usage.jsonl | Magpie 用量文件（不读 routing/ 目录；两处候选里选已存在的那一处）；设为空串可停用该来源 |
| JN_WEB_DIR | ../web | 静态网页目录 |
| JN_DEBUG | 空 | 设为 1 时每分钟打印一次各环节耗时和进程 CPU（只有数字） |

Linux 空闲检测是可选的：X11 会优先用 `xprintidle`，GNOME Wayland 会用 `gdbus`。两者都没有时安静降级，程序把“人在场”标记为未知并按在场处理。

## 接口

| 路径 | 说明 |
|---|---|
| GET /api/state | 完整状态 JSON（含 `service`、`rev`、`boot` 供启动器识别）。`today.logsMissing` 为 true 表示今天的日志当前不可用、水牌来自上次快照；`today.logsMissingSources` 列出受影响来源 |
| GET /api/events | SSE：连上先发 `state`，之后每 2 秒一条 `state`；有动静时发 `beat` |
| POST /api/reward/offer | 返回当前三选一 `[{id, category}]`；同一个待领奖励重复请求返回同一组；没有待领时返回 `[]` |
| POST /api/reward/choose | `{"id":"teahouse"}`，必须在当前这组里 |
| POST /api/settings | 合并保存设置，带范围校验 |
| POST /api/stop | 优雅停止：保存存档、释放子进程后退出（`node start.mjs --stop` 会调用它） |
| POST /api/focus/reset | 专注归零：只清今天的在场/独航/成段和当前段；token、收藏和奖励不动 |
| 其他 GET | `../web/` 静态文件，禁止路径穿越和符号链接指到外面 |

奖励接口目前仍在，但网页端默认关闭奖励界面（`REWARDS_ON=false`）；它们不影响专注统计，也不清空收藏和奖励。

## 隐私

中文：

- 会读取本机这些 AI 工具的记录文件来计数，但只读打开、不写入、不移动、不改它们的配置，不装钩子。
- 只取：时间戳、会话 id、token 数、工具名、工具调用 id（只用来去重，不输出）、cwd 的最后一级文件夹名。
- 不保存、不显示、不上传对话正文、思考、代码、命令参数、文件内容；解析出的对象用完即丢。
- 不联网，不上传任何数据。HTTP 只监听 127.0.0.1，并拒绝非本机 Host 和跨站 Origin 的请求。
- 存档只有收藏、待领奖励、当天统计（含当天各来源聚合和会话统计快照，仍无正文）、专注段进度和设置。
- 如果某来源今天的日志暂时读不到（文件缺失、目录不可读等），启动时会用上一次保存的当天快照补齐该来源，并在 `today.logsMissing` / `today.logsMissingSources` 里明确标注，而不是悄悄用零覆盖旧统计。
- 不打开 Grok 的 auth.json、session_search.sqlite 和会话目录里的任何文件；不读 Magpie 的 routing/ 目录；DeepSeek Harness 只解析 session、assistant/message 的用量和 tool/call 的工具名。

English:

- It reads those local AI-tool record files to count usage, but opens them read-only and never writes, moves, or changes their config, and installs no hooks.
- Only these fields are taken: timestamps, session ids, token counts, tool names, tool-call ids (used only for deduplication, never output), and the last path segment of cwd.
- Conversation text, thinking, code, command arguments, and file contents are never stored, shown, or uploaded; parsed objects are discarded immediately.
- No network requests are made and no data is uploaded. HTTP listens on 127.0.0.1 only, and rejects non-local Host headers and cross-site Origin requests.
- The save file contains only owned rewards, pending rewards, today's aggregates (including a per-source and per-session stats snapshot, still without message content), focus-segment progress, and settings.
- If a source's logs for today are temporarily unreadable (missing files, unreadable directory, etc.), startup restores that source from the last saved today-snapshot and marks it via `today.logsMissing` / `today.logsMissingSources`, instead of silently overwriting previous stats with zeros.
- Grok's auth.json, session_search.sqlite, and files inside session directories are never opened; Magpie's routing/ directory is never read; DeepSeek Harness only parses usage from session / assistant/message and tool names from tool/call.
