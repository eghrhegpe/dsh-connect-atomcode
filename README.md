# dsh-atomcode-bridge

把本机已登录的 [AtomCode](https://atomgit.com/atomgit_atomcode/atomcode)（官方二进制，终端 AI 编程助手）作为**侧边工具台**接入 DeepSeek Harness：

| 工具 | 形态 | 底层 |
|---|---|---|
| `atomcode_ask` | 侧边对话：一条消息进，一个完整自主回合出（它自带工具循环） | daemon `POST /chat`（SSE，token 走 `~/.atomcode/daemon-13459.json`） |
| `atomcode_review` | one-shot 代码评审：未提交改动 / base 分支 / PR / diff 文本 / 自定义任务，返回 `--json` 结构化 findings | CLI `atomcode review`（有界：轮数 + 墙钟双保险丝，默认关 web） |

**无 API Key**：ask 走 daemon token，review 走 `~/.atomcode/config.toml` 的登录态；网关签名内置于官方二进制。

## 定位说明（v0.3 有意去接管）

上游原版（MIT，2026-08-15）还带一个「模型提供商接管」：把 `atomcode` 注册为 DSH 的 LlmAdapter，会话模型可整线切过去。v0.3 **删掉了这条链路**，原因（实测后的机制评估）：

- 接管插座是"一次补全"语义，插进去的是"一个完整自主 agent"：DSH 的工具定义不透传 → DSH 自己的工具环死；
- `approval_mode: bypass` 的自主回合穿透 DSH 的权限 preset，两边权限模型互不知晓；
- 无会话连续性时，DSH 第 N 轮 = 全文重喂 + AtomCode 侧 ~22k 系统上下文重喂，O(N²) 烧 token；
- 适配层报的 contextWindow/defaultMaxTokens 是猜数，DSH 的守卫/token meter 会在假数字上做决策。

它真正成立的形态就是**工具台**：`atomcode_ask` 当"侧边咨询"用（本版本已按 working_dir 建会话映射，`continue: true` 直接续线），`atomcode_review` 当"评审外挂"用。若日后 daemon 协议原生支持工具透传 + 会话续接 + 能力自描述，接管链路可再谈，且应以诚实的"委托代理提供方"语义做。

## 前置

- **官方** AtomCode 二进制（v5.x）在 PATH（Windows 实测位：`%LOCALAPPDATA%\AtomCode\atomcode.exe`；也可 `ATOMCODE_BIN` 或 patch 的 `binary` 覆盖）。源码构建无 AtomGit 网关签名，默认网关模型不可用
- 已登录：`~/.atomcode/auth.toml`（`atomcode status` 可查）
- 默认模型可用（`~/.atomcode/config.toml` 的 `default_model`，或给工具传 `provider`）
- ask 需要 daemon：`atomcode daemon --port 13459`（插件默认自动 detached 拉起；`auto_start: false` 则需自启）

## 安装

bundle 形式（与本机 `dsh-connect-*` 同品类）：

1. 开发目录：`~/.dsh/plugins/dsh-atomcode-bridge`（pnpm `link:` 依赖）
2. profile `package.json`：`dependencies` 加 `"dsh-atomcode-bridge": "link:..."`，`dsh.profile.bundles` 追加包名，`pnpm install`
3. bundle 自带的 `cordis.patch.yml`（`dsh.bundle.patch`）自动声明插入行与全部配置项，无需再写 profile patch

## 配置（patch 行 `config:`）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `13459` | ask 用的 daemon 端口（避开 TUI 的 13456） |
| `auto_start` | `true` | 探测不到 daemon 时 detached 拉起 |
| `binary` | `''` | 二进制名/路径（空 = PATH；`ATOMCODE_BIN` 亦可） |
| `approval_mode` | `bypass` | ask 回合内 AtomCode 侧工具审批；共享仓库慎用无人值守 |
| `working_dir` | `''` | 缺省工作目录（同时是侧边对话的会话键） |
| `state_path` | `''` | 会话映射文件（缺省 `~/.dsh/state/dsh-atomcode-bridge/sessions.json`） |
| `review_no_web` | `true` | 评审关 web_search（适配代理受限网络；有外网可设 false） |
| `review_max_rounds` | `35` | 评审 agent 轮数保险丝 |
| `review_max_duration_secs` | `900` | 评审墙钟保险丝 |

## 使用

- 侧边咨询：对话里说"帮我问 AtomCode：……"，模型调 `atomcode_ask`；"接着刚才那条线再问" → `continue: true`（自动恢复上次的 AtomCode session，不用记 id）
- 代码评审："让 AtomCode 评审一下当前改动 / 主分支到 HEAD 的差异 / 5 号 PR"，模型调 `atomcode_review`，findings 原文在 `report`（`--json` 文本）

### 评审的 provider 解析坑（本机实测）

`atomcode review`（CLI）只认 `config.toml` 里**直接的** `[providers.<name>]` 条目；而 `default_provider` 若是 account 型模型条目（如本机的 `AtomGit-qwen3.8-27b`，走 `[provider_accounts]` 解析），CLI 会报 `missing base URL`。两种解法：

- 给工具传 `provider` 参数，点名一个带 `base_url` 的直接条目（本机实测可用：`agnes-3.0-flash` / `commandcode`）
- 或设 `$ATOMCODE_BASE_URL` / 给该 provider 补 `base_url`

daemon 侧（`atomcode_ask`）不受此影响——它走 account 解析，默认模型直接可用。

## 测试

```bash
node test/daemon-parse.test.mjs   # 纯函数（SSE 解析/路径/平台判定）
node test/review.test.mjs          # review 参数构造/临时 diff/失败路径（fake spawn）
node test/wiring.test.mjs          # fake ctx 接线（双工具注册/schema/降级）
# 需 daemon + 真跑一次评审（消耗一次有界回合）：
node test/daemon-live.test.mjs
node test/review-live.test.mjs
```

## 许可

MIT。基于 `Yinyuan34513/dsh-atomcode-bridge`（MIT）移植；原版的 `file:///` 绝对导入、`/home/elaina` 硬路径、shell+curl+base64 管道与 `.agent-presets` 目录式预设均已在当前依赖上失效，本版全部重写。
