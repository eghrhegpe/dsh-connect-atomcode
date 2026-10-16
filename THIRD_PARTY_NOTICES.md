# 第三方来源与许可

本插件自身以 **MIT** 发布，全文见 [`LICENSE`](LICENSE)。以下是它包含、派生自、或在本机引用到的第三方内容。

**本文件只记许可与出处。** 技术细节、实测证据与风险判断在
[`docs/AtomGit-网关与-review-通路.md`](docs/AtomGit-网关与-review-通路.md)——那里才是讨论「这个方案该不该用」的地方。

---

## 1. Yinyuan34513/dsh-atomcode-bridge —— 移植来源（MIT）

<https://github.com/Yinyuan34513/dsh-atomcode-bridge>

本仓库是它的移植，这一点写在 `README.md` 的「许可」一节与 `package.json` 的 `repository` 里。
上游按 MIT 授权，允许此类衍生；本仓库的 `LICENSE` 保留 MIT 全文
（`Copyright (c) 2026 dsh-connect-atomcode contributors`）。

移植过程中**已全部重写**、原样不可用的部分：`file:///` 绝对导入、`/home/elaina` 硬路径、
shell+curl+base64 管道、`.agent-presets` 目录式预设。

## 2. baimocn/atomcode-open-api —— 本机参照件，**不在本仓库历史里**（MIT，Python）

<https://github.com/baimocn/atomcode-open-api>

**它是参照件，不是依赖。** 具体地：

- 被 `.gitignore` 的 `/upstream/` 排除，**不在本仓库的 git 历史里**（它是自带 `.git` 与 remote 的嵌套 clone，
  `git add` 会把它变成隐式 submodule）；
- 不在 `package.json` 的 `files[]` 里，不会被 npm 打包；
- **不是构建输入、不参与测试**。

它的作用是让 `atomcode_review` 变得可用：把 CodingPlan 额度转成本地标准 OpenAI 端点（`127.0.0.1:8899`），
从而让只认「标准 + 显式 `api_key`」的 review CLI 有路可走。**要不要用请读完那篇档案再决定**——
本文件不替它背书。

### ⚠️ 一条与技术无关的提示

该代理做的事是把账号 token 转打到**不验签名**的 `api-ai.gitcode.com`
（本仓库对照实验证明该网关裸请求即 200），即绕过 `llm-api.atomgit.com` 的签名门，
因此计费网关与 AtomGit 侧不同。其 README 自述「仅供学习交流，遵守服务协议，与官方无关」。
**该代理是否符合 CodingPlan 服务协议未经核实**，与技术无关，用不用自己掂量。

## 3. AtomCode（官方二进制）—— 外部运行时依赖，**不分发**

<https://atomgit.com/atomgit_atomcode/atomcode>

本插件**不包含、不打包、不分发**它：调用的是本机已登录的官方二进制
（PATH 上的 `atomcode`，或 `ATOMCODE_BIN` / patch 的 `binary` 覆盖）。
关系是**运行时集成**，不是代码衍生、不是再分发。

它自带的嵌套副本同理不入库。协议细节（端点、SSE 词表、`status` 文本、签名门）
以 [`docs/AtomCode-CLI与daemon接口参考.md`](docs/AtomCode-CLI与daemon接口参考.md) 的实测为准。
