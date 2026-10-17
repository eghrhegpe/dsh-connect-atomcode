# scripts/probes — 实测探针

**这些脚本是证据，不是工具。** 它们产出 `docs/AtomGit-网关与-review-通路.md` 与 `docs/AtomCode-CLI与daemon接口参考.md` 里那批对照实验的原始观测，
放在这里是为了**可复现**：那篇档案写下的是结论，脚本是结论的出处。

它们此前散落在仓库根（`.probe-*.mjs`）且被 `.gitignore` 排除——于是「结论入库、脚本不入库」，
任何人（包括三个月后的作者）想重跑实验都只能重写一遍。2026-10-16 归位到这里并入库。

## 成本（跑之前先看这一列）

| 脚本 | 原名 | 成本 | 需要什么 |
|---|---|---|---|
| `signature-gate.mjs` | `.probe-signing.mjs` | ✅ **零额度** | 已登录的 `~/.atomcode/auth.toml` |
| `real-completion.mjs` | `.probe-real-call.mjs` | ⚠️ **1 个 completion 回合** | 同上 |
| `chat-stop.mjs` | （直接入库） | ✅ **零额度**（只探 422/未知 id，不停真回合） | 运行中的 daemon（token 运行时读） |
| `approval-mode.mjs` | （直接入库） | ⚠️ **1 个 flash 档位回合/模式**（422 枚举门零额度） | 运行中的 daemon + 登录态 |
| `probe-gate-diff.mjs` | （直接入库） | ✅ **零额度**（重建到临时目录，不碰磁盘上的 `lib/`） | 本机 `tsdown`（devDependency）+ 已构建的工作树 |
| `cli-inventory.mjs` | （直接入库） | ✅ **零额度**（只跑两条 `--help`，不启动 daemon） | 本机 `atomcode` 二进制（`--binary` 或 `$ATOMCODE_BIN` 可覆盖路径） |

这张表是**门禁**不是装饰：[`../../test/probes-index.test.mjs`](../../test/probes-index.test.mjs) 拿目录里的实际文件与表的第一列对账——
新增探针没有表行、脚本头注没写成本、或者表里点了一个已经不存在的脚本，`npm test` 当场红。
（「原名」那一列不参与对账：那是归位之前仓库根里被 `.gitignore` 挡住的旧临时名，本来就不是文件。）

`signature-gate.mjs` 之所以零额度：它用**不存在的模型名 + 畸形 body**，请求必然卡在模型门或参数门，
到不了真正的补全。这是刻意设计的——探签名门不该花钱。

## 它们验证了什么

- `signature-gate.mjs` → `llm-api.atomgit.com` 连**正确的签名**都不认（第三个结论最重要：
  第三方照 `signing.py` 复刻走不通），而 `api-ai.gitcode.com` **裸请求即 200**。
- `real-completion.mjs` → 同一 token 在 `api-ai.gitcode.com` 上端到端跑通（代理方案的前提）。
- `chat-stop.mjs` → `/chat/stop` 的契约（`session_id` 必填；未知 id 回 200 "was not running"，200 ≠ 回合被停），
  结论落在 `docs/AtomCode-CLI与daemon接口参考.md` §4 与 `docs/DECISIONS.md`。
- `approval-mode.mjs` → **非 bypass 无人值守回合不会卡在审批上**：422 门枚举出合法值
  `build / accept_edits / bypass / plan`（单测里的 `on-request` 不合法）；`build` 与 `accept_edits`
  下强制命令类工具全程零 `permission_request`，命令被自动放行。README「共享仓库改非 bypass」
  的建议据此撤回，口径裁定记录在 `docs/DECISIONS.md`。
- `probe-gate-diff.mjs` → **`build-gate` 的 `lib/ is not STALE` 红灯在并行编辑期间怎么归因**：
  它按 `test/build-gate.test.mjs` 的同一条路径把 host 配置重建到临时目录，打印第一段差异——
  「你忘了 `npm run build`」与「别人的半改比本机上次构建还新」是两件事，这条命令一次分开
  （2026-10-17 实测是后者：对方在构建后 19 秒又改了 `src/host/tools.ts`，差异直指那一处）。
  操作纪律写在 `AGENTS.md` 的并行会话一节。
- `cli-inventory.mjs` → **`docs/AtomCode-CLI与daemon接口参考.md` 里那三份「N 个」清单从「手抄过一遍」变成
  「可以再数一遍」**。它分别对照「标题里的数字 vs 列表条目数」与「列表 vs 本机 `--help` 的真实名字」
  （只比名字，不比描述——描述是人写的转述）；§3 取自 SPA bundle、CLI 拿不到，所以只做自洽核对并
  显式标注「未被复核」，免得把「没查」当成「对」。2026-10-17 首跑：同版本（`5.2.3 / d8918f0`）下
  §1 18/18、§2 28/28 逐条一致（这也顺带证明那三份清单在 5.2.3 上仍然成立）。
  故障注入：往 §2 插一行假选项 → 同时报出「29 个（标题写 28）」与 `--not-a-real-flag`，退出码 1。

细节、对照表与残留风险见 [`../../docs/AtomGit-网关与-review-通路.md`](../../docs/AtomGit-网关与-review-通路.md)。

## 纪律

**新增探针不得留在仓库根。** 根目录的 `.probe-*.mjs` 仍被 `.gitignore` 挡着（防误提交），
正确位置是这里，并且要：① 头注写清成本；② 结论写进 `docs/`；③ 需要的凭据运行时读，不写进文件。
