# dsh-connect-atomcode — 文档索引

把本机已登录的 **AtomCode**（官方二进制，终端 AI 编程助手）作为**侧边工具台**接入 DeepSeek Harness。

**这里是文档层的唯一索引。** 完整手册在仓库根目录的 [`../README.md`](../README.md)；
改代码前必读的纪律、红线与 ABI 面在 [`../AGENTS.md`](../AGENTS.md)。两处都**不再重复**本表。

---

## 一分钟了解

插件注册**两个工具**：

| 工具 | 干什么 | 底层 | 本机状态 |
|---|---|---|---|
| `atomcode_ask` | 侧边咨询：一条消息进，AtomCode 执行**一个完整自主回合**（它自带工具循环），整轮回复出来 | daemon `POST /chat`（SSE） | ✅ 开箱可用 |
| `atomcode_review` | one-shot 代码评审：未提交改动 / base 分支 / PR / diff 文本 / 自定义任务，返回 `--json` findings | CLI `atomcode review` | ⚠️ 需另配 provider，见下 |

**不需要 API Key**：ask 走本地 daemon token；网关签名内置于官方二进制。

## 快速开始

1. 装好官方 AtomCode 并登录（`atomcode status` 可查）
2. 插件挂上后**什么都不用做**：打开插件详情页或看着输入框，daemon 会**自己起来**（`auto_start: true`），额度也会显示出来
3. 对话里说「帮我问 AtomCode：……」→ 模型调 `atomcode_ask`；说「接着刚才那条线再问」→ `continue: true`

## 三个已知要点

1. **`atomcode_review` 在 AtomGit 登录态下默认用不了——但已有实测通路。**
   网关对推理端点强制 AtomCode 专有签名（未签名请求 → `ATOMCODE_SIG_MISSING`），而 review CLI（`atomcodex`）不会签。
   修法 = 加一个**标准 + 显式 `api_key`** 的直连 provider；本机实测通路是本地代理。
   **三条证据、零额度对照实验与已验证的修法**全部在
   [`AtomGit-网关与-review-通路.md`](./AtomGit-网关与-review-通路.md)，README 只留摘要。
   配套的 provider 自动选择与回环探活也在那篇里说清了。

2. **额度显示是从本地化文本解析出来的。**
   AtomCode 没有额度 HTTP 接口，唯一来源是 `POST /command {"command":"status"}` 返回的 `text`。
   解析不出来时**绝不编数字**，而是原样显示原文。机制与实测档案（数据链路、解析拒绝表、面板座位）在 [`CodingPlan-额度显示.md`](./CodingPlan-额度显示.md)。

3. **`npm test` 不消耗额度，`npm run test:live` 默认也不消耗。**
   离线链全部用假 daemon / 假 spawn / 纯函数。live 套件里的**真实模型回合**需要显式 `ATOMCODE_LIVE_TURNS=1` 才会跑。
   套件由 [`../scripts/test.mjs`](../scripts/test.mjs) 自动发现 `test/*.test.mjs` 且排除 `*-live.test.mjs`——**本文不抄计数也不抄名单，理由见下**。

## 文档索引

| 文件 | 什么时候读它 | 内容 |
|---|---|---|
| [`../README.md`](../README.md) | 第一次用 / 要装要配 | 手册：定位、安全姿态、配置表、怎么换模型、额度、测试、已知限制摘要 |
| [`../AGENTS.md`](../AGENTS.md) | **改代码之前**（人或 AI 都是） | 纪律：任务路由表、宿主 ABI 面、红线、并行会话纪律、去哪查、已知缺口 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 想知道「哪个版本改了什么」 | 按主题分组的变更史。版本↔提交回查看 `git tag` |
| [`RELEASING.md`](./RELEASING.md) | 要发一个新版本（断点续发先读它 §1 状态判定表） | **发版手册**：状态判定与不可逆点、版本号两处手改、验证三连、CI 绿后打 tag、npm 发布（钉 npmjs、防镜像劫持）、内容一致性核验、GitHub Release、市场投稿、闭环清单 |
| [`DECISIONS.md`](./DECISIONS.md) | 想改设计前 / 怀疑「这事是不是忘了做」 | 仍然有效的设计约束 + 明确不做的清单 |
| [`AtomGit-网关与-review-通路.md`](./AtomGit-网关与-review-通路.md) | review 不通 / 想弄明白签名门 | **事故卷宗**：三条证据 + 两个网关 × 5 种签名形态的对照实验 + 端到端实测的修法 + 残留风险 |
| [`AtomCode-CLI与daemon接口参考.md`](./AtomCode-CLI与daemon接口参考.md) | 要调 AtomCode 的命令 / 端点 | **实测速查**：CLI 命令与选项、daemon 全部 HTTP 端点、SSE 词表、`ATOMCODE_SIG_MISSING` 签名门、本插件实际用到的子集。**命令数与选项数一律以本篇实测为准**（本文不转抄） |
| [`AtomCode-CodingPlan网页版可用信息.md`](./AtomCode-CodingPlan网页版可用信息.md) | 要核对套餐规则 | 网页版（ai.atomgit.com）CodingPlan 页面素材：Lite / Pro 的支持模型与窗口规则 |
| [`AtomCode-CodingPlan网页版额度卡片.md`](./AtomCode-CodingPlan网页版额度卡片.md) | 要核对额度卡的字段与文案 | ⚠️ **原始 HTML 转储，不是给人读的文档**（单行、无换行）。供人工比对用；可执行的实测载荷在 `../test/quota.test.mjs` |
| [`CodingPlan-额度显示.md`](./CodingPlan-额度显示.md) | 额度不显示 / 位置不对 / 面板为什么长这样 | **机制档案**：daemon 拉起的四个约束与空闲自杀、`POST /command` 唯一来源与坑、两种解析拒绝行、槽位选择（`composer.dock`）与弹窗决策 |
| [`../cordis.patch.yml`](../cordis.patch.yml) | 要加配置字段 | bundle 声明与**全部配置项的注释**——字段的注释真源 |
| [`../scripts/probes/`](../scripts/probes/) | 要复现上面那些实测 | 探针脚本（**含成本标注**：哪个零额度、哪个花一个真实回合）。结论在 docs/，脚本是结论的出处 |
| [`../test/`](../test) | 改测试前 | 离线 + live 套件。**套件头注就是契约**，不是附件；离线链由 [`../scripts/test.mjs`](../scripts/test.mjs) 自动发现 |
| [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) | 要确认来源与许可 | 上游移植来源、本机参照的本地代理、运行时依赖的官方二进制，三者的许可与出处 |
| [`submission/`](./submission/) | 要向市场投稿 / 改过 description 后 | 市场投稿草稿 `eghrhegpe__dsh-connect-atomcode.yml`：头注逐个名词锚定了证据出处；投放步骤见 `RELEASING.md` §10 |

## 写文档的纪律

这四条来自实际踩过的坑，**改文档时同样适用**（机制层的细则在 [`../AGENTS.md`](../AGENTS.md)）：

1. **会变的计数不写进文档。** 套件数、test 数、AtomCode 的命令数/选项数，一律给「去哪量」而不是数字。
   套件数写死过一次，**13 分钟**后就被并行会话改过期了。
2. **索引只有一份，就是上面那张表。** 别在 AGENTS.md 或 README 里再抄一遍——两处索引必然分叉，
   而分叉之后没人知道哪份是对的。
3. **结论进 `docs/`，脚本进 `scripts/probes/`，两样都要入库。** 只把结论写进文档、脚本丢掉，
   等于把证据变成不可复现的叙述。
4. **契约注释住在 `src/`。** 产物 `client.js` 会被打包器抹掉函数体内的注释，
   所以「注释也是契约」指的是 `src/client/*.ts` 与 `src/host/*.ts`。

## 代码地图

⚠️ **`lib/*.js` 与 `client.js` 都是构建产物，不是源码。**真正的源在 `src/`，
改完必须 `npm run build` 再提交源码 + 产物（`test/build-gate.test.mjs` 逐字节守着这件事）。

```
# host —— 一个源码文件对应一个 lib/*.js（apply() 拆分 God module 后的完整清单）
src/host/index.ts           → lib/index.js           apply() 装配点：注册两个工具 + /stats + /provider 路由 +
                                                       额度缓存 + daemon 拉起策略；stats body 的 version 是版本号真源之一
src/host/config.ts          → lib/config.js          readConfig：30 个配置字段的类型兜底 + detectProfileKey（多 profile 隔离）
src/host/runtime.ts         → lib/runtime.js         挂载期状态容器：daemon / 额度 / 熔断 / 错误观察者，被 apply() 组装
src/host/routes.ts          → lib/routes.js          /stats 只读 + /provider 只写面板偏好（同源门禁 + 4KB body 上限）
src/host/tools.ts           → lib/tools.js           两个工具的挂载与描述（description 里写出本机可用性、优先级顺序）
src/host/daemon.ts          → lib/daemon.js          纯 daemon HTTP 客户端（/health /models /command /chat SSE），零宿主依赖
src/host/review.ts          → lib/review.js          `atomcode review` CLI 包装（argv 构造 + 有界熔断 + checkReviewProvision
                                                       静态探针 + selectReviewProvider 自动选择 + probeLocalEndpoint 回环探活）
src/host/quota.ts           → lib/quota.js           CodingPlan 额度文本解析（纯函数，按结构而非措辞；解析失败带 reason 不编数字）
src/host/sessions.ts        → lib/sessions.js        侧边会话映射（read-modify-write，跨 profile 键前缀隔离）
src/host/provider-store.ts  → lib/provider-store.js  面板选的模型档位/直连条目（provider.json：版本化、
                                                       损坏保留旁路、拒覆盖更新版本）
src/host/state-file.ts      → lib/state-file.js      state JSON 文件读写层，被 sessions / provider-store 共用
src/host/stats.ts           → lib/stats.js           buildStatsBody：把 daemon / binary / config / provider / protocol /
                                                       quota / sessions / ask / review 拼成一份 /stats 快照

# shared —— 被两半同时读的模块（"这个 base_url 是不是本机端点" / "这份快照的字段契约" 是同一个事实）
src/shared/loopback.ts      → lib/loopback.js        isLoopbackBaseUrl：host 决定要不要探活，client 写那句"代理一停 review 立刻断"
src/shared/stats.ts         (inlined both sides)     StatsSnapshot 及其分支的共享类型契约（只有类型，无运行时产物）

# client —— 渲染端半身，下面每个源文件都被 bundle 进同一个 client.js（IIFE）
src/client/index.ts          → client.js              entry：座位注册与控件装配（详情页两个 seat 的取舍 + dock 行）
src/client/status-section.ts → client.js              详情页那张卡的分区渲染（环境 / 模型 / 协议 / 额度 / 用量）
src/client/rows.ts           → client.js              每行的文字与 tooltip（turnBoundaryRows / providerRows / inFlightText）
src/client/quota.ts          → client.js              quotaView()：把额度分支折成可渲染的读数（含解析失败的原样回落）
src/client/quota-chip.ts     → client.js              输入框额度 chip 的弹窗（portal + Tooltip + 打开时的 1s tick）
src/client/styles.ts         → client.js              行内样式表（行高 / 网格 / 三级色）
src/client/types.ts          → client.js              客户端类型别名，re-export ../shared/stats.ts 的契约
```

> 每个 `src/host/*.ts` 和每个 `src/client/*.ts` 都在图上，且每条 `src/host/*.ts → lib/*.js` 都对应一个
> 实际存在的产物——由 [`../test/docs-code-map.test.mjs`](../test/docs-code-map.test.mjs) 守着。这份图是给读者的
> 第二眼，不是构建配置本身：产物命名的真源是 [`../tsdown.config.mjs`](../tsdown.config.mjs) 的 entry 表。
> 加一个 `src/client/*.ts` 而不更新这张图，测试会红——之前这里只断言了「`index.ts` 存在」和
> 「`src/client/*.ts → client.js` 的形状」，于是 `status-section.ts` / `quota-chip.ts` 落盘后这张图
> 悄悄漏了它们（地图掉了队，门却是开的）。

## 许可

MIT。第三方来源（上游移植、本机参照的代理、运行时依赖的二进制）与各自的许可见
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
