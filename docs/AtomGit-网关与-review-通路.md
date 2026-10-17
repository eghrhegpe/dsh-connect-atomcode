# AtomGit 网关与 review 通路 —— 实测档案

> **为什么这篇单独存在。** 它原先是 README 主体的一大节。
> README 是「装 / 配 / 用」的手册，而这是**事故卷宗**：三条证据 + 一个对照实验 + 一条已验证的修法。
> 两类读者（想装插件的人 vs 想弄明白 review 为什么不通的人）被同一段长文挡在彼此前面，
> 所以拆出来。README 只留结论摘要与指针。
>
> **证据可复现**：产出下面这些观测的脚本在 [`../scripts/probes/`](../scripts/probes/)，
> 含成本标注（其中两个零额度、两个各花 1 个真实回合）。第三方许可见 [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

---

## 结论

**这是本插件最重要的一条事实，在装之前就该知道。**

> **不是「AtomGit 渠道不支持代码评审」，而是「review CLI 这条代码路径不会签 AtomGit 的请求签名」。**
> 同一个渠道，daemon（`atomcode_ask`）用得好好的，review CLI（`atomcodex`）用不了。
> **但已实测出一条通路**：本地 OpenAI 兼容代理把额度转成标准端点，review CLI 指过去即可用（见下「✅ 已验证的修法」）。

## 证据一：网关自己怎么说

用本机 OAuth token **不带签名**直连网关（2026-10-14 实测）：

```
GET  /v1/models           → 403 {"error":{"message":"model is not enabled for codingplan 'Lite-beta'","type":"auth_error"}}
POST /v1/chat/completions → 403 {"detail":{"code":"ATOMCODE_SIG_MISSING","message":"请升级到最新版 AtomCode 后再试。"}}
```

`ATOMCODE_SIG_MISSING` —— **推理端点强制要求 AtomCode 专有签名**。这是渠道的设计，不是故障；官方二进制实现了它，所以 daemon 能用。

## 证据二：daemon 眼里的 provider 形状

`GET /providers` 显示本机两个模型都是：

```json
{ "name": "AtomGit-qwen3.8-27b", "type": "openai",
  "base_url": "https://llm-api.atomgit.com/v1",
  "has_api_key": false, "requires_login": true, "account": "AtomGit", "managed": true }
```

**`requires_login: true` + `has_api_key: false`** —— 这是个**登录态渠道**，没有 API key。而 review CLI 只认「带 `base_url` + `api_key` 的直连 provider」，两边对不上。

## 证据三：review CLI 自己怎么说

`atomcode review`（CLI，内部叫 `atomcodex`）与 daemon 走**不同的 provider 解析**。daemon 能用 `[provider_accounts]` 解析出 AtomGit 网关并完成签名；**review CLI 不能**——即便你补上直接条目、`base_url` 指向网关，CLI 也会拒绝：

```
AtomCode error: provider base_url 'https://llm-api.atomgit.com/v1' is an
AtomGit/gitcode signing-enforced gateway, which atomcodex cannot authenticate against
(it needs AtomCode's proprietary request signing). Use a standard provider with an explicit api_key
```

**本机实测（2026-10-14，`atomcode 5.2.2` / `5.2.3` 两次都测）**——四种形态全部失败：

| 尝试 | 结果 |
|---|---|
| 不传 `provider`（走 `default_provider` = account 型） | `missing base URL` |
| `--provider <account 型条目名>` | `missing base URL` |
| `[providers.X]` + `--model`（base_url 指向网关） | 签名门拒绝（上面那段） |
| 标准 provider + `api_key`（非网关） | 越过签名门，端到端跑通（见下「已验证的修法」） |

## 签名门到底验什么（2026-10-14 对照实验，零额度）

探针脚本：[`../scripts/probes/signature-gate.mjs`](../scripts/probes/signature-gate.mjs)（**零额度**，用不存在的模型名 + 畸形 body 卡在模型门/参数门之前）。

拿真 token 对**两个网关**各打 5 种签名形态（不带头 / 假头 / 按 `upstream/atomcode-open-api` 的 `signing.py` 规格 HKDF-SHA256+HMAC 算的"真签名" / 再加 `X-AtomCode-Client` 头）：

| 探针 | `llm-api.atomgit.com`（daemon 在用） | `api-ai.gitcode.com`（代理默认网关） |
|---|---|---|
| A 不带任何 `X-AtomCode-*` 头 | 403 `ATOMCODE_SIG_MISSING` | **200** ✅ |
| B 假头（`fake_sign_headers` 占位值） | 403 `ATOMCODE_SIG_MISSING` | **200** ✅ |
| C 按 `signing.py` 规格复刻的真签名 | 403 `ATOMCODE_SIG_MISSING` | **200** ✅ |
| D/E 再加 `X-AtomCode-Client` | 403 | **200** ✅ |
| `GET /v1/models`（真 token） | 403 `model is not enabled for codingplan 'Lite-beta'` | **200，8 个模型** ✅ |

三个结论：

1. **`api-ai.gitcode.com` 根本不查签名**——裸请求都放行（比 `signing.py` 注释说的"只查头存在"还松）。代理的所有签名假设成立于这个网关。
2. **`llm-api.atomgit.com` 连"正确的签名"都不认**（C 是逐字段复刻 `signing.py` 方案算的，仍回 `_MISSING`）——daemon 实际用的签名方案与 `signing.py` 的假设**不是同一个**（二进制里能扫到 `X-AtomCode-Client` 头与 `atomcode-signing-v1` 标识，但消息构造掺了什么材料无从得知）。**第三方照 `signing.py` 复刻走不通，也别指望逆向。**
3. 两个网关是**两套世界**：`llm-api.atomgit.com` 叠加套餐模型白名单（`Lite-beta` 只放行 daemon `/models` 里那 2 个）；`api-ai.gitcode.com` 用同一个 token 直接列出 8 个模型（`deepseek-ai/DeepSeek-V4-Flash`、`zai-org/GLM-5.1`、`Qwen/Qwen3-32B` 等）。

## ✅ 已验证的修法：本地代理 + 直连 provider（2026-10-14 端到端实测）

[atomcode-open-api](https://github.com/baimocn/atomcode-open-api)（MIT，Python，本仓库 `upstream/` 有参考副本，**不参与构建**）把 CodingPlan 额度转成本地标准 OpenAI 端点：

```
review CLI → http://127.0.0.1:8899/v1（标准协议，api_key 任意串）
               ↓ 读 ~/.atomcode/auth.toml 的 token + 占位签名头
             api-ai.gitcode.com（不验签名）← CodingPlan 额度计费
```

三步配好（验证花费：1 次 completion + 1 个评审回合；两条通路的探针分别是
[`../scripts/probes/real-completion.mjs`](../scripts/probes/real-completion.mjs) 与
[`../scripts/probes/real-review.mjs`](../scripts/probes/real-review.mjs)，头注写了成本与跑法）：

```powershell
pip install atomcode-open-api      # 或 git clone 后 pip install -e .
atomcode-open-api                  # 默认 127.0.0.1:8899 → api-ai.gitcode.com
```

```toml
# ~/.atomcode/config.toml 追加（原件备份在 config.toml.bak-before-openapi）
[providers.atomcode-local]
provider = "openai"
base_url = "http://127.0.0.1:8899/v1"
api_key = "local-proxy-any-string"   # 任意字符串，代理不校验
model = "deepseek-ai/DeepSeek-V4-Flash"
```

然后 `atomcode_review` 传 `provider: "atomcode-local"`（或留空让插件自动选），实测结果：

```
ok: true  exit: 0  6.1s
report: { "findings": [], "text": "The `version` field in package.json is `0.4.0`.",
          "usage": { "prompt": 14518, "completion": 101, "cached": 6144 } }
```

**这同时解开了上一版的未解之谜**：旧文案说"本地假服务端一个请求都没收到，疑是策略代理拦了 CLI 的 loopback 出站，但无证据"。现在有证据了——**loopback 没被拦**，CLI 打 `127.0.0.1:8899` 全程通畅（代理 `/health` 计数 `requests: 2`）。旧实验失败的具体原因仍是未知数（当年那个假服务端的实现差异未复盘），但"网络管制拦回环"这个假设**已被推翻**。

**诚实标注的残留风险**（⚠️ 那一行是本表里唯一与技术无关、与账号条款有关的一条，用不用自己掂量）：

| 论断 | 验证程度 |
|---|---|
| 本地代理 → review 端到端跑通 | ✅ 本机实测（6.1s，exit 0，findings 结构化） |
| 代理 token 有效期 | ✅ `/health` 报 `1d 0h`（7 天制；过期在 AtomCode `/login` 重登，代理自动读新 token） |
| **代理是活依赖**：进程死了 review 就断 | ✅ 显然成立——插件已加回环探活（见下），死代理得到具名诊断而不是 CLI 的 `Cancelled` |
| **该代理是否符合 CodingPlan 服务协议** | ⚠️ **未验证且与技术无关**：其 README 自述"仅供学习交流，遵守服务协议，与官方无关"。它做的事是把账号 token 转打到**不验签**的 `api-ai.gitcode.com`（本仓库对照实验证明该网关裸请求即 200）——即绕过 `llm-api.atomgit.com` 上的签名门。计费网关因此与 AtomGit 侧不同，请自行判断。许可与出处见 [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) |
| `llm-api.atomgit.com` 的真实签名方案 | ❌ 未逆向（C 探针已证明 `signing.py` 方案不对） |

面板上的 review 下拉选中指向 `127.0.0.1` 这类**本地端点**的条目时，会当场写出「本地端点 …：评审经本机进程转发计费，它一停 review 立刻断」——这条警告在点击时出现，而不是等评审失败。

**不想配代理就直接用 ask**：`atomcode_ask` 走 daemon，签名内置于二进制，本机开箱可用。让它评审也可以——把 diff 或问题作为 message 发过去（代价是散文 findings，不是 `--json` 结构化输出）。

## 插件对此的处理（v0.3 起，v0.4 强化，v0.4.1 补通路）

- **静态探测**（`checkReviewProvision()`，不 spawn 子进程、不联网）：mount 时探测一次，把结论写进 `atomcode_review` 的工具描述，模型在调用前就知道这条路不通。
- **v0.4：每次调用都重读 `config.toml`**。探测就是读一个小文件，成本可忽略；mount 之后再加 provider 会被立刻认到，不用重启插件。
- **v0.4：探测不可用时直接拒绝调用**（返回结构化错误，不 spawn）。原来只是描述里加一句警示，模型仍可能调，然后拿到一串面向人的 CLI 诊断。
- **v0.4.1：provider 自动选择**（`selectReviewProvider()`）。旧文案"留空则用 default_provider"在 AtomGit 登录态是**陷阱**——default 是 account 型、无 base_url，CLI 必报 `missing base URL`。现在：default 可用则用 default；否则**唯一**可用直连条目自动顶上（记日志）；多个可用条目时**报错要求点名**，不替用户猜计费通道；显式 `provider` 参数永远优先。
- **v0.4.1：回环端点探活**（`probeLocalEndpoint()`）。base_url 是 loopback（如本地代理）时，spawn 前先打 `/health` → `<base>/models`，任何 HTTP 响应即活；**全挂才拒绝**，并给出"启动 `atomcode-open-api`"这类具名诊断。远程 base_url 刻意不探——本机出网受策略代理管制，远程探测的假阴性会误杀 CLI 本可完成的调用。
- 插件详情页面板直接展示「评审可用性」与不可用原因。
- 失败诊断按实测分类（网关签名门 / 缺 base_url / 回环代理未启动 / 其他），不再给出"传个 provider 就行"这种在本机无效的建议。

daemon 侧（`atomcode_ask`）不受此影响——它走 account 解析，默认模型直接可用。
