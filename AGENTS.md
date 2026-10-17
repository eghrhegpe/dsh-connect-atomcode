# AGENTS.md — AI 会话纪律

给 AI 协作会话的第一站。不重复 `docs/` 的内容，只钉死：**去哪查、怎么验证、什么红线**。
每次会话先读本文件；细节按下面的文档地图跳。

## 探索顺序（按任务挑一条路，别从头读到尾）

本文件是**纪律文件不是教程**：钉死红线、验证、导航，不教一步步做。

> 📌 **下表里的 `lib/*.js` 与 `client.js` 现在都是构建产物，不是源码。**要改行为一律改 `src/`
> （host → `src/host/*.ts`，client → `src/client/*.ts`），跑 `npm run build` 后再提交——
> 直接改产物的改动下一次构建就没了。细节见「工作目录与装载方式」。

| 你的任务 | 第一站（先读） | 第二站（再读） | 动手前确认 |
|---|---|---|---|
| **额度读数改了不显示 / 位置不对** | 本文件红线 7 | `dsh-cordis-client-runner/lib/client.js` 里 `key: "conversation.composer.dock"` 的契约（`kind`/`scope`/`occupants`） | 见红线 7 |
| **chip 弹窗 / portal / Tooltip 行为** | `docs/CodingPlan-额度显示.md` §「为什么是弹窗而不是原生 tooltip」（机制档案已从 README 拆出，README 只留用户侧结论） | `dsh-client-ui-conversation` 的 `ContextMeter`（宿主同款交互的抄写对象） | 两个 seed 模块（`react-dom` / `dsh-client-ui-primitives`）是否还在 seed 表里 |
| 改 host 逻辑 / 加配置字段 / 加路由 | 本文件「三条事实」「红线」 | `src/host/index.ts`（`apply` 是唯一装配点；产物 `lib/index.js` 只用来**读符号**）→ `cordis.patch.yml` 对照字段注释 | `npm test` 里的 `wiring` / `stats-route` |
| 改额度解析 / 面板渲染 | `src/host/quota.ts`（纯函数，无宿主依赖） | `test/quota.test.mjs` + `test/protocol.test.mjs` | 解析不出来时**必须**回落到原文，不得编数字 |
| 排查"为什么没生效 / 报错" | 本文件「工作目录与装载方式」 | `src/host/daemon.ts`（daemon 探测真源） | 先分清 Host 进程 vs Client 控制台 |
| daemon 起不来 / 端口被占 | `src/host/index.ts` 的 `ensureDaemonStarted`（拉起/重试/单飞在那；`src/host/daemon.ts` 是它调用的传输与探测层，没有这个符号） | `docs/AtomCode-CLI与daemon接口参考.md`（端点与启动参数） | 13459 与 AtomCode TUI 的 13456 是刻意分开的 |
| `atomcode_review` 报不可用 | 本文件红线 1 | `src/host/review.ts` 的 `checkReviewProvision` | 这是**本机配置事实**，不是临时故障 |
| 加/改 client 槽位 | 本文件「宿主 ABI 面」 | `test/client-id.test.mjs`（注册契约门禁） | 改 seat 名必须同步改那条测试的断言 |
| **换 AtomCode 用的模型 / 改默认档位** | `README.md` §「怎么换 AtomCode 用的模型」 | host 侧 `src/host/index.ts` 的 `resolveProvider()` + `src/host/provider-store.ts`；渲染侧 `src/client/index.ts` 的 `ProviderSelectRow` + `src/client/rows.ts` 的 `providerSelectModel()` | 见**红线 8**。单次换模型传调用参数 `provider` 就够；持久改默认**在面板上点** |
| **详情页那张卡该显示什么 / 放哪儿** | `src/client/rows.ts` 的 `turnBoundaryRows()` + `providerRows()`；`src/client/quota.ts` 的 `quotaView()`；座位在 `src/client/index.ts` 的 `apply()` 里（**改完必须 `npm run build`**） | 上面「面板的显示纪律」一段 | ①**恒定值不是信息**，patch-only 旋钮要标"你改过/插件默认"，判断来自 host 的 `config.authored`/`config.defaults`；②座位见红线 7 |

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
   （`src/host/quota.ts` 的 `reason` 字段）。这条是本插件唯一"看起来能改成读 JSON"的地方，而它不能。
3. **三条私有无版本协议无握手可谈。** `/chat` SSE 词表、`status` 本地化文本、review CLI 的 provider 解析，
   都会随二进制升级悄悄漂移。v0.4 的答案不是握手而是**可观测降级**：静默失败必须变成
   面板上的具名诊断或 `protocol.quotaTextDrift` 信号（回归守卫 = `test/protocol.test.mjs`）。

## 工作目录与装载方式（先搞清你改的东西怎么生效）

- 本目录 `~/.dsh/plugins/dsh-connect-atomcode` 是**开发副本**；web 端以 link 依赖载入
  （`~/.dsh/profiles/web/node_modules/dsh-connect-atomcode` → 本目录，见 `.package-map.json`）。
  一键装/卸用 DSH CLI（代跑 pnpm，装完自动 reconcile `dsh.profile.bundles`，不用手改
  profile 的 `package.json` / `pnpm-lock.yaml` / junction）：
  `dsh plugin --profile web add link:C:\Users\zhujieling11\.dsh\plugins\dsh-connect-atomcode` 与
  `dsh plugin --profile web remove dsh-connect-atomcode`。GUI 插件页只装 registry 包，`link:` 开发副本走 CLI。
- **这里有一条构建纪律，和 qoder / sensenova 同款**：改 `src/` → 跑 `npm run build` →
  **源码与产物一起提交**。浏览器与 Host 执行的是磁盘上的**产物**，所以"只改源码不构建"= 改动不生效，
  "只改产物不改进源码"= 下一次构建就被抹掉。两条都由 `test/build-gate.test.mjs` 拦：
  它用真 `tsdown.config.mjs` 重跑一次构建，要求与提交的产物**逐字节**相同，跑不干净就红。
- ⚠️ **两半都已迁移，但产物的形状不一样**（别拿一半的形状推另一半）：
  · **client 半边**：真源 `src/client/*.ts` → 产物 **`client.js`（单个 IIFE，在包根）**。
    改面板 / 样式 / 额度渲染 / 座位，只改 `src/client/`。
  · **host 半边**：真源 `src/host/*.ts` → 产物 **`lib/*.js`（每个源文件一个 ESM 文件，不是单包）**。
    `lib/` 刻意**不打包成一个文件**：`wiring` / `protocol` 这些套件要往 `lib/review.js` 里装
    假 spawner（`setSpawnOverride`，模块级状态），而 `lib/index.js` 是 `import './review.js'` 用它的。
    一旦把它们捆成一坨，测试装的那份就成了**没人调用的私副本**，于是真的去跑 review CLI 了——
    这个坑踩过，见 `tsdown.config.mjs` 的 `host` 条目注释。
  · **`src/shared/` 是第三块，且只有一处**：`shared/loopback.ts` 是被**两半同时读**的模块
    （host 的 `index.ts` 与 client 的 `rows.ts` 各 import 一次），因为"这个 base_url 是不是本机端点"
    是同一个事实——host 用它决定要不要探活，渲染侧用它写那句"代理一停 review 立刻断"。它在 host 侧是
    **显式 entry**（产物 `lib/loopback.js`），在 client 侧被内联进 `client.js`。
    ⚠️ **别把共享模块 re-export 挂在别的模块上**：`export {...} from '../shared/loopback.ts'` 写在
    `review.ts` 里那一次，打包器把 `review.ts` 主体降级成共享 chunk、entry 被自动改名为
    `lib/review2.js`——而 `wiring` / `protocol` 依赖 `lib/review.js` 的模块级单例（见上一条）。
    加共享模块 = 在 `tsdown.config.mjs` 里给它一个 entry。
  · 两半都是"改 `src/` → `npm run build` → 提交源码+产物"，都由 `build-gate` 盯着。
- **测试一律打产物，不打 `src/`**（与 client 侧 `client-id` / `client-fns` 载入 `client.js` 同规矩）：
  产物才是真正跑起来的东西，而 build-gate 保证产物就是 `src/` 的忠实构建。改测试导入时**别图省事
  指向 `src/host/*.ts`**——见上一条，那会让模块级接缝失效。
- 桌面端走安装副本；以 `~/.dsh/profiles/{web,desktop}/node_modules` 里的实际 junction 为准。
- **产物不许删、不许 gitignore**：pnpm 拒绝为 git 依赖跑构建脚本
  （`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，逃生阀是安装方没有的 `allowBuilds`），
  所以"让 `prepare` 在安装时构建"是**死路**——GitHub 直装源会拿到一个 `main`/`client` 不存在的包。
  完整理由写在 `tsdown.config.mjs` 头部，那里是这段纪律的真源。
- **`client.js` 里几乎没有注释**：打包器保留声明前的 JSDoc，但**抹掉函数体内的注释**，
  而本插件把"为什么挑这个座位""为什么这个 deadline 是 4s"这类契约写在函数体里。
  所以"**注释也是契约**"那条纪律**现在指 `src/`**：改契约注释改 `src/client/*.ts`，
  改产物里的没用（下一次构建就没了）。产物只给浏览器读，别指望从它溯源。
- `.gitignore` 里 `node_modules/`、`dist/`、`/upstream/` 都是为了防误提交；探针与审查残留那两条
  （`/.probe-*.mjs`、`/.prev_*`）**只挡仓库根**——探针的正式位置是 `scripts/probes/`（**入库**，
  结论与脚本必须一起在，否则证据不可复现）。
  `lib/`、`client.js`、`src/`、`test/`、`docs/`、`scripts/` **都要入库**（GitHub 直装源不跑 prepack）。
- **`upstream/` 绝不入库，与兄弟插件一致**（sensenova / agnes / modelscope 三家都写了
  `/upstream/` 且 `git ls-files upstream/` 为 0）。理由**不是体积**（本仓库那份才 0.2 MB），
  而是它是**自带 `.git` 与 remote 的嵌套 clone**（`baimocn/atomcode-open-api`）：
  `git add upstream/` 会把它加成 **gitlink（mode 160000）**，凭空造出一个没人维护的隐式
  submodule，之后 `git status` 永远多一条脏记录。参照件一律"本机容纳、不进本仓库历史"。
  **它的产权/出处说明现在在 `THIRD_PARTY_NOTICES.md`**（MIT / Python / "不参与构建"都在那里写的），
  它的实测与风险在 `docs/AtomGit-网关与-review-通路.md`——2026-10-16 从 `README.md` 拆出去的两处。
  改任一条说明时，记得这份文件里指的是它们。

## 宿主 ABI 面（本插件实际用到的，别的都别碰）

| 面 | 用途 | 坏了会怎样 |
|---|---|---|
| `ctx.tools`（`ctx.get('tools')`） | 注册两个工具 | `apply` 早退，插件静默不挂 |
| `ctx.webServer.register({kind:'exact', path})` | **两条路由**：`/api/atomcode-bridge/stats`（只读快照）与 `/api/atomcode-bridge/provider`（面板的模型选择写入点，写插件自己的 `provider.json`）。两条都同源门禁 | 面板与 chip 永久 `null`（客户端渲染 `—`）；provider 路由没了则两个下拉**禁用并写出原因**（不是空下拉） |
| `ctx.effect(fn)` | 卸载时注销工具与路由 | **注意语义**：它执行 `fn` 当 setup，把返回值当 cleanup |
| `ctx.logger?.warn` | 可选，全部日志都带 `[atomcode-bridge]` 前缀 | — |
| `client` 侧 `ctx.slots.inject/register` | 两个 seat：详情页 `plugins.bundle.config`（首选，keyed）+ `plugins.detail.section`（回落）；输入框 `conversation.composer.dock`（额度读数，`order: 1`）。座位选择见红线 7 | 有 try/catch 兜底，缺 seat 只降级。**只允许一个 seat 拿走面板**——两个都注册会渲染两遍 |
| `client` 侧 `require('react')` | 工厂期取 React，**必须**是 app 同一个实例 | 取错实例 → hooks 报错 |
| `client` 侧 `require('react-dom')`、`require('@deepseek-ai/dsh-client-ui-primitives')` | chip 弹窗的 `createPortal` / `Tooltip` / `useAnchoredPosition` / `useDismissOnOutsidePointer` | **不需要加 `dsh.client.inject`**：两者都在 web boot 的 seed 表里，`require()` 先查 seed 表。仍要 try/catch——工厂抛错会连带拖垮消费者，缺 seed 时降级回原生 `title`（`test/client-fns.test.mjs` 守着这条） |

配置项一律走 `rawConfig` 里 `{get()}` 盒子的手工解包（本插件无 schemastery Config schema），
每个字段都自带类型兜底 —— 加载器 patch 送来的配置是未校验的，**别改成信任输入**。

## 面板的显示纪律（2026-10 那张卡被用户嫌弃"又丑又多字"之后写的）

**元纪律：注释也是契约，而注释没有测试。** 契约注释住在 `src/`（产物 `client.js` 会被打包器抹掉函数体注释，见「工作目录与装载方式」）。`wiring.test.mjs` 有一条注释一致性测试：`default_provider` / `review_default_provider` 各只许出现一次 `Precedence:`且必须含面板；`review_working_dir` 必须写明"拒绝"而非"回落"。**改了字段行为就顺手改注释，否则那条测试会红。**（同一个套件里还有一条**版本号一致性**测试，
见「已知缺口」——那条是 2026-10-16 补的。）
数字同理：**别把会变的计数写进文档**。

详情页那张卡曾经有 **6 行恒定值**，用户原话是「感觉插件又丑又多字呢」。三条教训已实现在 `src/client/rows.ts`：

1. **恒定值不是信息** → `turnBoundaryRows()` 只渲染有信息的行
2. **同一件事不说两遍** → `来源` 已并进路径行
3. **空态各说各的因** → `providerSelectModel()` 的 `reason` 按 slot 分（ask 说 `daemon 未列出档位`，review 说 `config.toml 里没有直连条目`）

配套两条硬纪律也已实现：

- **"你改过没有"必须问 host** → `turnBoundaryRows()` 用 `cfg.authored` 判定，不用渲染侧硬编码比较
- **两个端点形状不同** → `providerSelectModel()` 的 `optionValue` 按类型展平，只取 `provider`（档位名）

- **面板要占"描述与 rows 之间"那个座位。** 首选 `plugins.bundle.config`（keyed，渲染在描述与 rows 之间），回落 `plugins.detail.section`（list seat，渲染在 rows 之后）。座位选择见红线 7。该 seat 还带 `view: 'summary' | 'page'`：`summary` 是插件卡片的一行摘要，**只许一行**。
- **`manifest.description` 必须是字符串，多语言靠 `locale/` 目录。** 四条机制（锚点扫描、文件名当语言 id、`{ meta: { title, description } }` 形状、`fallbackText()` 只认非空字符串）由 `test/client-id.test.mjs` 钉住。同一个字符串不要两头写：`summary` 视图只报描述说不了的东西——daemon 活没活。

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
  `npm test 2>&1 | Select-String '^ℹ tests'`（一行，node:test 的聚合摘要）。
  套件由 [`scripts/test.mjs`](scripts/test.mjs) 自动发现 `test/*.test.mjs` 且排除 `*-live.test.mjs`，
  `package.json` 里不再有硬编码的 `scripts.test` 链——**所以新套件只要落盘就跑，不会再漏挂**（这是把
  "新套件写好了但没挂进链里"这类失误从代码层消掉，而不是靠纪律）。**只看自己域的增减**，别去对总数。
- `npm test` **不消耗额度**、不联网：全部用假 daemon / 假 spawn / 纯函数。
- `test:live` 默认也**不消耗额度**——只有 `ATOMCODE_LIVE_TURNS=1` 才会跑真实回合。
- **动了契约/接缝文件，跑全量**：`src/**`、`cordis.patch.yml`、`package.json`。消费者不可枚举——按域裁剪会漏掉跨域契约。
- **改了 `src/` 就跑 `npm run typecheck` + `npm run build` + `npm test`**（构建纪律见「工作目录与装载方式」）。
- **改动 `test/*.test.mjs` 后跑全量 `npm test`**：套件由 `scripts/test.mjs` 自动发现，
  新文件落盘就参跑——过去"新套件没挂进链"的失误从代码层消掉了（见上一节）。

## 红线（违反任一都会炸到用户机器）

1. **`atomcode_review` 在 AtomGit 登录态下用不了，这不是 bug。** 网关对推理端点强制 AtomCode 专有签名
   （未签名请求 → `ATOMCODE_SIG_MISSING`），而 review CLI（`atomcodex`）不会签。插件在挂载时静态探针
   `~/.atomcode/config.toml`，把 `atomcode_review` 的**工具描述**降级成"本机不可用 + 改用 ask"，
   让模型**调用前**就知道。修法只有一个：加一个标准 + 显式 `api_key` 的直连 provider。
   **别把这个探针删掉或改成运行时才检查**——它是"调用前告知"而非"调用后报错"的关键。
2. **解析不出来的额度不许编数字。** `src/host/quota.ts` 解析失败返回 null + `reason`，面板显示原文或原因。
   "显示 0%"比"什么都不显示"危险得多。
3. **不新增静默失败分支。** daemon 起不来、配额不可用、路由缺失，都要么给用户可见的状态，
   要么显式降级（`return null`），不许 `catch` 后吞掉。客户端所有 slot 注册都包了 try/catch，
   新增 seat 要照抄这个形状。
4. **配置项永不信输入。** 每个字段都要类型兜底（加载器 patch 送来的配置未校验）。
5. **`ctx.effect(fn)` 的返回值是 cleanup，不是 setup 结果。** 把 disposer 直接在函数体里调用
   会让工具在挂载瞬间就被注销。
6. **`client.js` 的注册 id 必须是 `package.json` 的 `name` 逐字一致**（`dsh-connect-atomcode`）。
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
9. **注册工具时，schema 不许带着数组型并集（`type: ['string','null']` 一类）到 `tools.register`。**
   宿主（当前 0.2.0-rc.1）只接受单类型字符串的 `type`：并集在 register 处被 `JsonSchemaError`
   当场拒（报错形如 `... properties.success.type must be a single type string (type arrays are not
   supported)`），`apply()` 抛错，插件**整体不激活**——没有工具、没有路由，详情页卡片只剩
   「统计信息加载失败：HTTP 404 + 1 异常」，GUI 上再无其他错误面（2026-10 事故：开发树带并集，
   已发 0.4.2 的桌面 registry 副本无并集故正常，web link 开发副本 404）。
   本插件两个工具输出里的 null 语义字段一律经 `src/host/tools.ts` 的 `hostSubsetSchema` 在 register
   处翻译：剥掉数组型 `type` 键 → annotation-only 节点（宿主校验器明确接受"无 type 键的
   unconstrained-JSON 形态"），null 语义留在字段 `description` 里。**不许折成单型**：宿主在调用
   时把返回值按 `output.schema` 校验，折成单型后每个合法 null 都会抛 `ToolOutputError`。
   `test/wiring.test.mjs` 有契约钉：注册 schema 全程无数组型 `type`，且 null 承载字段保持
   annotation-only。新增输出字段先判值域里 null 是否合法：合法 → 源里照写并集、register 处过
   `hostSubsetSchema`；宿主版本漂移拒收某子集时，走测试守卫，不静默吞。

## 并行会话纪律

工作树常同时有他人未提交改动（本文件写下时就有另一会话在改 `src/host/index.ts`、
`src/host/quota.ts`、`protocol.test.mjs`，其中一个文件在几十分钟内涨了几百行——
**具体行数不写，理由同「验证」一节**）：

- **不碰 `git stash / push / pop`**（`status/log/show` 只读可用）。
- 提交用路径限定：`git commit -m "<说明>" -- <自己的文件>`；禁 `git add -A` / `add -u`。
- ⚠️ **路径限定提交带不上 untracked 新文件**（2026-10 撞过：新文件不在索引里，`-- <路径>` 不含它）。
  新文件先 `git add <文件>`，再不带路径 `git commit` 提交索引。
- 提交后 `git status --short` 复核：没带走别人的东西。
- 看到非自己改动的文件保持 modified，**不要替它做对照实验**（stash 出基线）；
  用同组文件 targeted 复跑（改前后各跑一次同一小组）定性。
- **同一个文件被两个会话改着**：优先等对方提交；必须 hunk 级提交时 `git add <文件>` 后提交索引
  （**不要** `git commit -- <路径>`，那会把工作树里对方的半改一起写入）。

## 去哪查（AI 专属落点）

**文档层的索引只有一份：[`docs/README.md`](docs/README.md)**——它按「什么时候读它」列了每份文档。
本文件不抄第二遍：两处索引必然分叉，而分叉之后没人知道哪份是对的。
这里只留**改代码时**才需要的落点：

| 何时 | 查 |
|---|---|
| 第一次进这个仓库 | `docs/README.md`（索引）→ `README.md`（手册）→ 本文件（纪律） |
| 加配置字段 | `cordis.patch.yml`（**全部字段带注释，是字段的注释真源**）+ `src/host/index.ts` 的 `apply` |
| 加 / 改 client 槽位 | 本文件「宿主 ABI 面」+ `test/client-id.test.mjs` |
| 协议漂移（daemon 换版本后行为变了） | `test/protocol.test.mjs`（故意说错的假 daemon 载荷）+ `protocol` 分支（面板显示 `daemonVersion` / `quotaTextDrift`） |
| 改测试前 | `test/` 各套件头注——**头注就是契约**，不是附件 |
| 想知道某版本改了什么 | `CHANGELOG.md`（行为史；版本↔提交回查看 `git tag`） |
| 分不清某件事是「忘了做」还是「决定不做」 | `docs/DECISIONS.md` |
| 复现 docs/ 里的实测 | `scripts/probes/`（每个脚本头注都写了成本） |
| 来源与许可 | `THIRD_PARTY_NOTICES.md` |
| 写 / 改文档的纪律 | `docs/README.md` 的「写文档的纪律」四条 |

## 已知缺口（别当成"没做"，也别当成 bug）

- **没有 `docs/PITFALLS.md` 与 `docs/ARCHITECTURE.md`**——本插件没有兄弟插件那套事故史账本；
  三条事实 + 红线 + `docs/DECISIONS.md` 就是全部的判断依据。别照抄一份空的出来占位。
  （事故卷宗只有一份，按主题拆在 `docs/AtomGit-网关与-review-通路.md` 里。）
- **发版手册在 `docs/RELEASING.md`**（状态判定表 + 不可逆点 + 动作顺序 + 本仓库特有坑，含 npm 内容核验与 GitHub Release 步骤）。核心纪律：版本号**两处手改**：
  `package.json` 的 `version`
  与 `src/host/index.ts` 里 stats body 的 `version`。两处必须一致，断言在 `test/wiring.test.mjs`
  （产物 `lib/index.js` 由构建生成，手改它等于没改）。
  **2026-10-16 补上这条断言**：此前这条纪律只写在文档里，而 `build-gate` 只比 `lib/` 与 `src/`、
  从不看 manifest——「只改一处」就是那样能悄悄漂开的。`cordis.patch.yml` 没有 version 字段。
  **第三处是禁止的**：注释/文档字符串里不许写 `vX.Y.Z` 标签（写事件名——
  `the apply() split` / `the abort path`，不写版本号）。旧纪律是「发版时 grep 一遍对齐」，
  它失效过一次：手册把数量写死成 8 处，真去数时已经是 13 处。现在由 `test/wiring.test.mjs` 的
  「no src/ or test/ file carries a vX.Y.Z release label in prose」断言（扫 `src/` + `test/` + `tsdown.config.mjs`），
  漏一处就红并报出行号；理由与迁移过程见 `docs/RELEASING.md` §3.1。
  **发版打 git tag**：`git tag v<package.json version>`（两处手改 + `npm run build` 产物落定后再打；
  推荐先等 push master 的 CI 绿了再打 tag，顺序见 `docs/RELEASING.md` §6.1）。
  「某版本是哪次提交」回看 `git tag`，行为史靠 `CHANGELOG.md` + `git log --date=short`。
  发布形态与兄弟插件同款：`package.json` 的 `prepack: npm run build` + `files` 白名单 + `publishConfig.access`；
  **npm 发布要钉 `registry.npmjs.org`**——本机 `~/.npmrc` 的 registry 是只读镜像
  （会拒绝 publish），靠 `publishConfig.registry` + 仓库根 `.npmrc` 双保险拉回；
  市场投稿见 `docs/submission/eghrhegpe__dsh-connect-atomcode.yml`——复制到 awesome-dsh-plugin 的
  `data/plugins/` 后开 PR，别加 `npm:` 字段、别在 yml 里放截图（市场读仓库根 `screenshots.json`）。
- **`upstream/atomcode-open-api`** 是参照件（第三方 AtomCode OpenAPI 实现，自带 `.git`），
  已被 `.gitignore` 的 `/upstream/` 排除、**故意不在仓库历史里**（见「工作目录与装载方式」那条）。
  它不是构建输入、不参与测试，只作接口形态的对照。
  **出处与许可在 `THIRD_PARTY_NOTICES.md`**，实测与风险在 `docs/AtomGit-网关与-review-通路.md`
  （v0.4.1 的回环探活也引用它）——两处都不是「许可」标题下的东西。
  本机 `git status` 里看不到它是**预期行为**，别去"修"，也别 `git add -f`。
