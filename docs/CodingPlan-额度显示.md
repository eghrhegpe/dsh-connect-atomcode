# CodingPlan 额度显示的设计与实测档案

配套 [`README.md`](../README.md)「📊 CodingPlan 额度显示」一章的**机制档案**。README 只保留用户侧结论（看到什么 / 异常时怎么办 / 去哪查机制），daemon 拉起语义、数据获取、容错解析、面板座位与弹窗决策的完整内容都在这里。

解析真源是 `src/host/quota.ts`（构建产物 `lib/quota.js`），回归守卫在 `test/quota.test.mjs` / `test/protocol.test.mjs`；协议端点层面的细节见 [`docs/AtomCode-CLI与daemon接口参考.md`](AtomCode-CLI与daemon接口参考.md) §4（同源的端点清单与 `/command` 坑，结论以本篇为准）。

## daemon 什么时候被拉起

`auto_start: true` 的语义是「**保持 daemon 在跑**」，不是「等第一次调用工具才拉」。daemon 在两个地方被拉起：

1. **ask 路径** —— 会 `await` 到就绪（没有 daemon 这回合根本没法跑）
2. **`/api/atomcode-bridge/stats` 路由** —— 只**踢一脚**（fire-and-forget）

面板和输入框额度标签**都轮询这个路由**，所以：**光是打开插件详情页，或者只是看着输入框**，daemon 就会自己起来 —— 不需要模型先调一次 `atomcode_ask` 来"启用桥接"。实测只轮询路由、不调任何工具：

```
t=0s   up=false  starting=true   spawnTried=true   quota=—   (正在拉起 daemon…)
t=2s   up=true   starting=false  spawnTried=true   quota=77%
```

四个设计约束：

- **绝不在 mount 时拉起** —— 挂载一个插件不该顺带 spawn 进程
- **绝不让路由等** —— 拉起轮询最长 30s，而路由必须在面板 5s 轮询内应答；所以是 fire-and-forget，面板先显示「正在拉起…」
- **health 先探** —— 已有 daemon 在跑就什么都不做，`spawnTried` 保持 `false`（宿主重启或双 profile 不会 spawn 第二个去撞端口）
- **共享一个 start promise** —— 面板反复轮询与 ask 并发时，只会拉一次

> **为什么 daemon 会"消失"？** `atomcode daemon` **空闲 30 分钟会自行退出**（`--idle-timeout` 默认 1800s）。
> 所以面板上出现 `daemon 未运行` 通常不是坏了，而是它闲置自杀了 —— 下一次轮询会把它重新拉起来。
> 插件有意保留这个默认（不传 `--idle-timeout 0`）：它不该常驻吃内存。想让它常驻就自行启动时加 `--idle-timeout 0`。

## 数据是怎么拿到的（实测结论）

AtomCode **没有**额度 HTTP 接口。实测已知面：

| 面 | 是否含额度 |
|---|---|
| `/health` `/models` `/providers` `/config` | ❌（只有服务状态、模型、provider、配置） |
| SSE `done.stats` | ❌（只有 `duration_ms` / `rounds` / `prompt_tokens` / `completion_tokens` / `cached_tokens`） |
| 其余任意路径 | ⚠️ 一律回吐同一个 HTML SPA（**200 是假阳性**，别拿它判断端点存在） |
| `atomcode status`（CLI） | ❌ 只有登录信息，且没有 `--json` |
| `~/.atomcode/codingplan_sync.json` | ❌ 只有 `last_sync_unix_secs` 时间戳 |
| **`POST /command`** | ✅ **唯一来源** |

```
POST /command   {"command":"status","working_dir":"<任意存在的目录>"}
→ 200 {"kind":"status","logged_in":true,"provider":…,"text":"…\n  CodingPlan：CodingPlan Lite-体验版  ·  到期 2026-10-19（5d / 共 7d）\n  用量：当前时间窗口用量约 77%  ·  重置于 20:32（29m 13s 后）\n…"}
```

两个实测才发现的坑：

1. **命令名不能带斜杠**：`"/status"` → `{"kind":"error","message":"unknown command: /status"}`；`"status"` 才对。TUI 里的 `/status` 是斜杠命令，但 HTTP 侧收的是裸名。
2. **`working_dir` 是必填**：缺了直接 `{"kind":"error","message":"working_dir required"}`。额度是账号级的、与目录无关，所以插件用配置的 `working_dir`，没有就用家目录兜底。
3. **失败也是 HTTP 200**：命令错误以 `{kind:"error",message}` 返回，**不能只看状态码**。

## 本地化文本的容错解析

额度**只存在于 `text` 里**（结构化字段只有 `kind`/`logged_in`/`username`/`provider`/`model`/`working_dir`/`config_path`），而且文本会随界面语言变。所以 `lib/quota.js` 尽量按**结构**而非措辞解析：

- 认 `CodingPlan`（专有名词，不翻译）+ 第一个冒号 → 套餐名 / 到期日（ISO 日期）/ 括号里的窗口（`5d / 共 7d`）
- 认含 `%` 的那一行 → 百分比 + `HH:MM` 重置时刻 + 括号里的倒计时（`29m 13s` → 秒）
- `Hh`/`Mm`/`Ss` 是数字，中英文都吃；中英文标签词各自兜底

**解析不出来绝不编数字**：`usagePercent` 为 `null`，并**把原始行一起带上**，面板原样显示 —— 宁可显示原文，也不显示一个假百分比。同理 daemon 没运行时给的是 `available:false` + 原因，不是 0%。

**还有两种"看起来解析成功了"的行，也一律拒绝**（AtomCode 评审 v0.4 提交时指出，早于任何用户报告）：

| 行形状 | 旧行为（错） | 现行为 |
|---|---|---|
| `用量：折扣 20% 当前时间窗口用量约 77%` | 取**第一个** `%` → 报 20，且 `found=true` → **drift 不亮** | `parseIssue: 'multiple-percentages'`，不报数 |
| `Usage: 100% remaining` | 当成已用 100% → `limited=true`，面板喊"已用尽" | `parseIssue: 'reverse-semantics'`，不报数 |

两者的共同点是**数字存在、有限、却不是窗口用量**，比"没有数字"更坏，因为没有任何东西标记它。所以：

- 一行里多于一个百分数 → 拒绝。**不**改成"锚定 label 后第一个 %"：`"Usage: 20% off, …"` 里 label 在前，锚定后拿到的仍然是 20。
- 行内含"剩余 / remaining / left" → 拒绝。**不**自动换算 `100 - x`，那同样是猜。
- 拒绝必须让 `drift` **亮起来**（`found` 现在带 `parseIssue === null` 条件）。此前只认"什么都没解析出来"，认错了就静默——那是 drift 信号本来的用途被漏掉。
- 反向语义的匹配词刻意收窄（`剩余|remaining|\bleft\b`）：宽到裸 `余` 会连 余额/余裕 一起命中，把**健康的额度整个 blackout**，那是反方向的同一种伤害，所以有一条专门的反向控制测试守着。

## 面板行为

- 百分比 + 进度条；**只有窗口用尽（100%）才用错误色**，其余用正常色，不制造假警报
- 倒计时是**本地推算**的（`resetInSecs` + 快照的 `fetchedAt`），所以两次轮询之间它会继续走，而不是冻结在服务端那句话
- 额度分支进快照的 `quota` 字段，随 `/api/atomcode-bridge/stats` 一起返回
- **面板是单色进度条，不是分段条。** daemon 的 `status` 文本只有总量，没有 system/tools/message 的拆分——画分段就是编造一个本插件拿不到的数字。

## 紧凑标签 `atom · 19% · 2h41m 后重置`

详情页卡片之外，插件还在**输入框下方的 dock 行**挂了一个紧凑额度标签——和宿主自己的读数排成一排：

```
[权限] [计划] [模型选择器] …………………… [麦克风] [发送]
[7 轮 141 步 · 139 tok/s] [21.4M tok · 缓存命中 99%] [atom · 19% · 2h41m 后重置] [◔ 24%]
```

> **标签报的是「这个窗口用了多少 + 还有多久重置」，不是套餐周期。** 早先它写成
> `atom · 5小时 19%`，把计划窗口名当成了额度窗口的名字——7 天套餐会被标成「5小时窗口」。
> 计划周期（`3d / 共 7d`）现在只出现在弹出的面板里。
> ⚠️ `README.md` 页首那张截图是这次改版**之前**拍的，dock 上还是旧写法
> （`atom · 3d / 共 7d 0%`）；文字说明以本节为准，图待重拍。

> 圆环在**最右**，不是我们排出来的：宿主那行是 `[renderSlot(dock), ContextMeter]`
> 两个兄弟节点，ContextMeter 不是 slot occupant，所以它永远画在所有 dock 条目之后。
> `order` 再大也只能排到它左边。

槽位是**查了 DSH 客户端自带的槽位契约表**才选的（`kind`/`scope`/summary 都声明在客户端包里）：

| 槽位 | kind | 占用情况 | 契约说明 |
|---|---|---|---|
| **`conversation.composer.dock`** | list | 已有 `dsh-client-ui-chat` 的 `stats`（order 0） | "Ambient entries below the composer card." ← **本插件用这个** |
| `conversation.input.right` | list | ✅ 空 | "Compact controls before the composer submit action"——**发送键旁的操作行** |
| `conversation.input.activity` | **single** | ❌ 已被 `dsh-experimental-client-ui-voice-input` 占用 | 契约上最贴切（"Compact action after the model selector"），但**单占用**——硬注册会挤掉语音输入那个按钮 |

**一开始挂在 `conversation.input.right`，是错的。** 那个槽位的契约摘要写得很清楚：它是
**发送键之前**那一行，也就是麦克风和发送按钮所在的地方——**操作控件区**。把一个"读数"塞进去，
用户会把它当成一个按钮，而且它挤在提交控件旁边。所以搬到了 `conversation.composer.dock`：
**额度是仪表读数，就该和仪表读数待在一起。**

排序用 `order: 1`——排在宿主 `stats`（order 0，出 `7 轮` / `21.4M tok`）之后，
官方 decoration 模板（order 5）之前。宿主 CSS 已经给了 `gap:12px` 和 `align-items:center`，
所以间距是继承来的，不需要自己写外边距。

> **`.dock:empty{display:none}`** —— dock 没有任何 occupant 时整行折叠。
> 所以"额度未知就不占位"是**宿主保证的布局行为**，不是靠组件自己判断该不该渲染。

**样式刻意做弱**（无 pill 底色、无边框、三级标签色）：dock 那行是**读数条**，不是工具栏，
里面不该有看起来"可按"的东西。唯一的例外是**窗口用尽**——那时会限流，必须显示成错误色。

行为：

- 文本 `atom · <用量>% · <倒计时> 后重置`（例 `atom · 19% · 2h41m 后重置`），**点击弹出小面板**，逐行列出完整信息（套餐 / 到期 / 窗口 / 实时倒计时）
- **只有窗口用尽（100%）才变错误色**，其余正常色，不制造假警报
- **额度未知时渲染 `null`** —— daemon 停了不会在输入框里留一个永久错误徽标（原因仍在详情页）
- 槽位不存在（无 composer 的宿主）时静默降级，不影响详情页卡片

### 为什么是弹窗而不是原生 tooltip

原来那版用 `<span title>`。原生 tooltip 有三个具体问题，不是排版偏好：

1. **它把四件事压成一行**，读起来是一串噪音（`CodingPlan Lite-体验版 · 2026-10-19 · 5d / 共 7d · 5 小时窗口已用 18% · 约 3h22m 后重置`）；
2. **倒计时是死的**——浏览器在悬停那一刻绘制一次 `title`，读到时已经不准；
3. **没法排版**：没有分隔行、没有进度条、宽度不可控。

弹窗形态照抄宿主自己的 `ContextMeter`（`dsh-client-ui-conversation`）：

```
<span ref>
  <Tooltip label=… disabled={open}>      ← 面板打开时禁用，避免两个 tooltip 打架
    <button aria-haspopup="dialog" aria-expanded={open}>
  </Tooltip>
  {open && createPortal(<div role="dialog">)}   ← portal 到 document.body
</span>
```

Escape 关闭、点击外部关闭、`side:"top"` / `gap:8` / `margin:12` —— 都有现成的官方 hook。
面板里的倒计时按 1s tick，用 `liveRemaining()` 从 `fetchedAt` **本地推算**，不显示服务器那串冻结的 `"29m 13s"`；
tick 只在面板打开时跑（否则每个会话的 composer 每秒都会重渲染）。

> **不需要在 `package.json` 加 `dsh.client.inject`。** `react-dom` 与
> `@deepseek-ai/dsh-client-ui-primitives` 都在 web boot 的静态 seed 表里，
> loader 的 `require()` 先查 seed 表再查已注册工厂，所以工厂里直接 `require` 就能拿到。
> 两者仍然**防御性 try/catch**：工厂抛错会连带拖垮它的消费者，所以缺 seed 时降级回原生 `title`，
> 而不是让插件装载失败（`test/client-fns.test.mjs` 有这条降级路径的断言）。
