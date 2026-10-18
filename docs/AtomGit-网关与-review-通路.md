# AtomGit 网关与 review 通路 —— 实测档案（历史卷宗）

> **这篇现在是什么。** 它原先是 README 主体的一大节，后来是「review CLI 为什么不通 + 怎么绕」的档案。
> 从单通道改造（2026-10）起，**review CLI 这条代码路径已被整个删除**：`/atomcode-review` 走 daemon 的
> `runAsk`，是一次**带 diff 任务的 ask 回合**（模型侧的 `atomcode_review` 工具后来也退役了，只留命令）。
> 所以这一页从「怎么把 review 弄通」变成了**为什么当初弄不通、以及这个结论怎么促成了单通道决定**的证据卷宗。
> 想装插件、想用评审的人看 [`../README.md`](../README.md)；这一页只回答「为什么原来那样」。
>
> **证据可复现**：产出下面这些观测的脚本在 [`../scripts/probes/`](../scripts/probes/)，
> 含成本标注（成本表在 [`../scripts/probes/README.md`](../scripts/probes/README.md)，不在这里抄）。
> 第三方许可见 [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
>
> ⚠️ **下面所有 `ok: true / exit: 0 / findings` 的样本都是 CLI 时代的观测**，记录的是当时的二进制行为，
> 今天**无法复现**——那条路径已经不在代码里了。留在库里是因为：它们解释了为什么决定不去修 CLI，
> 而且二进制升级时这些数字仍能说明「当年那个签名门长什么样」。

---

## 结论

**一句话：不是「AtomGit 渠道不支持代码评审」，而是「review CLI 这条代码路径不会签 AtomGit 的请求签名」。**
同一个渠道，daemon（`atomcode_ask`）用得好好的，review CLI（`atomcodex`）用不了。

当时的答案有两条：一是加本地 OpenAI 兼容代理把额度转成标准端点（见下「✅ 当时的修法」），
二是**别修 CLI，把评审也做成一次 ask 回合**。**单通道改造选了第二条**，理由在下一节。

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

## ✅ 当时的修法：本地代理 + 直连 provider（2026-10-14 端到端实测）

[atomcode-open-api](https://github.com/baimocn/atomcode-open-api)（MIT，Python，本仓库 `upstream/` 有参考副本，**不参与构建**）把 CodingPlan 额度转成本地标准 OpenAI 端点：

```
review CLI → http://127.0.0.1:8899/v1（标准协议，api_key 任意串）
               ↓ 读 ~/.atomcode/auth.toml 的 token + 占位签名头
             api-ai.gitcode.com（不验签名）← CodingPlan 额度计费
```

三步配好（验证花费：1 次 completion + 1 个评审回合；`completion` 那半的探针仍在
[`../scripts/probes/real-completion.mjs`](../scripts/probes/real-completion.mjs)，
`review` 那半的探针（`real-review.mjs`）已随 CLI 一起删除——它探的东西不存在了）：

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
| 论断 | 验证程度 |
|---|---|
| 本地代理 → review 端到端跑通 | ✅ 本机实测（6.1s，exit 0，findings 结构化）——**仅 CLI 时代成立** |
| 代理 token 有效期 | ✅ `/health` 报 `1d 0h`（7 天制；过期在 AtomCode `/login` 重登，代理自动读新 token） |
| **该代理是否符合 CodingPlan 服务协议** | ⚠️ **未验证且与技术无关**：其 README 自述"仅供学习交流，遵守服务协议，与官方无关"。它做的事是把账号 token 转打到**不验签**的 `api-ai.gitcode.com`（本仓库对照实验证明该网关裸请求即 200）——即绕过 `llm-api.atomgit.com` 上的签名门。计费网关因此与 AtomGit 侧不同，请自行判断。许可与出处见 [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) |
| `llm-api.atomgit.com` 的真实签名方案 | ❌ 未逆向（C 探针已证明 `signing.py` 方案不对） |

（原表还有一行「**代理是活依赖**：进程死了 review 就断 —— 插件已加回环探活」。那套探活
（`probeLocalEndpoint` + 面板的回环警告）随 CLI 一起删了：现在的评审根本不经过代理，
走的是 daemon 已签名的通道，**没有任何本机进程是它的活依赖**。）

## 插件当年对此的处理（已全部删除，记录在此以免有人去翻旧代码）

这一段是**历史**：下面每一条都在单通道改造里被删掉了，删的理由在最后一节。
留着是为了让「为什么代码里没有这些函数了」有一个可查的答案。

- **静态探测**（`checkReviewProvision()`，不 spawn 子进程、不联网）：mount 时探测一次，把结论写进 `atomcode_review` 的工具描述，模型在调用前就知道这条路不通；后来改成每次调用都重读 `config.toml`（探测就是读一个小文件），不可用时直接拒绝调用。
- **provider 自动选择**（`selectReviewProvider()`）。旧文案"留空则用 default_provider"在 AtomGit 登录态是**陷阱**——default 是 account 型、无 base_url，CLI 必报 `missing base URL`。当时：default 可用则用 default；否则**唯一**可用直连条目自动顶上（记日志）；多个可用条目时**报错要求点名**，不替用户猜计费通道；显式 `provider` 参数永远优先。
- **回环端点探活**（`probeLocalEndpoint()`）。base_url 是 loopback（如本地代理）时，spawn 前先打 `/health` → `<base>/models`，任何 HTTP 响应即活；**全挂才拒绝**，并给出"启动 `atomcode-open-api`"这类具名诊断。远程 base_url 刻意不探——本机出网受策略代理管制，远程探测的假阴性会误杀 CLI 本可完成的调用。
- 插件详情页面板有一行「评审可用性」与不可用原因；面板上还有**第二个下拉**（review 的直连条目），选中本地端点时当场写出回环警告。
- 失败诊断按实测分类（网关签名门 / 缺 base_url / 回环代理未启动 / 其他），不再给出"传个 provider 就行"这种在本机无效的建议。

## 单通道改造：把上面这一整套删掉（2026-10）

**决定**：评审的两个入口都保留（`/atomcode-review` 命令与当时的 `atomcode_review` 工具；后者已于 2026-10-18 退役），但底下**只留 daemon 这一条通道**——
它们与 `atomcode_ask` 共用同一个 `runAsk`；`src/host/review.ts`（CLI 包装、argv 构造、静态探针、
自动选择、回环探活）整份删除，连同面板的第二个下拉与 `review_default_provider` /
`review_working_dir` / `review_no_web` 三个配置字段。

**理由（按分量排）**：

1. **一条通道能装错的地方只有一处。** CLI 那条路要正确，得同时满足「有直连 provider」「那个 provider
   的 base_url 活着」「签名门绕得过去」三件事，而每一件都只能靠本机配置的偶然状态满足——
   这正是上面整篇卷宗存在的原因。daemon 这条路签内置于二进制，开箱即用。
2. **两个下拉名不副实。** review 用上 daemon 之后，`--provider` 收的直连条目名与 `GET /models` 的
   档位名是两个命名空间，而面板却要同时解释这两套。合并后**只有一个「默认档位」**，
   一个 `provider` 参数，一处优先级阶梯（`调用参数 > 面板选择 > 配置字段 > AtomCode 自己的默认`）。
3. **代价说清楚**：CLI 的 `--json` 给了结构化的 `findings[]`（`severity` / `file` / `line`），
   而 ask 回合给的是**散文报告**。这个代价被显式接受了——理由是那份结构化输出在本机**从来没真正可用过**
   （上面那张 `findings: []` 的样本就是它最好的一次表现），而一个"字段永远为空"的结构化契约
   比没有这个字段更容易误导人。所以 `atomcode_review` 的输出是
   `{ok, report, truncated, tokens, usage, rounds, tools, ...}`，**没有 `findings`**。

**现在的行为**：`composeReviewMessage` 把「选哪段 diff」（`pr` / `diff_text` / `base` / `staged` /
不传 = 工作区）翻成一句给 AtomCode 的指令，AtomCode 自己在那个工作目录里跑 `git diff` 并读代码，
报告写回来。评审回合现在跟随 `ask_max_rounds`（与 `atomcode_ask` 同一套熔断）：曾经的
`review_max_rounds` / `review_max_duration_secs` 两个字段只被解析进快照、没有任何调用点读，
已随字段一起移除（docs/DECISIONS.md）。`working_dir` 缺省取会话 cwd，取不到就**拒绝**而不是
回落到宿主进程的 cwd——那条纪律没变。

daemon 侧（`atomcode_ask`）从头到尾不受此影响——它走 account 解析，默认模型直接可用。
