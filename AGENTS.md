# AGENTS.md — AI 会话纪律

给 AI 协作会话的第一站。不重复 `docs/` 的内容，只钉死：**去哪查、怎么验证、什么红线**。
每次会话先读本文件；细节按下面的文档地图跳。

## 探索顺序（按任务挑一条路，别从头读到尾）

本文件是**纪律文件不是教程**：钉死红线、验证、导航，不教一步步做。

| 你的任务 | 第一站（先读） | 第二站（再读） | 动手前确认 |
|---|---|---|---|
| **额度读数改了不显示 / 位置不对** | 本文件红线 7（座位怎么挑） | `dsh-cordis-client-runner/lib/client.js` 里 `key: "conversation.composer.dock"` 的契约（`kind`/`scope`/`occupants`） | 座位的**摘要**是不是"ambient entries"这一类，而不是按名字挑 |
| **chip 弹窗 / portal / Tooltip 行为** | `README.md` §「为什么是弹窗而不是原生 tooltip」 | `dsh-client-ui-conversation` 的 `ContextMeter`（宿主同款交互的抄写对象） | 两个 seed 模块（`react-dom` / `dsh-client-ui-primitives`）是否还在 seed 表里 |
| 改 host 逻辑 / 加配置字段 / 加路由 | 本文件「三条事实」「红线」 | `lib/index.js`（`apply` 是唯一装配点）→ `cordis.patch.yml` 对照字段注释 | `npm test` 里的 `wiring` / `stats-route` |
| 改额度解析 / 面板渲染 | `lib/quota.js`（纯函数，无宿主依赖） | `test/quota.test.mjs` + `test/protocol.test.mjs` | 解析不出来时**必须**回落到原文，不得编数字 |
| 排查"为什么没生效 / 报错" | 本文件「工作目录与装载方式」 | `lib/daemon.js`（daemon 探测真源） | 先分清 Host 进程 vs Client 控制台 |
| daemon 起不来 / 端口被占 | `lib/daemon.js` 的 `ensureDaemonStarted` | `docs/AtomCode-CLI与daemon接口参考.md`（端点与启动参数） | 13459 与 AtomCode TUI 的 13456 是刻意分开的 |
| `atomcode_review` 报不可用 | 本文件红线 1 | `lib/review.js` 的 `checkReviewProvision` | 这是**本机配置事实**，不是临时故障 |
| 加/改 client 槽位 | 本文件「宿主 ABI 面」 | `test/client-id.test.mjs`（注册契约门禁） | 改 seat 名必须同步改那条测试的断言 |
| **换 AtomCode 用的模型 / 改默认档位** | `README.md` §「怎么换 AtomCode 用的模型」；`docs/AtomCode-CLI与daemon接口参考.md` §4「`POST /chat` 的请求体字段」 | `lib/index.js` 的 `defaultProvider` / `reviewDefaultProvider` + `pickAskProvider()` / `pickReviewProvider()` | 本文件**红线 8**（两条命名空间 + 只读边界）。单次换模型传调用参数 `provider` 就够，不用改插件 |

## 项目一句话

DSH 插件：把本机已登录的 **AtomCode**（官方二进制，终端 AI 编程助手）作为**侧边工具台**接入 DeepSeek Harness。
注册**两个工具**：`atomcode_ask`（侧边咨询，一个完整自主回合）与 `atomcode_review`（one-shot 代码评审）。
Host（Node/cordis）只做四件事：注册工具、开一个只读统计路由、管 daemon 生命周期、解析额度；Client（React bundle）渲染详情页统计卡片与输入框额度标签。

**三条事实**（写代码前先认清你在动哪一条）：

1. **v0.3 有意不做 provider 接管。** 最初的"AtomCode 作为模型提供方"设计已被删除：
   一个自带工具循环 + 绕过审批的完整 agent 塞进 DSH 的单 completion 插槽，会破坏 DSH 的工具循环、
   穿透它的权限模型、并把 O(N²) tokens 灌回每个会话轮次。**别把它"加回来"**——这是决定，不是疏漏。
2. **额度是从本地化文本解析出来的，不是 API。** AtomCode 没有额度 HTTP 接口，唯一来源是
   `POST /command {"command":"status"}` 返回的 `text`。解析不出来时**绝不编数字**，原样显示原文
   （`lib/quota.js` 的 `reason` 字段）。这条是本插件唯一"看起来能改成读 JSON"的地方，而它不能。
3. **三条私有无版本协议无握手可谈。** `/chat` SSE 词表、`status` 本地化文本、review CLI 的 provider 解析，
   都会随二进制升级悄悄漂移。v0.4 的答案不是握手而是**可观测降级**：静默失败必须变成
   面板上的具名诊断或 `protocol.quotaTextDrift` 信号（回归守卫 = `test/protocol.test.mjs`）。

## 工作目录与装载方式（先搞清你改的东西怎么生效）

- 本目录 `~/.dsh/plugins/dsh-atomcode-bridge` 是**开发副本**；web 端以符号链接载入
  （`~/.dsh/profiles/web/node_modules/dsh-atomcode-bridge` → 本目录，见 `.package-map.json`）。
- **浏览器与 Host 执行的是磁盘上的这个目录本身**——本插件没有 `src/` → `lib/` 构建层，
  改完直接刷新页面即可（与兄弟插件 qoder / sensenova 不同：它们有 `tsdown` 构建，别把那条纪律搬过来）。
- 桌面端走安装副本；以 `~/.dsh/profiles/{web,desktop}/node_modules` 里的实际 junction 为准。
- `client.js` **是手写产物，不是生成物**：它是提交进库的 IIFE，不许当"构建输出"删掉或 gitignore，
  也没有 `Generated … edit the sources` 头。改它就是改源码。
- `.gitignore` 里 `node_modules/`、`dist/`、`upstream/` 都是为了防误提交；
  `lib/`、`client.js`、`test/`、`docs/` **都要入库**（GitHub 直装源不跑 prepack）。
- **`upstream/` 绝不入库，与兄弟插件一致**（sensenova / agnes / modelscope 三家都写了
  `/upstream/` 且 `git ls-files upstream/` 为 0）。理由**不是体积**（本仓库那份才 0.2 MB），
  而是它是**自带 `.git` 与 remote 的嵌套 clone**（`baimocn/atomcode-open-api`）：
  `git add upstream/` 会把它加成 **gitlink（mode 160000）**，凭空造出一个没人维护的隐式
  submodule，之后 `git status` 永远多一条脏记录。参照件一律"本机容纳、不进本仓库历史"。
  **它的产权/出处说明在 `README.md` 的「✅ 已验证的修法：本地代理 + 直连 provider」一节**
  （MIT / Python / "不参与构建"都在那里写的），**不在「许可」**——改那条说明时记得这里指的还是它。

## 宿主 ABI 面（本插件实际用到的，别的都别碰）

| 面 | 用途 | 坏了会怎样 |
|---|---|---|
| `ctx.tools`（`ctx.get('tools')`） | 注册两个工具 | `apply` 早退，插件静默不挂 |
| `ctx.webServer.register({kind:'exact', path})` | `/api/atomcode-bridge/stats` 只读路由 | 面板与 chip 永久 `null`（客户端渲染 `—`） |
| `ctx.effect(fn)` | 卸载时注销工具与路由 | **注意语义**：它执行 `fn` 当 setup，把返回值当 cleanup |
| `ctx.logger?.warn` | 可选，全部日志都带 `[atomcode-bridge]` 前缀 | — |
| `client` 侧 `ctx.slots.inject/register` | 两个 seat：详情页 `plugins.detail.section` + 输入框下方 `conversation.composer.dock`（额度读数，`order: 1`） | 有 try/catch 兜底，缺 seat 只降级 |
| `client` 侧 `require('react')` | 工厂期取 React，**必须**是 app 同一个实例 | 取错实例 → hooks 报错 |
| `client` 侧 `require('react-dom')`、`require('@deepseek-ai/dsh-client-ui-primitives')` | chip 弹窗的 `createPortal` / `Tooltip` / `useAnchoredPosition` / `useDismissOnOutsidePointer` | **不需要加 `dsh.client.inject`**：两者都在 web boot 的 seed 表里，`require()` 先查 seed 表。仍要 try/catch——工厂抛错会连带拖垮消费者，缺 seed 时降级回原生 `title`（`test/client-fns.test.mjs` 守着这条） |

配置项一律走 `rawConfig` 里 `{get()}` 盒子的手工解包（本插件无 schemastery Config schema），
每个字段都自带类型兜底 —— 加载器 patch 送来的配置是未校验的，**别改成信任输入**。

## 去哪参考（本机就有，别再全网瞎找）

| 要找什么 | 位置 |
|---|---|
| **同类插件实载副本**（含 `AGENTS.md`、`docs/`、`upstream/`） | `~/.dsh/plugins/dsh-connect-sensenova-token-plan/`、`dsh-connect-qoder/` |
| **本插件的槽位契约真源**（kind / occupants / standardProps） | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-cordis-client-runner\lib\client.js`，搜 `key: "conversation.composer.dock"`（额度读数用这个）与 `key: "conversation.input.`（操作行，别放读数） |
| **输入框渲染真源**（哪个 seat 画在哪） | 同上 runtime 的 `dsh-client-ui-conversation/lib/client.js`，搜 `renderSlot("conversation.composer.dock"`——它和 `ContextMeter` 是同一个 dock 行的兄弟节点 |
| **dock 行里已有哪些 occupant** | `dsh-client-ui-chat/lib/client.js`，搜 `conversation.composer.dock`：`id: "stats"`、`order: 0` 出 `7 轮 / 21.4M tok`；官方装饰模板 `dsh-agent-preset/skills/.../templates/decoration/client.js` 用 `order: 5` |
| **模型选择投影**（`next` 优先于 `lastUsed`） | 同上 runtime 的 `dsh-api-session-controller`，`key: "modelSelection"` |
| **额度/用量面板的母版**（双上游 tab 栏） | `~/.dsh/plugins/dsh-connect-sensenova-token-plan/src/client/` |
| **AtomCode 侧接口实测** | 本仓库 `docs/AtomCode-CLI与daemon接口参考.md` |

> ⚠️ **别搜 `~/.dsh/dsh-asar-unpacked`。** 那是 2026-09-26 的桌面端 0.1.7-rc.2 旧副本，
> web 端实跑的是全局 CLI 树 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules`（0.2.0-rc.1）。
> 两者槽位契约已经不一致（旧树里根本没有 `conversation.input.dock`，且 slot `source` 行号不同）。
> 兄弟插件 `dsh-connect-sensenova-token-plan/test/peer-roots.mjs` 把候选根顺序写清楚了——先读它再决定去哪找。

## 验证（按域裁剪）

```bash
npm test        # 离线门禁，全部走假 daemon / 假 spawn / 纯函数，零网络零额度
npm run test:live   # 需要本机已登录的 AtomCode；真实模型回合需再显式 ATOMCODE_LIVE_TURNS=1
node test/quota.test.mjs   # 单套件（其余同理，改文件名即可）
```

- **本文件不写套件数与 test 数。** 上一次写死"175"之后 **13 分钟**，并行会话就往链里加了
  `review-select`，数字当场过期。要计数自己量：
  `npm test 2>&1 | Select-String '^ℹ pass' | Measure-Object`（行数=链内套件数）；
  链的名单看 `package.json` 的 `scripts.test`。**只看自己域的增减**，别去对总数。
- `npm test` **不消耗额度**、不联网：全部用假 daemon / 假 spawn / 纯函数。
- `test:live` 默认也**不消耗额度**——只有 `ATOMCODE_LIVE_TURNS=1` 才会跑真实回合。
- **动了契约/接缝文件，跑全量**：`client.js`、`lib/index.js`、`cordis.patch.yml`、`package.json`。
  消费者不可枚举——按域裁剪会漏掉跨域契约。判断标准：这个文件的消费者我数得清吗？数不清就全量。
- **改了 `package.json` 的 `scripts.test` 链要连带核对磁盘**：仓库里有过"新套件写好了但没挂进链里"，
  于是 `npm test` 全绿而它一次没跑。挂链时顺手确认 `test/` 下每个 `*.test.mjs` 都在链里。

## 红线（违反任一都会炸到用户机器）

1. **`atomcode_review` 在 AtomGit 登录态下用不了，这不是 bug。** 网关对推理端点强制 AtomCode 专有签名
   （未签名请求 → `ATOMCODE_SIG_MISSING`），而 review CLI（`atomcodex`）不会签。插件在挂载时静态探针
   `~/.atomcode/config.toml`，把 `atomcode_review` 的**工具描述**降级成"本机不可用 + 改用 ask"，
   让模型**调用前**就知道。修法只有一个：加一个标准 + 显式 `api_key` 的直连 provider。
   **别把这个探针删掉或改成运行时才检查**——它是"调用前告知"而非"调用后报错"的关键。
2. **解析不出来的额度不许编数字。** `lib/quota.js` 解析失败返回 null + `reason`，面板显示原文或原因。
   "显示 0%"比"什么都不显示"危险得多。
3. **不新增静默失败分支。** daemon 起不来、配额不可用、路由缺失，都要么给用户可见的状态，
   要么显式降级（`return null`），不许 `catch` 后吞掉。客户端所有 slot 注册都包了 try/catch，
   新增 seat 要照抄这个形状。
4. **配置项永不信输入。** 每个字段都要类型兜底（加载器 patch 送来的配置未校验）。
5. **`ctx.effect(fn)` 的返回值是 cleanup，不是 setup 结果。** 把 disposer 直接在函数体里调用
   会让工具在挂载瞬间就被注销。
6. **`client.js` 的注册 id 必须是 `package.json` 的 `name` 逐字一致**（`dsh-atomcode-bridge`）。
   写错不会当场报错，而是"加载成功但没注册"，直到 web boot audit 才炸（`test/client-id.test.mjs` 守着这条）。
7. **别碰 single 座位的座位，也别按名字猜座位。** `conversation.input.activity` 是 `kind: "single"`
   且已有主人（语音输入插件），硬注册会挤掉它。更常见的错是**按槽位名挑**：
   `conversation.input.right` 名字看着像"随便放个读数"，它的契约摘要却是
   "Compact controls before the composer submit action"——**发送键旁的操作行**，把仪表塞进去
   用户会当成按钮。额度读数住在 `conversation.composer.dock`（"Ambient entries below the composer card"），
   与宿主的 `7 轮 / 21.4M tok / 上下文圆环` 同排，`order: 1`（宿主 stats 占 0，装饰模板占 5），
   样式刻意做弱（无 pill 无边框、三级色），因为那是读数条不是工具栏。
   **挑座位前先读契约摘要，不读名字。**
8. **模型档位的两条命名空间不许混，且插件对 `~/.atomcode/config.toml` 永远只读。** ask 走 daemon `/chat`，
   `provider` 收的是**档位名**（= `GET /models` 的 `provider` 字段 = config 里 `[models."<名>"]` 的键
   = `default_provider` 的值，形如 `AtomGit-glm5.3-flash`）；review 走 CLI，`--provider` 收的才是
   `[providers.<name>]` 直连条目名（形如 `atomcode-local`）。裸模型 id（`glm5.3-flash`）两边都不认。
   插件侧旋钮是**两个字段、各管一条路**：`default_provider`（ask）与 `review_default_provider`（review），
   各自"调用参数 > 该字段 > 原有默认"，**留空连字段都不发**。曾经一版用同一个字段喂两条路——那正是
   这条红线要防的错，现在由 `wiring.test.mjs` 双向钉住互不渗漏。
   "面板上放个按钮直接改默认模型"看着像顺手的事，实际要写的是**别人应用的配置文件**——那是 AtomCode 侧的
   `default_provider`/`default_model` + `POST /config/reload`。**别把这条只读边界改成读写。**

## 并行会话纪律

工作树常同时有他人未提交改动（本文件写下时就有另一会话在改 `lib/index.js`、`lib/quota.js`、
`protocol.test.mjs`，`lib/index.js` 在几十分钟内从 682 行长到 853 行）：

- **不碰 `git stash / push / pop`**（`status/log/show` 只读可用）。
- 提交用路径限定：`git commit -m "<说明>" -- <自己的文件>`；禁 `git add -A` / `add -u`。
- ⚠️ **路径限定提交带不上 untracked 新文件**（2026-10 撞过：新文件不在索引里，`-- <路径>` 不含它）。
  新文件先 `git add <文件>`，再不带路径 `git commit` 提交索引。
- 提交后 `git status --short` 复核：没带走别人的东西。
- 看到非自己改动的文件保持 modified，**不要替它做对照实验**（stash 出基线）；
  用同组文件 targeted 复跑（改前后各跑一次同一小组）定性。
- **同一个文件被两个会话改着**：优先等对方提交；必须 hunk 级提交时 `git add <文件>` 后提交索引
  （**不要** `git commit -- <路径>`，那会把工作树里对方的半改一起写入）。

## 去哪查（docs/ 地图）

| 何时 | 查 |
|---|---|
| 第一次进这个仓库 | `docs/README.md` → `../README.md`（定位、配置表、额度、已知限制） |
| 查 AtomCode 的命令 / 端点 / SSE 词表 / 签名门 | `docs/AtomCode-CLI与daemon接口参考.md`（实测速查） |
| 查 CodingPlan 套餐的 5 小时窗口规则 | `docs/AtomCode-CodingPlan网页版可用信息.md`、`docs/AtomCode-CodingPlan网页版额度卡片.md` |
| 加配置字段 | `cordis.patch.yml`（**全部字段带注释，是字段的注释真源**）+ `lib/index.js` 的 `apply` |
| 改 client 槽位 | 本文件「宿主 ABI 面」+ `test/client-id.test.mjs` |
| 协议漂移（daemon 换版本后行为变了） | `test/protocol.test.mjs`（故意说错的假 daemon 载荷）+ `protocol` 分支（面板显示 `daemonVersion` / `quotaTextDrift`） |
| 改测试前 | `test/` 各套件头注——**头注就是契约**，不是附件 |

## 已知缺口（别当成"没做"，也别当成 bug）

- **没有 `docs/PITFALLS.md`、`docs/ARCHITECTURE.md`、`docs/RELEASING.md`**——本插件没有兄弟插件那套
  事故史账本；三条事实 + 红线就是全部的判断依据。别照抄一份空的出来占位。
- **版本号目前不一致，别再新增第四处**：`package.json` 与 `lib/index.js` 的 stats body 都写
  `0.4.0`，而 `README.md` 已按 **v0.4.1** 记录了两项**已落地**的能力（`selectReviewProvider()`
  在 `lib/review.js`、`probeLocalEndpoint()` 在 `lib/index.js`，外加 `review-select.test.mjs` 的
  16 条测试）。`cordis.patch.yml` **没有 version 字段**，所以版本只有上面两处真源。
  发版前把 `package.json` + stats body 一起对齐到实际发布号，**只改一处就是撒谎**。
- **`upstream/atomcode-open-api`** 是参照件（第三方 AtomCode OpenAPI 实现，自带 `.git`），
  已被 `.gitignore` 排除、**故意不在仓库历史里**（见「工作目录与装载方式」那条）。
  它不是构建输入、不参与测试，只作接口形态的对照；出处与许可写在 `README.md` 的
  「✅ 已验证的修法：本地代理 + 直连 provider」一节（v0.4.1 的回环探活也引用它），
  **不在「许可」标题下**。
  本机 `git status` 里看不到它是**预期行为**，别去"修"，也别 `git add -f`。