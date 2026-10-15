# scripts/probes — 实测探针

**这三个脚本是证据，不是工具。** 它们产出 `docs/AtomGit-网关与-review-通路.md` 里那批对照实验的原始观测，
放在这里是为了**可复现**：那篇档案写下的是结论，脚本是结论的出处。

它们此前散落在仓库根（`.probe-*.mjs`）且被 `.gitignore` 排除——于是「结论入库、脚本不入库」，
任何人（包括三个月后的作者）想重跑实验都只能重写一遍。2026-10-16 归位到这里并入库。

## 成本（跑之前先看这一列）

| 脚本 | 原名 | 成本 | 需要什么 |
|---|---|---|---|
| `signature-gate.mjs` | `.probe-signing.mjs` | ✅ **零额度** | 已登录的 `~/.atomcode/auth.toml` |
| `real-completion.mjs` | `.probe-real-call.mjs` | ⚠️ **1 个 completion 回合** | 同上 |
| `real-review.mjs` | `.probe-review.mjs` | ⚠️ **1 个评审回合** | 同上 + 可用的直连 provider（本地代理） |

`signature-gate.mjs` 之所以零额度：它用**不存在的模型名 + 畸形 body**，请求必然卡在模型门或参数门，
到不了真正的补全。这是刻意设计的——探签名门不该花钱。

`real-review.mjs` 要从**仓库根**跑（`node scripts/probes/real-review.mjs`）：
它把 `process.cwd()` 当作评审的 `working_dir`。

## 它们验证了什么

- `signature-gate.mjs` → `llm-api.atomgit.com` 连**正确的签名**都不认（第三个结论最重要：
  第三方照 `signing.py` 复刻走不通），而 `api-ai.gitcode.com` **裸请求即 200**。
- `real-completion.mjs` → 同一 token 在 `api-ai.gitcode.com` 上端到端跑通（代理方案的前提）。
- `real-review.mjs` → 本地代理 + 直连 provider 让 `atomcode_review` 真的能用（6.1s / exit 0 / `--json` findings）。

细节、对照表与残留风险见 [`../../docs/AtomGit-网关与-review-通路.md`](../../docs/AtomGit-网关与-review-通路.md)。

## 纪律

**新增探针不得留在仓库根。** 根目录的 `.probe-*.mjs` 仍被 `.gitignore` 挡着（防误提交），
正确位置是这里，并且要：① 头注写清成本；② 结论写进 `docs/`；③ 需要的凭据运行时读，不写进文件。
