# DSH Browser Bridge

给 DeepSeek Harness 的浏览器 / 文件通道：**Chrome 侧边栏扩展 + 零依赖本地桥**。

侧边栏有两个面板：

- **浏览器** —— 用 DOM / CDP 语义控制当前标签页：导航、读结构、点击、输入、等待，外加一份可勾选的**标签页清单**（切页 / 批量关闭）。**不需要截图，也不需要视觉模型。**
- **文件** —— 列目录、预览文本 / Markdown / 图片 / PDF / 音视频，**就地编辑保存、新建、删除**，并接收 agent 推来的文件：agent 一句 `file.show`，文件就直接顶到侧窗。

## 为什么"无需视觉能力"

| 环节 | 做法 |
|---|---|
| 看页面 | 页面内代理遍历可交互元素，返回 `{ref, role, name, value, 坐标}` 清单 + 正文文本；`ref` 写进 `data-dsh-ref`，跨轮次稳定可复用 |
| 动手 | 走 CDP 真实输入事件：`Input.dispatchMouseEvent`（点击）、`Input.insertText`（输入）、`Input.dispatchKeyEvent`（回车/退格/组合键）—— React/Vue 的合成事件照常触发 |
| 等 | 页面内 `waitFor(selector | text, timeout)`，等元素或文案出现再继续 |
| 看文件 | 侧窗直接读本地桥的字节流（`/text` 文本、`/file` 原始字节），不经过模型、不截图 |

全程没有 `Page.captureScreenshot`：没有像素、没有 OCR、没有多模态调用。

## 结构

```
dsh-browser-bridge/
  README.md
  extension/            Chrome MV3 扩展
    manifest.json
    background.js       service worker：CDP 引擎 + 桥轮询 + 页面内代理
    sidepanel.html      侧边栏界面（浏览器 / 文件 两个页签）
    sidepanel.js        侧边栏逻辑（长连接也用来保活 SW）
  bridge/
    relay.mjs           本地桥（零依赖，Node 内置模块）
    selftest.mjs        自测：不需要 Chrome 也能验队列 / 超时 / 往返
```

```
DSH / agent ──POST /cmd──▶ 本地桥 127.0.0.1:3099 ──▶ 文件：/list /text /file ──▶ 侧窗（文件面板）
                              ▲  │                    文件写：/write /mkdir /delete ◀── 侧窗编辑器
                  GET /next ──┘  └── POST /result
                              │
                    Chrome 扩展（侧边栏开着时在线）
                              │  chrome.debugger (CDP 1.3)
                              ▼
                    当前标签页：真实输入事件 + DOM 读数
```

## 安装与启动

1. `chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → 选 `extension` 目录。
   Chrome 会显示一条"正在调试此浏览器"提示条 —— 那是 `chrome.debugger` 的正常提示，不是后台偷跑。
2. 起桥：`node bridge/relay.mjs`
   （默认 `127.0.0.1:3099`；`DSH_BRIDGE_PORT` 换端口，`DSH_BRIDGE_ROOT` 换文件访问根，默认用户主目录。）
3. 点扩展图标打开**侧边栏**。侧边栏打开 = 桥在线；**关掉侧边栏即断线**（这是刻意的：通道只在你要它开的时候开）。
4. 自测：`node bridge/selftest.mjs`（不需要 Chrome）；或侧边栏里点「连接当前标签页」→「读取页面结构」。

## 协议

| 方向 | 端点 | 语义 |
|---|---|---|
| agent → 桥 | `POST /cmd` `{op, args, timeoutMs?}` | 入队并**阻塞**等到结果（默认 45s 超时） |
| agent → 桥 | `POST /cmd` `{op:"file.show", args:{path}}` | **桥自己处理**：把文件 / 目录推给侧窗并立即返回，不需要扩展在线 |
| 扩展 → 桥 | `GET /next` | 取一条指令；无指令返回 `204` |
| 扩展 → 桥 | `POST /result` `{id, ok, result｜error}` | 回传执行结果 |
| 侧窗 → 桥 | `GET /panel/next` | 取一条推送（`{op:'file.show'｜'dir.open', path}`）；无推送返回 `204` |
| 侧窗 → 桥 | `GET /list?path=` | 列目录：`{path,name,root,parent,entries:[{name,path,dir,size,mtime}]}` |
| 侧窗 → 桥 | `GET /text?path=` | 读文本（≤2MB）：`{path,name,size,mtime,truncated,text}` |
| 侧窗 → 桥 | `GET /file?path=[&dl=1]` | 原始字节 + MIME（图片 / PDF / 音视频；`dl=1` 触发下载） |
| 侧窗 → 桥 | `POST /write` `{path, text, create?}` | 保存文本；`create:true` 时自动建父目录（编辑器用） |
| 侧窗 → 桥 | `POST /mkdir` `{path}` | 新建目录 |
| 侧窗 → 桥 | `POST /delete` `{path}` | 删除**文件**；目录只删**空**目录（拒绝删访问根） |
| 探活 | `GET /health` | `{ok, pending, waiting, panel, root}` |

所有文件路径都经过 `safePath()`：越出 `DSH_BRIDGE_ROOT` 一律 403 —— 读、写、删一体适用。

## 操作表（浏览器面板）

| op | args | 说明 |
|---|---|---|
| `attach` | `{tabId?}` | 连接标签页（缺省用当前活动标签页），装载页面内代理 |
| `tabs.list` | — | `[{id, title, url, active, pinned}]` |
| `tabs.open` / `tabs.activate` / `tabs.close` | `{url}` / `{tabId}` / `{tabId}` | 单个标签页操作 |
| `tabs.closeMany` | `{tabIds:[…]}` | **批量关闭**（侧栏勾选后调它） |
| `tabs.reload` | `{tabId}` | 重载标签页 |
| `page.open` | `{url, tabId?}` | 导航并等 `Page.loadEventFired` |
| `page.snapshot` | `{tabId?}` | **读数**：`{url, title, text, elements[]}` |
| `page.text` | `{ref?}` | 取正文或某元素文本 |
| `page.click` | `{ref}` | 按 ref 求坐标 → 真实点击 |
| `page.type` | `{ref, text, clear?, submit?}` | 聚焦 + `insertText`；`submit` 回车 |
| `page.press` | `{key}` | Enter / Tab / Escape / Backspace / ↑ / ↓ |
| `page.scroll` | `{dy, x?, y?}` | 滚轮 |
| `page.waitFor` | `{selector?, text?, timeoutMs?}` | 等元素或文案 |
| `page.eval` | `{expression}` | **默认关闭**，需在侧边栏勾选 |
| `bridge.status` | — | 当前状态与最近 40 条活动日志 |
| `file.show` | `{path}` | 把文件 / 目录推到侧窗（桥处理，无需扩展在线） |

## 侧边栏怎么用

**浏览器页签**

- 「连接当前标签页」把 CDP 挂上当前页；「读取页面结构」打印标题 + 可交互元素数（明细在侧栏控制台）。
- 下面那份**标签页清单**：`●` 是当前活动页，`⟶` 是已连接的页。**单击某行 = 切到该页并连接**；勾选若干行后点「关闭选中」= `tabs.closeMany` 批量关。
- 「活动」区是实时日志：每一条指令与结果都带时间戳，出错是红的。

**文件页签**

- 地址栏输入路径回车即可跳转（给文件就是预览）；`..` 回上级。
- 文本 / Markdown / 图片 / PDF / 音视频都内联预览。
- **编辑**：点「编辑」把当前文件读进编辑器 → 改 → **Ctrl+S 保存**（或点「保存」），**Esc 取消**。超过 2MB 的文件拒绝进编辑器（避免保存时被截断）。
- **新建**：「新文件名」框输入后回车/点「新建」，在当前目录建空文件并直接进入编辑。
- **删除**：确认后删当前文件；目录只删空的。
- agent 推来的文件会**自动顶到这一页**；如果你正在编辑，它只提示、不打断你。

## 用法示例

```bash
# 浏览器
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"attach\",\"args\":{}}"
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"page.open\",\"args\":{\"url\":\"https://example.com\"}}"
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"page.snapshot\",\"args\":{}}"
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"page.click\",\"args\":{\"ref\":\"e7\"}}"
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"page.type\",\"args\":{\"ref\":\"e3\",\"text\":\"关键词\",\"submit\":true}}"
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"page.waitFor\",\"args\":{\"text\":\"结果\",\"timeoutMs\":8000}}"

# 标签页：列出 / 批量关闭
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"tabs.list\",\"args\":{}}"
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"tabs.closeMany\",\"args\":{\"tabIds\":[12,15,18]}}"

# 文件：把 README 顶到侧窗 / 打开目录 / 直接写一个文件
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"file.show\",\"args\":{\"path\":\"D:/work/report.md\"}}"
curl -s -X POST http://127.0.0.1:3099/cmd -d "{\"op\":\"file.show\",\"args\":{\"path\":\"D:/work\"}}"
curl -s -X POST http://127.0.0.1:3099/write -d "{\"path\":\"D:/work/note.md\",\"text\":\"# 标题\",\"create\":true}"
```

典型闭环：`attach` → `page.open` → `page.snapshot`（拿到 ref）→ `page.click` / `page.type` → `page.waitFor` → 再 `page.snapshot` 核对。

## 安全边界

- 桥只监听 `127.0.0.1`，不对外网开放；无凭据、无回调。
- 扩展只在侧边栏打开时轮询 —— 你不开，它就不在线。
- `page.eval` 默认关闭：能在页面里跑任意脚本，需要你手动开启。
- 页面内代理只加 `data-dsh-ref` 属性，不改页面结构与样式。
- 文件**读 / 写 / 删**全部经 `safePath()` 锁在 `DSH_BRIDGE_ROOT`（默认用户主目录）之内：越界 403；访问根本身不可删；目录只删空的 —— 没有递归删除这条路。

## 下一步（可选）

把桥接进 DSH 成一个 Cordis 插件，注册 `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_wait` / `file_show` 工具 —— agent 就能直接驱动，而不必经 `curl`。
