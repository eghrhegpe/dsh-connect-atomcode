# 变更记录

## 先说清这份文件的边界

- **本仓库不打 git tag。** 所以「0.4.1 那一版是哪次提交」只能靠这里的日期 + `git log --date=short` 回查。
  没有 tag 意味着没有一条命令能回到某个已发布版本——这是已知缺口，不是笔误。
- **版本号有两处，都是手改**：`package.json` 的 `version`，与 `src/host/index.ts` 里 stats body 的 `version`
  （产物 `lib/index.js` 由构建生成，不许手改）。两处必须一起改，`test/wiring.test.mjs` 有断言守着。
- **每条只记行为变化。** 实现细节、逐条修复表在 `git log` 里（30 条提交，信息写得比这里细）。
- ⚠️ **0.3 / 0.4 的边界在 git log 里是混的**：`c834070`（10-14）一个提交同时写着 v0.4/v0.4.1，
  `0.4.1` 这个号直到 `7434249`（10-15）才真正对齐进文件。所以下面按**主题**分组，
  不假装能精确切到某个版本号上——存疑的地方就写出来。

---

## 0.4.1 — 2026-10-15 → 10-16（面板可用性 · review 通路收尾）

### 新增

- **面板选模型档位**（两个下拉，各管一条命名空间）：`default_provider`（ask，daemon 档位名）与
  `review_default_provider`（review，`config.toml` 直连条目名）。面板选择写**插件自己的 `provider.json`**，
  **优先于**配置字段；`~/.atomcode/config.toml` 永远只读。
  优先级链：调用参数 > 面板选择 > 配置字段 > 原有默认。
- **review provider 自动选择**（`selectReviewProvider()`）：default 不可用时由**唯一**可用直连条目顶上；
  多个可用时**报错要求点名**，不替用户猜计费通道。
- **回环端点探活**（`probeLocalEndpoint()`）：base_url 是 loopback 时，spawn 前先打 `/health` → `<base>/models`；
  死代理得到具名诊断，而不是 CLI 那句 `Cancelled`。远程 base_url **刻意不探**。
- **review 本地端点即时警告**：下拉选中 `127.0.0.1` 类条目时当场写出「代理一停 review 立刻断」。

### 修复

- 额度卡缩进错一层，导致它不在网格里、跨满整行；改单主数字；工具统计改内联对齐；额度卡移到末位（读得最勤的放最后）。
- `authored` 判据改为「**值偏离出厂缺省**」，而不是「配置里有这个键」——旧服务端会把用户自己设的
  `approval_mode: ask` 说成「插件默认」。
- **无证据时不得声称「插件默认」**（同一类洞的第二次修：不是所有 host 都发得出 `config.defaults`）。
- 描述改用 `locale/` 目录（不是 `package.json` 里的对象）；`session key` 用 `resolve` 规范化 Windows 路径。
- 探针 deadline、TOML 行内注释解析、provider 回显标注。
- 四处可验证的洞一并收口。
- **「review 本地端点即时警告」此前一次都没真正出现过**：host 把 endpoint 表写在
  `provider.review.endpoints`，渲染侧却从 `provider.endpoints`（分支根）读，而根上从来没有这个键——
  于是那段「代理一停 review 立刻断」在生产里恒为空字符串。两半各自的测试都是绿的，因为
  `stats-route` 断言的是 host 那一半、`client-fns` 的 fixture 是自己手写的另一半形状，
  **没有任何一条断言把 host 的真实快照喂给渲染侧的读取函数**。现在读路径对齐到 slot，
  并新增 `test/snapshot-contract.test.mjs` 专门守这条接缝（先跑旧产物确认它红，才改成绿）。
- **`provider` 路由的 HEAD 以前会带 body**：stats 路由早就只回 header（注释还专门写了理由），
  provider 路由放行 HEAD 却照常 `writeJson`。现已对齐；两条路由的 HEAD 断言也从「只测状态码」
  加强为「必须无 payload」——只测状态码正是这条纪律能被漏掉一半的原因。
- **provider 优先级阶梯不再有两份**：execute 侧四档（含 `argument`），面板侧自己抄了一份三档的，
  改一边不会动另一边。现在面板侧复用同一个 `resolveProvider`（复用已读的 picks，不额外多读一次文件）；
  review 空档仍报 `auto`，与 ask 的 `atomcode` 是两个语义，不是同一个旋钮。
- **review 的 stdout 累积加了上限**：原来是 `stdout += chunk` 到子进程自己停为止，而墙钟熔断只停
  「等」不停「攒」——一个开始刷日志的 CLI 能把 host 内存吃光。现在边上限边排空（不排空会反向堵住
  子进程），且**超限即失败并出口具名**：`--json` 模式下 stdout 就是那份 findings 文档，被截断的文档
  「能解析」比不能解析更危险——它读起来像一份干净的评审。stderr 同理，只留前 8 KB（消费者本来就只取 2000 字符）。
- **`detectProfileKey` 从此有测试，且两处真 bug 修掉**：显式的 `DSH_PROFILE` 原来要过
  `web/desktop/headless` 三词白名单，白名单外的合法值被**丢掉**、答案落到"猜"上；argv 启发式原来是
  对 `process.argv.join(' ')` 跑 `/dsh.*\b(desktop|web)\b/i`，会跨参数边界匹配、也会被
  `/opt/dsh-tools/webpack.config.js` 这种路径骗到。现在环境变量即权威，argv 改为**逐 token 精确匹配**。
  判不出 profile 时**在 mount 时具名**（原来静默）：空前缀会让两个 profile 在共享的 `sessions.json`
  里撞同一个 `default::` 键，一侧的 `continue` 会续上另一侧的会话。
- **loopback 判据从两份手写副本改为一份真源**（`src/shared/loopback.ts`，两半各自 import；
  host 侧产物 `lib/loopback.js`）。两份一致所以一直没人发现，但"一致的两份"仍是两份——
  哪天其中一份先学会新的 loopback 写法，另一半就会与它不一致。

### 性能

- 模块级共享 stats 缓存：20 个会话从 4 req/s 降到 0.2 req/s。

### 文档 / 工程

- `README.md` 的三合一职责拆开：证据档案 → `docs/AtomGit-网关与-review-通路.md`，
  治理记录 → 本文件 + `docs/DECISIONS.md`。
- 探针脚本从仓库根归位到 `scripts/probes/`（含成本标注）——结论与脚本一起入库，证据链可复现。
- `scripts.test` 链里的套件数与 test 数**不写进任何文档**（写死过一次，13 分钟后就过期了）。

---

## 0.4.0 — 2026-10-14 → 10-15（额度可见性 · 协议漂移可观测）

### 新增

- **CodingPlan 额度可见性**：详情页面板 + 输入框下方 dock 行的紧凑读数（点击弹面板）。
  数据只能来自 `POST /command {"command":"status"}` 返回的**本地化文本**——AtomCode 没有额度 HTTP 接口，
  解析不出来时**原样显示原文**，绝不编数字。
- **协议漂移可观测**（`test/protocol.test.mjs` 是回归守卫）：
  `protocol.quotaTextDrift` 信号 + 面板显示 `daemonVersion`。v0.4 的答案是可观测降级，不是协议握手。
- **插件侧模型默认旋钮**：`default_provider`（ask）与 `review_default_provider`（review）进入配置字段。

### 修复

- 拒绝歧义额度行；`quotaTextDrift` 覆盖「认错」（认错也是漂移）。
- chip 弹窗的 `null%` 闪烁与 hooks 分支。
- 详情页去掉 6 行恒定值（用户原话「感觉插件又丑又多字呢」），两个下拉并排一行，
  并修掉 ask 下拉整个为空的「目录形状」bug。
- 面板座位挪到「描述与 rows 之间」；卡片随宽度合并；描述改双语 locale map；
  卡片 summary 不再重复描述。
- 不再抹掉中途 error 事件——完成的回合可以带非空 error 出去。
- 「评审第 2 条」的彻底修法：给 CLI argv 加**正向断言**（原来只有"没崩"的弱断言）。

### 变更

- **测试与文档的取值纪律**：`stats-route` 覆盖面板会解引用的每一个字段；
  额度载荷以「真实抓取」为准（`Captured verbatim ... 5.2.3`）。

---

## 0.3.0 及本仓库首日 — 2026-10-14

本仓库历史从 `76de75c`（client 半边 + 详情页实时统计）开始，同日的 `cad5968`「官方文档区」建立了 `docs/`。

### 删除（**有意为之的设计决策，不是退化**）

- **「模型提供商接管」链路**：上游原版把 `atomcode` 注册为 DSH 的 LlmAdapter，会话模型可整线切过去。
  v0.3 **删掉了它**——一个自带工具循环、绕过审批的完整 agent 塞进 DSH 的单 completion 插槽，
  会破坏 DSH 的工具循环、穿透它的权限模型，并把 O(N²) tokens 灌回每个会话轮次。
  **别把它加回来**，完整论证见 `AGENTS.md` 的「三条事实」第 1 条。

### 新增

- 详情页插件面板（client 半边）与实时统计路由。

### 修复

- 修掉 AtomCode 自评查出的三处：描述矛盾、空转断言、汇总句泛化。

---

## 0.2.0 及更早 — 移植自上游

**这一段不在本仓库的 git 历史里，所以这里不编日期与条目。**
host 侧「两个工具」的形态来自上游 [`Yinyuan34513/dsh-atomcode-bridge`](https://github.com/Yinyuan34513/dsh-atomcode-bridge)（MIT）的移植，
许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

原版移植过来后**已全部重写**的部分（`file:///` 绝对导入、`/home/elaina` 硬路径、
shell+curl+base64 管道、`.agent-presets` 目录式预设），逐条写在 `README.md` 的「许可」一节末尾。

想知道移植期的决策只有两个来源：`README.md` 的「定位说明」与 `AGENTS.md` 的「三条事实」。
