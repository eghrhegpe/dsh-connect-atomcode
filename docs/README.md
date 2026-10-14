# dsh-atomcode-bridge — 文档

把本机已登录的 **AtomCode**（官方二进制，终端 AI 编程助手）作为**侧边工具台**接入 DeepSeek Harness。

完整说明在仓库根目录的 [`../README.md`](../README.md)；这里是入门与文档索引。

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
   `llm-api.atomgit.com` 对推理端点强制 AtomCode 专有签名（未签名请求 → `ATOMCODE_SIG_MISSING`），而 review CLI（`atomcodex`）不会签。
   修法 = 加一个**标准 + 显式 `api_key`** 的直连 provider；本机实测通路是 `atomcode-open-api` 本地代理（`127.0.0.1:8899` → `api-ai.gitcode.com`，该网关不验签名），端到端 6.1s 跑通。插件配套了 provider 自动选择与回环端点探活。细节与签名门对照实验见 [README 已知限制](../README.md#-已知限制atomcode_review-与-atomgit-网关v041-已有实测通路)。

2. **额度显示是从本地化文本解析出来的。**
   AtomCode 没有额度 HTTP 接口，唯一来源是 `POST /command {"command":"status"}` 返回的 `text`。
   解析不出来时**绝不编数字**，而是原样显示原文。见 [README 额度显示](../README.md#-codingplan-额度显示)。

3. **`npm test` 不消耗额度，`npm run test:live` 默认也不消耗。**
   175 个离线 test 全部用假 daemon / 假 spawn / 纯函数。
   live 套件里的**真实模型回合**需要显式 `ATOMCODE_LIVE_TURNS=1` 才会跑。

## 文档索引

| 文件 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 完整说明：定位、配置表、额度、测试、已知限制 |
| [`../cordis.patch.yml`](../cordis.patch.yml) | bundle 声明与**全部配置项的注释** |
| [`AtomCode-CLI与daemon接口参考.md`](./AtomCode-CLI与daemon接口参考.md) | **实测速查**：`atomcode` 18 个顶层命令、`review` 28 个选项、21 个斜杠命令（及哪些能走 `/command`）、daemon 全部 HTTP 端点、SSE 词表、`ATOMCODE_SIG_MISSING` 签名门、本插件用到的子集 |
| [`AtomCode-CodingPlan网页版可用信息.md`](./AtomCode-CodingPlan网页版可用信息.md) | 网页版（ai.atomgit.com）CodingPlan 套餐页面素材：Lite / Pro 的 5 小时调用上限与支持模型 |
| [`AtomCode-CodingPlan网页版额度卡片.md`](./AtomCode-CodingPlan网页版额度卡片.md) | 网页版额度卡片的原始 HTML 抓取（含已领取套餐、5 小时用量、剩余天数） |
| [`../test/`](../test) | 8 个测试文件；`quota.test.mjs` 与 `stats-route.test.mjs` 里有大量实测载荷 |

## 代码地图

```
lib/index.js     Cordis 插件本体：注册两个工具 + /api/atomcode-bridge/stats 统计路由 + 额度缓存 + daemon 拉起策略
lib/daemon.js    纯 daemon HTTP 客户端（/health /models /command /chat SSE），零宿主依赖
lib/review.js    `atomcode review` CLI 包装（argv 构造 + 有界熔断 + 可用性静态探针）
lib/quota.js     CodingPlan 额度文本解析（纯函数，按结构而非措辞）
lib/sessions.js  侧边会话映射（read-modify-write，跨 profile 键前缀隔离）
client.js        渲染端半身：详情页统计卡片 + 输入框下方 dock 行的紧凑额度读数（点击弹面板）
```

## 许可

MIT。基于 `Yinyuan34513/dsh-atomcode-bridge`（MIT）移植。
