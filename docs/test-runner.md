# 测试运行器（test runner）机制

本文件是 `AGENTS.md` 「验证」节里测试运行器长叙事的展开版——把「为什么不写死套件数、
runner 怎么发现套件、并行安全怎么整治」从纪律文件挪到这儿，让 `AGENTS.md` 只钉红线。

## 不写死套件数 / test 数

上一次写死「175」之后 **13 分钟**，并行会话就往链里加了 `review-select`，数字当场过期。
要计数自己量：

```powershell
npm test 2>&1 | Select-String '^ℹ tests'
```

每个套件一行，印在它自己的 `── test/x.test.mjs` 头上——runner 现在是**一个套件一个进程**，
所以不再有一行聚合摘要。**只看自己域的增减**，别去对总数。

## 套件自动发现

套件由 `scripts/test.mjs` 自动发现 `test/*.test.mjs` 且排除 `*-live.test.mjs`，
`package.json` 里不再有硬编码的 `scripts.test` 链——**新套件只要落盘就跑，不会再漏挂**
（这是把「新套件写好了但没挂进链里」这类失误从代码层消掉，而不是靠纪律）。

## 一个套件一个进程带来的三件事

- CI 日志里每个套件是一个可折叠的 `::group::` 块。
- 失败能直接归到文件。
- 某个套件把进程搞死不会带走剩下的套件。

## 默认并行 + 端口哨兵整治

runner 默认**并行**（cap = 核数 − 1、封顶 6，`ATOMCODE_TEST_CONCURRENCY=<n>` 可调）；
代价是每个套件的输出先落临时文件、完成时**整块**打印——管道正是受限沙箱拒绝的东西，
`::group::` 分组保在「块」这一层。要逐行流式就 `ATOMCODE_TEST_SERIAL=1` 回到旧串行。

**端口哨兵的跨套件耦合坑（已连根拔掉）**：早年 `protocol` 与 `review` 两个套件挂在同一个
硬编码的「这里没有服务」哨兵端口上、`env-hermetic` 另用一个硬编码号，并行时一个套件的
假 daemon 可能回应另一个套件的请求（跨套件耦合，不是看负载的偶发红）。整治方式：所有
「这里没有服务」哨兵挪进 `test/dead-port.mjs`，一个 base 加每个用点一个唯一偏移，整段
停在 32768 **以下**（Linux 动态端口段是 32768–60999，旧哨兵恰好坐在里面——并行时会被
别人的 `listen(0)` 抢走）；偏移唯一性与「源码里禁写端口字面量」由 `test/dead-port.test.mjs` 钉着。

## 墙钟上限（挂死探测器）

每个套件有墙钟上限：默认 300 秒（`ATOMCODE_SUITE_TIMEOUT_MS` 覆盖），到点 SIGKILL 并在
per-suite 表里记成 `TIMEOUT`。卡死的套件（端口、promise、没人 end 的流）以前会把 CI 一直
挂到 GitHub 的 6 小时上限——没有失败套件名、没有日志尾巴。它是**挂死探测器**，不是性能门禁。

## 早年两条串行理由（都已是历史）

- `stats-route` 用 1600ms 等一个 1s 预算——2026-10-17 已改成 `waitFor` 轮询。
- 「build-gate 会原地重建 `lib/`」**不成立**——`test/build-gate.test.mjs` 把 `outDir`
  改到 `mkdtemp` 里构建，只**读**已提交的产物。
