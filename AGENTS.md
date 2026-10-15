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
| **换 AtomCode 用的模型 / 改默认档位** | `README.md` §「怎么换 AtomCode 用的模型」；`docs/AtomCode-CLI与daemon接口参考.md` §4「`POST /chat` 的请求体字段」 | host 侧 `lib/index.js` 的 `resolveProvider()`（顺序：调用参数 > 面板选择 > `default_provider` / `review_default_provider`）+ `lib/provider-store.js`（`provider.json`）；渲染侧 `client.js` 的 `providerSelectModel()` / `ProviderSelectRow`（详情页「运行环境」卡里两个下拉，一行两格） | 本文件**红线 8**（两条命名空间 + `config.toml` 只读）。单次换模型传调用参数 `provider` 就够；持久改默认**在面板上点**，不用碰任何配置文件 |
| **详情页那张卡该显示什么 / 放哪儿** | `client.js` 的 `turnBoundaryRows()`（「回合边界」卡）与 `providerRows()`（「运行环境」卡）；座位在 `apply()` 里 | 上面「面板的显示纪律」一段 | ①**恒定值不是信息**，patch-only 旋钮要标"你改过/插件默认"，判断来自 host 的 `config.authored`/`config.defaults`；②**座位读契约摘要不读名字**——面板属于 `plugins.bundle.config`（描述与 rows **之间**），不是 `plugins.detail.section`（rows **之后**） |

## 项目一句话

DSH 插件：把本机已登录的 **AtomCode**（官方二进制，终端 AI 编程助手）作为**侧边工具台**接入 DeepSeek Harness。
注册**两个工具**：`atomcode_ask`（侧边咨询，一个完整自主回合）与 `atomcode_review`（one-shot 代码评审）。
Host（Node/cordis）只做五件事：注册工具、开一个只读统计路由 + 一个只写插件自己 state 的偏好路由、管 daemon 生命周期、解析额度、持有 `provider.json` 偏好；Client（React bundle）渲染详情页统计卡片、模型下拉与输入框额度标签。

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
| `ctx.webServer.register({kind:'exact', path})` | **两条路由**：`/api/atomcode-bridge/stats`（只读快照）与 `/api/atomcode-bridge/provider`（面板的模型选择写入点，写插件自己的 `provider.json`）。两条都同源门禁 | 面板与 chip 永久 `null`（客户端渲染 `—`）；provider 路由没了则两个下拉**禁用并写出原因**（不是空下拉） |
| `ctx.effect(fn)` | 卸载时注销工具与路由 | **注意语义**：它执行 `fn` 当 setup，把返回值当 cleanup |
| `ctx.logger?.warn` | 可选，全部日志都带 `[atomcode-bridge]` 前缀 | — |
| `client` 侧 `ctx.slots.inject/register` | 两个 seat：详情页 `plugins.bundle.config`（**keyed，`key` = 包名**；有 `view: 'summary'\|'page'`，渲染在**描述与 rows 之间**；缺它时回落到 `plugins.detail.section`，那个是 list seat、渲染在 rows **之后**）+ 输入框下方 `conversation.composer.dock`（额度读数，`order: 1`） | 有 try/catch 兜底，缺 seat 只降级。**只允许一个 seat 拿走面板**——两个都注册会在新宿主上渲染两遍 |
| `client` 侧 `require('react')` | 工厂期取 React，**必须**是 app 同一个实例 | 取错实例 → hooks 报错 |
| `client` 侧 `require('react-dom')`、`require('@deepseek-ai/dsh-client-ui-primitives')` | chip 弹窗的 `createPortal` / `Tooltip` / `useAnchoredPosition` / `useDismissOnOutsidePointer` | **不需要加 `dsh.client.inject`**：两者都在 web boot 的 seed 表里，`require()` 先查 seed 表。仍要 try/catch——工厂抛错会连带拖垮消费者，缺 seed 时降级回原生 `title`（`test/client-fns.test.mjs` 守着这条） |

配置项一律走 `rawConfig` 里 `{get()}` 盒子的手工解包（本插件无 schemastery Config schema），
每个字段都自带类型兜底 —— 加载器 patch 送来的配置是未校验的，**别改成信任输入**。

## 面板的显示纪律（2026-10 那张卡被用户嫌弃"又丑又多字"之后写的）

**先说一条元纪律（下面所有教训都是它的实例）：注释也是契约，而注释没有测试。**
本仓库一个回合内放出过三条**过期注释**：`cordis.patch.yml` 里 `default_provider` 同时挂着
两段互相矛盾的 `Precedence:`（加面板时漏删了旧那段）、`review_working_dir` 描述了一个
**代码刻意拒绝**的回退（"空 = 用 host 进程 cwd"，而 `lib/index.js` 是明说不猜仓库并拒绝调用）、
README 与治理记录写的"6 个纯函数"实际是 12 个。三条都没被任何测试抓到——因为它们都在注释里。
`wiring.test.mjs` 现在有一条**注释一致性测试**：`default_provider` / `review_default_provider`
各只许出现**一次** `Precedence:`且必须含面板；`review_working_dir` 必须写明"拒绝"而非"回落"。
**改了这些字段的行为，就顺手改注释，否则那条测试会红**——这是刻意的。
数字同理：**别把会变的计数写进文档**（写过"6 个纯函数""175 条 test"，都过期了）。

详情页那张卡曾经有 **6 行恒定值**（`来源`、`路径`、`审批模式`、`默认工作目录`、`ask 轮数上限`、
`评审可用性`），用户的原话是「感觉插件又丑又多字呢」。教训不是"排版要好看"，是三条：

1. **恒定值不是信息。** `自动探测`、`bypass（插件默认）`、`（会话工作目录）`、`25（有界）` 报告的都是
   **用户没拨过的旋钮**。它们要么删、要么折叠，要么（如果它承载风险，如 `bypass`）标出"这是缺省"。
   判据：**这一行在用户不改任何东西时会变吗？** 不变就不该占正文。
2. **同一件事不说两遍。** `来源: 自动探测` + `路径: 自动探测（PATH）` 曾经是两行一句话；
   现在 `来源` 并进路径行，不再单独出现。
3. **每个空态/异常态要说自己的因。** 两个下拉曾共用一句
   「本机没有可选项（ask 取 daemon /models，review 取 config.toml 的直连条目）」——于是 ask 的空态
   用 **review 的来源**解释自己。现在 ask 说 `daemon 未列出档位`、review 说 `config.toml 里没有直连条目`。
   长溯源下沉到 hover `title`：它是**控件的说明**，不是系统的状态。

配套两条硬纪律：

- **"你改过没有"必须问 host，且问的是"跟出厂缺省一不一样"，不是"配置里有没有这个键"。** patch-only 的旋钮
  （`approval_mode` / `working_dir` / `ask_max_rounds`）在面板上没有输入框，所以快照带 `config.authored`
  （host 判定**该值是否偏离**插件自带 `cordis.patch.yml` 里的缺省）与 `config.defaults`（那份缺省）。
  两条都是血：①渲染侧 `askMaxRounds === 25` 是**第二份 25**，`lib/index.js` 一改就撒谎；
  ②**"键存在"当"改过"也是错的**——随插件发布的 patch **每个键都显式写**（它就是字段注释真源），
  于是 stock 安装上 `authored` 全为 true，每行都挂「已改」。实机就是这样：用户没动过任何东西，
  `bypass` 与 `25` 却显示「已改」。**判据是"值 != 出厂缺省"**。
  另：拿不到 `authored`（旧宿主）时渲染侧不许猜——**只有真能比出差异才贴标签**，
  否则留空（`unknown`），与"解析不出来的额度不许编数字"同源。
- **同一字段两个端点的形状可能不同，别用一个映射函数盖过去。** 实测（atomcode 5.2.3）：
  `GET /models` 给的是**对象数组** `{provider, model, isDefault, effortLevels}`，
  而 review 的直连条目是**字符串数组**。两者都进 `providerSelectModel()`，
  曾经一起走 `map(name)`（只认字符串）→ **ask 下拉整个是空的**，而 review 正常。
  这条 bug 被上面第 3 点那句共用文案**掩盖**成了"像是文案问题"，隔了一轮才被实机快照抓出来。
  取下拉值只取 `provider`（档位名）；`model`（裸 id）两条路都不认（红线 8）。
- **面板要占"描述与 rows 之间"那个座位，不是"详情页随便哪个座位"。** 面板原先注册在
  `plugins.detail.section`——只因为那个名字读着像"插件详情页"。它其实是 **list seat、渲染在
  shipped rows 之后**，于是读数落在 `运行统计`/`包含的组件` 下面；而兄弟插件 sensenova 用
  `plugins.bundle.config`（`kind: keyed`，`key` = 包名，契约原文 "rendered on the bundle's page
  between its description and its rows"），所以在上方。**座位名像什么不代表它渲染在哪**——
  这是红线 7 的同一条教训第二次发生（第一次是 `conversation.input.right`）。
  该 seat 还带 `view: 'summary' | 'page'`：`summary` 是插件卡片的一行摘要，**只许一行**。
- **`manifest.description` 必须是字符串，多语言靠 `locale/` 目录——不是 package.json 里塞对象。** 面板的
  title/description 由 `dsh-app-boot` 的 `readPluginMeta()` 解析，真实机制是：
  ①`<pkg>/locale/en.json` 是**扫描锚点**（没有它一个字典都不加载）；
  ②同目录每个 `*.json` 按**文件名**当语言 id（本项目是 `en` / `zh`，与宿主 `LOCALE_IDS = ["zh","en"]` 一致）；
  ③文件形状是 `{ "meta": { "title", "description" } }`；
  ④`manifest.description` 只当**英文兜底**，且经 `fallbackText()`——**只认非空字符串，对象一律返回 undefined**。
  所以把 `description` 写成 `{ en, zh }` 对象会**静默清空描述**，页面只剩包名（踩过，一轮后才发现）。
  另外 `files[]` 必须含 `locale`，否则安装副本里没有字典。`test/client-id.test.mjs` 钉住全部四条。
  同一个字符串不要两头写：卡片的 `summary` 视图已由宿主渲染描述，**别再硬编码一句简介**（那是第二份真源，
  而且正是"英文墙"的来源）；`summary` 现在只报描述说不了的东西——daemon 活没活。
- **布局：不要把整个面板钉死宽度。** `wrap.maxWidth` 曾是 `760px`，于是宽窗口下留大片空白、
  且两列卡片永远用不上多余空间；`grid` 还写成硬编码 `1fr 1fr`，**任何宽度都是两列**。
  现在是 `maxWidth: 1180px` + `repeat(auto-fit, minmax(320px, 1fr))`：窄屏 1 列、宽屏 3 列。
  行高也钉了 `lineHeight`/`minHeight`，否则一行换行的那张卡会比邻居高，两列的行距对不齐。

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
   插件侧旋钮是**两个字段 + 面板两个下拉、各管一条路**：`default_provider`（ask）与
   `review_default_provider`（review）是文件侧缺省，面板选择（`provider.json`）**优先于**它们。
   顺序是：**调用参数 > 面板选择 > 配置字段 > 原有默认**。**留空的行为两条路不一样，别说成一句**：
   ask 留空**连 `provider` 字段都不发**（AtomCode 自己的默认说话）；review 留空是**回落到自动选择**，
   而自动选择几乎总会显式交出 `--provider`（config.toml 的默认命中、或唯一直连条目顶上）。
   顺带一条同源教训：**工具描述只许讲顺序，不许讲结果**——描述在挂载时注册一次，而面板选择每次调用才读，
   所以"留空即点名它"这类固定结论必然在某些状态下是假的（评审已经抓过两次）。
   边界在这儿：**面板写的是插件自己的 state 文件，这是允许的，也是这个功能的意义**；
   **`~/.atomcode/config.toml` 永远只读**——改全局默认是 AtomCode 侧的事
   （`default_provider`/`default_model` + `POST /config/reload`）。谁把写入点挪到那个文件上，
   就是踩这条红线（`test/stats-route.test.mjs` 里"写一次 pick 后 config.toml 逐字节不变、
   `~/.atomcode` 下不得出现任何 provider 文件"就是钉它的）。

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