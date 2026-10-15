# AtomCode CLI 与 daemon 接口参考

> 实测记录，不是官方文档转抄。**版本：`atomcode 5.2.3 (d8918f0)`**，采集于 2026-10-14。
>
> 来源分三类，下文用标记区分：
> - `[help]` —— 二进制自己的 `--help` 输出（权威）
> - `[bundle]` —— daemon 内置 SPA 的 JS 包里出现的字符串（接口面的来源）
> - `[实测]` —— 本机跑出来的行为（可能有版本差异，但都是我亲手验证过的）

---

## 1. `atomcode` 顶层命令（18 个）`[help]`

```
login       通过 AtomGit OAuth 登录并领取 CodingPlan 模型
logout      退出登录
status      查看当前登录状态
resume      Resume a session by id or name（无参则最近一次；加 -p "<prompt>" 走无头）
upgrade     就地升级到最新发布版本
rollback    回退到上一个版本（与 .bak 交换）
review      Review a diff and report structured findings, then exit
mcp         管理 .mcp.json 中的 MCP 服务器配置
daemon      启动用于 IDE 集成的 HTTP 守护进程
webui       启动本地浏览器 webui
telemetry   遥测控制
plugin      管理技能/命令插件
uninstall   卸载（移除二进制、PATH 编辑和数据）
setup       安装种子文件（技能/命令/钩子/MCP）到 ~/.atomcode/
hooks       管理钩子（列表、测试、启用/禁用）
schedule    管理本地定时任务（add/list/remove/enable/disable）
completion  生成 shell 补全脚本到 stdout
help        打印帮助
```

### 顶层选项要点 `[help]`

| 选项 | 说明 |
|---|---|
| `-p, --prompt <PROMPT>` | 无头模式运行 |
| `-c, --continue` / `--resume <ID_OR_NAME>` | 续接会话（同 `resume` 子命令） |
| `--provider` / `--model` | 覆盖配置里的 provider / 模型 |
| `--config <CONFIG>` | 配置文件路径 |
| `-C, --dir <DIR>` | 工作目录 |
| `--output-format <text\|jsonl>` | 无头 stdout 格式，默认 `text` |
| `-v, --verbose` | stderr 上显示工具调用/token 用量/回合摘要 |
| `-y, --dangerously-skip-permissions` | 跳过所有权限提示 |
| `--ephemeral` | 不创建/续接/写会话状态（仅无头） |
| `--no-tools` | 不给模型任何工具（仅无头） |
| `--seed-config <PATH>` | **首次运行**种子配置（`ATOMCODE_SEED_CONFIG`） |
| `--tui` / `--classic` | 强制行式界面 / 经典界面 |
| `--audit` / `--demo` / `--probe-terminal` | 诊断用（配合 `--tui`，`--audit` 不需要终端与 provider） |
| `--dev` / `--no-telemetry` | 禁用本次自动更新 / 遥测 |

### 环境变量 `[help]`

| 变量 | 用途 |
|---|---|
| `ATOMCODE_MODEL` | 模型（被 `--model` 覆盖） |
| `ATOMCODE_API_KEY` | provider key（被 `--api-key` 覆盖） |
| `ATOMCODE_BASE_URL` | provider base URL（被 `--base-url` 覆盖） |
| `ATOMCODE_SEED_CONFIG` | 首次运行种子配置路径 |
| `ATOMCODE_HOME` | 数据目录（`config.toml` 注释里提到 datalog 会跟随它） |
| `ATOMCODE_BIN` | **本插件的约定**，不是 AtomCode 的 |

`atomcode status [--no-telemetry]` 是**唯一**参数；**没有** `--json`，输出也不含额度。`[实测]`

---

## 2. `atomcode review` 完整选项（28 个）`[help]`

> 这是本插件 `atomcode_review` 包装的对象。按用途分组。

### 变更选择（优先级见下）

| 选项 | 说明 |
|---|---|
| `--base <BASE>` | 对比基 ref，评审 `<base>...HEAD`；省略即评审未提交改动（`git diff HEAD`） |
| `--staged` | 只评审已暂存改动（`git diff --staged`） |
| `--pr <PR>` | GitHub PR 号（`gh pr diff <N>`，需 `gh` CLI） |
| `--diff-file <FILE>` | 从文件读 diff，`-` 表示 stdin（**任意 forge 通用**：GitLab/gitcode MR、CI 产物） |
| `--repo <REPO>` | 仓库根，默认 `.` |
| `--task <TASK>` | **自定义任务**替代 diff 评审（chat/explain/summary），**跳过 diff 计算** |
| `--task-file <FILE>` | 同上，从文件读（`-` = stdin） |

### Provider / 认证

| 选项 | 说明 |
|---|---|
| `--provider <NAME>` | 点名 `config.toml` 里的 `[providers.<name>]`（覆盖 `default_provider`） |
| `--model <MODEL>` | 模型 id（覆盖 `$ATOMCODE_MODEL`） |
| `--api-key <KEY>` | provider key（覆盖 `$ATOMCODE_API_KEY`） |
| `--base-url <URL>` | provider base URL（覆盖 `$ATOMCODE_BASE_URL`） |
| `--config <PATH>` | 配置文件路径，默认 `~/.atomcode/config.toml` |

### 提示词与规则

| 选项 | 说明 |
|---|---|
| `--system-prompt <TEXT>` | **完全替换**评审人格（替换后你得自己告诉模型有哪些工具和 `report_finding`） |
| `--system-prompt-file <FILE>` | 同上，从文件读 |
| `--append-system-prompt <TEXT>` | **追加**一段（推荐的定制通道：领域规则、忽略清单、仓库风格、PR 元信息） |
| `--append-system-prompt-file <FILE>` | 同上，从文件读 |
| `--rules-dir <DIR>` | 覆盖内置语言规则目录（`<dir>/<name>.md`，如 `go.md`/`sql.md`），缺失名回落内置 |
| `--no-rules` | 完全关掉内置语言规则注入 |
| `--skill-dir <DIR>` | 载入 skill 工具（可重复，LOW→HIGH；目录扫 `SKILL.md` 或 `<name>.md`）。省略 ⇒ 不挂 skill 工具 |

### 熔断（本插件默认都传）

| 选项 | 默认 | 说明 |
|---|---|---|
| `--stream-timeout <SECS>` | **180** | 单个流事件的最长等待；防 provider 卡死 |
| `--max-rounds <N>` | 无（UNLIMITED） | LLM 轮数硬上限。到顶后**停止并汇报已收集的 findings** |
| `--max-duration <SECS>` | 无（UNLIMITED） | 绝对墙钟上限。**唯一能在 provider 中途卡死时也生效的守卫**（keepalive 字节会骗过 `--stream-timeout`，`--max-rounds` 只在轮边界检查） |
| `--context-window <TOKENS>` | 配置值，否则 **128000** | 评审模型上下文窗口，影响压缩前的历史保留量 |

### 输出与工具

| 选项 | 说明 |
|---|---|
| `--json` | findings 以 JSON 输出（而非人类可读报告） |
| `--no-web` | 关闭 `web_search`（出网受限时用，否则 web_search 失败会**中止整次评审**） |
| `--graph-max-files <N>` | 仓库 git 跟踪的可索引源文件 **≤N** 时才挂代码图工具，否则降级 grep。`0` = 永不挂 |
| `--no-coverage` | 跳过 coverage 复审（首轮零 findings 变更文件的第二遍） |
| `--no-telemetry` | 关闭本次遥测 |

---

## 3. TUI 斜杠命令（21 个）`[bundle]`

daemon 内置 SPA 的本地化表里出现的命令 id：

```
build  cd  compact  config  cost  context  diff  forget  help  memory  model
plan  reload  remember  resume  review  skills  status  todo  undo  whoami
```

### 哪些能通过 daemon 的 `POST /command` 用 `[实测]`

| 命令 | 结果 |
|---|---|
| `status` | ✅ `{kind:"status", logged_in, username, provider, model, working_dir, config_path, text}`，**`text` 里含 CodingPlan 与用量** |
| `whoami` | ✅ `{kind:"whoami", logged_in, username, name, email}` |
| `config` | ✅ `{kind:"config", path, provider}` |
| `cost` | ⚠️ 需要 `session_id`（否则 `session_id required for cost`） |
| `context` | ⚠️ 需要 `session_id` |
| `usage` | ❌ `unknown command: usage` |
| `plan` | ❌ `unknown command: plan` |
| `model` | ❌ `unknown command: model` |
| `help` | ❌ `unknown command: help` |
| `review` | ❌ `unknown command: review`（2026-10 实测：TUI 斜杠表里有 `review`，但 HTTP `/command` 白名单不放它——**"把评审当一条命令来发"在 daemon 侧不存在**。⚠️ 但别说成"daemon 侧没有评审能力"：daemon 的 agent 自带 `code_review` **工具**（见 §4 末节，已实测执行），所以评审的两条路是 `atomcode review` CLI 与经 `/chat` 让 agent 用它，而不是 `/command`） |

> **注意**：需求里常提的 `/usage`（TUI 斜杠形式）在 HTTP `/command` 上**不被接受**；额度只在 `status` 里。

### `/command` 的三个坑 `[实测]`

1. **命令名不能带斜杠**：`"/status"` → `{"kind":"error","message":"unknown command: /status"}`；`"status"` 才对。
2. **`working_dir` 必填**：缺了直接 `{"kind":"error","message":"working_dir required"}`。
3. **失败也是 HTTP 200**：命令错误以 `{kind:"error",message}` 返回（另：body 字段名错会返回 **422** + `missing field \`command\``），**不能只看状态码**。

---

## 4. daemon HTTP 接口面 `[bundle]` + `[实测]`

### 启动与参数 `[help]`

```
atomcode daemon [OPTIONS]

--port <PORT>                  监听端口 [default: 13456]
--client <CLIENT>              遥测用客户端标识（如 "vscode"、"atomcode-air"）
--idle-timeout <SECS>          空闲自杀秒数；0 = 禁用。Env ATOMCODE_DAEMON_IDLE_TIMEOUT 覆盖。
                               Default 1800 (30 min)   ← 重要
--no-auth                      关闭 daemon API token 认证
--no-telemetry                 关闭本次遥测
```

> **⚠️ daemon 空闲 30 分钟会自行退出。** 所以"面板显示 daemon 未运行"通常不是坏了、也不是没启动过，而是它闲置自杀了。
> 本插件用 13459（避开 TUI 的 13456），并且**保留默认的空闲自杀**（不传 `--idle-timeout 0`）——理由是它不该常驻吃内存；靠"观察即拉起"（见根 README）按需回来即可。想让它常驻就在启动处加 `--idle-timeout 0`。

### ⚠️ 最大的陷阱：未知路径回吐 SPA

`/status`、`/usage`、`/quota`、`/plan`、`/me`、`/limits`…… **任何未知路径都返回 `200` + 同一份 HTML SPA**。`[实测]`
→ **别用状态码判断端点是否存在**，要看 `content-type` 是不是 `application/json`。

### 真实存在的端点

**元数据 / 状态**

| 端点 | 内容 |
|---|---|
| `GET /health` | `{status, version, service:"atomcode-daemon", binary_hash, instance_id, capabilities}` |
| `GET /models` | 模型目录（provider / model / is_default / effort_levels …） |
| `GET /providers` | provider 列表（含 `base_url` / `has_api_key` / `requires_login` / `account`） |
| `GET /config` | 配置路径与解析后的 provider / provider_accounts |
| `GET /provider-accounts` | 账号型 provider |
| `GET /providers/discover-models` | 探测某 provider 可用模型 |
| `POST /config/reload` | 重载配置 |
| `GET /auth/status` · `POST /auth/login/start` · `POST /auth/logout` | 认证 |
| `GET /mcp/status` · `GET /tunnel/status` · `GET /projects` · `GET /project` · `GET /sessions` · `GET /skills` | 其他状态 |

**对话**

| 端点 | 内容 |
|---|---|
| `POST /chat` | **SSE** 流；本插件 `atomcode_ask` 用它 |
| `GET /chat/active` · `POST /chat/stop` · `POST /chat/permission` · `POST /chat/user-input` | 运行中回合的控制 |
| `POST /command` | 跑 TUI 斜杠命令（见 §3） |

**IDE 实时通道**：`/live/message` `/live/stop` `/live/compact` `/live/provider` `/live/permission` `/live/user-input` `/live/switch_session` `/live/reasoning_effort` `/live/mcp/trust` `/live/policy-intervention`

**文件系统**：`/fs/list?path=` `/fs/open` `/fs/mkdir` `/fs/search?path=`

**认证头**：`Authorization: Bearer <token>`，token 在 `~/.atomcode/daemon-<port>.json` 的 `token` 字段（`--no-auth` 启动时该文件可能没有 token）。

### `/chat` 的 SSE 词表 `[实测]`

```
runtime_info      {provider, model}        ← 真实生效的 provider（本插件据此修正上报）
session_assigned  {session_id}
reasoning         {content}                 (增量)
text              {content}                 (增量)
tool_start        {name}
tool_result       {success}
tokens            {prompt, completion, total}
done              {tokens, tool_calls, session_id, stats:{duration_ms,rounds,tool_calls,prompt_tokens,completion_tokens,cached_tokens}, stop_reason}
error             {message}
rate_limited      {reset_at_display, reset_label, secs_until_reset, auto_resuming, server_message}   ← 只在被限流时出现
```

> `done.stats` **没有额度字段**（只有 token 明细）；额度只在 `POST /command {command:"status"}` 的 `text` 里。

### `POST /chat` 的请求体字段 `[实测 2026-10-14]`

```json
{ "message": "...", "approval_mode": "bypass",
  "provider": "<模型档位名>",        // 可省略；见下
  "session_id": "<续接>",            // 可省略
  "working_dir": "<必填性质>" }      // /command 也要求它
```

**`provider` 收的是"模型档位名"，不是厂商名，也不是模型 id。** 三个命名空间别混：

| 名字 | 出自 | 形状 | 本机实例 |
|---|---|---|---|
| **档位名** | daemon `GET /models` 的 `provider` 字段 = `config.toml` 里 `[models."<名>"]` 的键 = `default_provider` 的值 | `Account-modelish` | `AtomGit-qwen3.8-27b` / `AtomGit-glm5.3-flash` |
| 模型 id | 档位名对应的真实模型 | 裸名 | `qwen3.8-27b` / `glm5.3-flash` |
| 直连条目名 | `config.toml` 的 `[providers.<名>]`，**只有 review CLI 认这个** | 任意 | `atomcode-local` |

实测：`default_provider` 是 `AtomGit-qwen3.8-27b` 时，发 `{"provider":"AtomGit-glm5.3-flash"}` 后 SSE 第一帧就是

```
data: {"type":"runtime_info","provider":"AtomGit-glm5.3-flash","model":"glm5.3-flash"}
```

→ **换模型不需要改 `config.toml`，一个请求参数就够**；`runtime_info` 报的是**真实生效值**（不是回显请求），所以档位名打错会当场露馅。整个回合 2.2s / 20278 token（`cached_tokens` 17472）。

`GET /models` 还带 `effort_applicable` / `reasoning_effort` / `effort_levels`（本机：qwen3.8-27b = `low|medium|xhigh`，glm5.3-flash = `low|high`）。**思考档位有没有 `/chat` 的入口——未实测**；已知 IDE 实时通道有 `/live/reasoning_effort`，本插件没用。

### AtomCode 自带 `code_review` 工具 `[实测 2026-10-14]`（本插件未直接暴露）

会话事件里能看到 agent 的工具清单含 **`code_review`**，模型自己选用的参数形状：

```json
{ "scope": { "kind": "range", "base": "HEAD~2", "head": "HEAD" }, "depth": "deep+verify" }
```

**为什么这条对本仓库重要**：这个评审器跑在 **daemon 运行时**里，而 daemon 持有 AtomGit 网关签名（见 §5），所以它**不受 `atomcode_review` CLI 那道签名门限制**。红线 1 末尾"只能走 `atomcode_ask` 做侧边咨询或让 AtomCode 评审"此前只是推断，现在有执行证据：本仓库那两个提交就是让 AtomCode 经 `atomcode_ask` 用它审出来的（7 轮；末轮 `prompt 80322 / cached 73728`；Lite-体验版 5 小时窗口 2% → 13%）。

未实测的部分：`scope.kind` 的其他取值、`depth` 的档位表、以及它是否等价于 `atomcode review` CLI 的评审人格（两者实现不同——CLI 那份会写 `report_finding`，daemon 这份的产出直接进会话文本）。本插件不暴露它：`/chat` 的 SSE 只以 `tool_start{name}` 报出它在跑，没有独立端点可直连调用。

---

## 5. 网关侧：AtomGit 签名门 `[实测]`

`https://llm-api.atomgit.com/v1` 对**未签名**请求的响应：

```
GET  /v1/models           → 403 {"error":{"message":"model is not enabled for codingplan 'Lite-beta'","type":"auth_error"}}
POST /v1/chat/completions → 403 {"detail":{"code":"ATOMCODE_SIG_MISSING","message":"请升级到最新版 AtomCode 后再试。"}}
```

- **推理端点强制 AtomCode 专有签名**（`ATOMCODE_SIG_MISSING`）；`/v1/models` 在未签名时可读，但受套餐范围限制。
- provider 形状：`requires_login: true` + `has_api_key: false` + `account: "AtomGit"`（登录态渠道，无 API key）。
- 因此 `atomcode_review` 用不了该渠道。

### review CLI 的完整错误原文（权威，逐字）`[help]`

```
AtomCode error: provider base_url 'https://llm-api.atomgit.com/v1' is an AtomGit/gitcode
signing-enforced gateway, which atomcodex cannot authenticate against (it needs AtomCode's
proprietary request signing). Use a standard provider with an explicit api_key — e.g.
`--provider openrouter`, or set ATOMCODE_API_KEY/ATOMCODE_BASE_URL/ATOMCODE_MODEL to a plain
OpenAI-compatible endpoint.
```

**上面这句话就是「review 要配标准 provider + api_key」的出处**——是 AtomCode 自己说的，不是本插件的推断。

另一条（未设 `default_provider` 或 provider 无 `base_url` 时）：

```
AtomCode error: missing base URL: pass --base-url, set $ATOMCODE_BASE_URL, or add base_url to the config provider
```

### 验证程度（别把"官方这么说"当"验过了"）

| 论断 | 出处 | 验证程度 |
|---|---|---|
| 网关签名强制 / `atomcodex` 认不了 | AtomCode 错误原文 | ✅ 复现两次（5.2.2 / 5.2.3） |
| 需标准 provider + 显式 api_key | AtomCode 错误原文 | ✅ 换成非网关 base_url 后**越过了 provider 门**（打印 `Running custom task … with <自定义模型名>`；网关 base_url 是当场硬拒） |
| `--provider openrouter` 可用 | AtomCode 点名 | ⚠️ 未实测 |
| 任意 OpenAI 兼容端点（OpenAI / 本地 Ollama） | AtomCode 说 "plain OpenAI-compatible endpoint"；具体举例是本插件加的 | ✅ **本地代理端到端跑通**（`atomcode-open-api` @ `127.0.0.1:8899` → `api-ai.gitcode.com`；review exit 0，6.1s。2026-10-14） |

### 签名门对照实验（2026-10-14，零额度）`[实测]`

真 token × 两网关 × 5 签名形态（无头 / 假头 / `signing.py` 规格复刻的真签名 / 加 `X-AtomCode-Client`），
用**不存在的模型名 + 畸形 body** 卡在模型门/参数门前，不烧额度：

| 探针 | `llm-api.atomgit.com` | `api-ai.gitcode.com` |
|---|---|---|
| 全部 5 种形态 | 一律 403 `ATOMCODE_SIG_MISSING` | 一律 **200**（连裸请求都放行，不验签名） |
| `GET /v1/models`（真 token） | 403 `model is not enabled for codingplan 'Lite-beta'` | 200，**8 个模型** |

- **`signing.py` 的方案（HKDF-SHA256 salt=`atomcode-signing-v1` info=`v1:` + HMAC 消息 `{method}\n{path}\n{body}\n{ts}\n{nonce}`）在 `llm-api.atomgit.com` 上不被认**——逐字段复刻仍回 `_MISSING`，daemon 真实签名掺了未知材料（二进制里有 `X-AtomCode-Client` 头与 `atomcode-signing-v1` 字符串）。别照它复刻，也别逆向。
- `api-ai.gitcode.com`（`atomcode-open-api` 代理的默认网关）**不查签名**，同一 token 可用——这就是 review 的通路。
- 旧疑案"CLI 的 loopback 出站被策略代理拦"**已被推翻**：review CLI 打 `127.0.0.1:8899` 全程通畅（代理 `/health` 计到 `requests: 2`）。

---

## 6. 本插件实际用到的子集

| AtomCode 面 | 插件里的位置 |
|---|---|
| `GET /health` | `lib/daemon.js: health()` —— 存活探测与拉起轮询 |
| `GET /models` | `lib/daemon.js: listModels()`（live 测试用；插件本体未调用——**插件面板上没有模型选择器**，档位名靠 `default_provider` 配置或调用参数） |
| `POST /chat` (SSE) | `lib/daemon.js: streamChat()/askChat()` —— `atomcode_ask`（`provider` 字段由插件的 `default_provider` 配置或调用参数填入；**留空时连字段都不发**） |
| `POST /command` `{command:"status"}` | `lib/daemon.js: runCommand()` + `lib/quota.js` —— 额度显示 |
| `atomcode daemon --port … --no-telemetry` | `lib/daemon.js: spawnDaemon()` —— 自动拉起 |
| `atomcode review …` | `lib/review.js` —— `atomcode_review`（含 `--base/--staged/--pr/--diff-file/--task/--provider/--max-rounds/--max-duration/--json/--no-web/--no-telemetry`） |
| `~/.atomcode/config.toml` | `lib/review.js: checkReviewProvision()` —— review 可用性静态探针 |

**没用到的**（留作未来扩展）：`/chat/stop`（回合取消目前只断本端 HTTP 流）、`/live/*`、`/fs/*`、`/sessions`、`/skills`、`/providers/discover-models`、`atomcode --output-format jsonl`（无头一次性问答，可作为 ask 的另一条实现路径）。
