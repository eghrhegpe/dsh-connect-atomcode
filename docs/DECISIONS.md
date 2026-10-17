# 设计决策与「不做」清单

本文件收纳两类东西，都是**改代码前该先读、改完后别忘更新**的：

- **仍然有效的决策** —— 当前设计受哪些已定型的约束；
- **未修 / 明确不做** —— 已经想过、权衡过、决定不做的事。**别把它当成"没做"，也别自己"顺手做了"。**

每个版本改了什么见 [`../CHANGELOG.md`](../CHANGELOG.md)；这份文件只讲**现在为什么是这样**。
（原先这两节挂在 `README.md` 的「v0.4 治理记录」标题下——那是把"当前约束"混进"版本历史"，
2026-10-16 拆开：历史进 CHANGELOG，约束留在这里。）

---

## 仍然有效的决策

- **ask_max_rounds 默认 25（不再是 0）**。它是**停止等待**的止损，不是远端 kill：断的是客户端这条 HTTP 流，daemon 侧回合可能继续在后台跑完。对无人值守的 agent 而言，这个数字约束的是**用户等多久**、不是 agent 干多少（25 轮 shell/写文件/出网足以造成实质损害）——请连同 `README.md` 的安全姿态一节一起读
- **review 每次调用重读 config.toml**，不可用时直接拒绝
- **review 缺省不猜仓库**：两者都没给时拒绝并说明原因
- **reply/report 截断时打标记 + 置 `truncated` 字段**
- **两个工具描述各说各的命名空间**，写明"传裸模型 id 是错的"
- **sessions.count() 按 prefix 统计**
- **daemon_retry_secs（默认 60s）冷却后重试**
- **额度正则标签收紧为 `用量|usage|quota`**
- **面板布局**：`1180px` + `repeat(auto-fit, minmax(320px, 1fr))`
- **i18n**：`locale/{en,zh}.json` + `files[]` 含 `locale`
- **工具统计格式**：两组带标签，不摊平成一排
- **配置字段的语义只写在 `cordis.patch.yml` 一处**（字段文档真源，`test/wiring.test.mjs` 钉着它）。`src/host/config.ts` **不复述**字段含义/空值语义/归属哪条路径，只写解析层才知道的事：`0` 为什么是显式值而不是缺失值、`authored` 为什么不能是 key-presence 判定、内置常量为什么是这个数。理由：同一份「为什么」写两处，第二处必然漂移——2026-10-17 实测，24 个字段的注释在两处逐字段重复，而只有 patch.yml 那份有测试看着
- **profile 键的自动判定（`session_key_prefix` 为空时）**：`$DSH_PROFILE` 是权威、**过不过 allowlist**——曾因一个三词白名单把合法值丢掉、回落到猜测；argv 回退要求 `dsh` 是真调用**且** profile 词独占一个参数——曾因对拼接 argv 跑正则而跨参数边界命中（`/opt/dsh-tools/webpack.config.js` 满足过 `web` 分支）。判定不出来就返回 `''`，由挂载点具名告警（红线 3），**绝不猜**：错误的前缀会静默合并或拆错会话，比没有前缀更糟
- **`atomcode_review` 是「经标准 OpenAI 兼容端点的有界一次性评审」，不承诺 Atom 原生通路**。Atom 官方网关（`llm-api.atomgit.com`）对推理端点强制 AtomCode 专有签名，review CLI（`atomcodex`）不会签 → 结构性够不着官方网关，只能走标准直连端点或本地 sidecar 后门。两条「稳定」轴要分开看：**网关/额度轴**上，Atom 原生登录用户的稳定评审通路是 `atomcode_ask` 里的原生 `code_review`（签名 daemon、滚动窗口额度）；**有界性轴**（轮数 + 墙钟双保险丝、`--json` findings、可复现）CLI 更强。工具描述已按此定位改写（2026-10-16）

- **ask 回合被熔断 / 取消 / 流截断时，向 daemon 发 `POST /chat/stop`**（2026-10-17，未随版本号发布）。此前 abort 只断本端 HTTP 流，daemon 侧回合继续跑、继续烧工具调用与滚动窗口额度——这一条此前被三处注释当成既定事实描述（`streamChat` / `askChat` / `max_rounds` 参数说明），而端点一直躺在接口参考的「没用到的」清单里。契约是实测出来的（`scripts/probes/chat-stop.mjs`，无成本）：`session_id` **必填**（空 body → 422，没有"停掉正在跑的那个"这种用法）；未知 id → 200 `{"success":true,"message":"... was not running"}`——**200 不代表回合被停掉**，所以 `stopChat` 的 `ok` 语义是"daemon 受理了请求"，message 原样带回，不转述成"已停止"。回合刚开始就被切断、还没拿到 `session_assigned` 的回合没有 id 可发：这一种情况在错误文本里具名（`appendStopOutcome` 的 `sent:false` 分支），不用任何猜测兜底；`continue` 传入的 `sessionId` 作为第二来源。`done` 之后绝不发（回合已结束），daemon 自己在流内发的 `error` 事件也不发（不是我们取消的）

> 机制层的硬约束（为什么不做 provider 接管、额度为什么只能靠文本解析、三条私有无版本协议怎么办）
> 写在 `../AGENTS.md` 的「三条事实」——那里是给改代码的人的入口，本文件不重复。

## 未修 / 明确不做

- **`approval_mode: bypass` 的默认值本身没改**。它不是插件能单方面收回的东西：关掉后 ask 回合会在 AtomCode 侧卡在交互式审批上（daemon 无人值守），工具直接不可用。**缓解措施是把轮数变成有界的**，并把 `approval_mode` 留在配置里显眼处。共享仓库请自行改成非 bypass。
- **协议仍无版本钉扎**。真正的解法需要官方提供 `/protocol` 或稳定的事件契约；本版只能做到"坏了说清楚"。
- **`GET` 触发 spawn** 保留。只读轮询拉起后台进程是一个设计张力点，但"打开面板即有数据"是有意的权衡（README 已如实描述）。
- **会话键是 per-working_dir 而非 per-对话**。DSH 不暴露稳定的对话 id，这是合理妥协；现在**在工具描述里写明**了，免得模型误以为 `continue` 续的是自己这条对话。
- **`diff_text` 的临时文件**仍在系统 tempdir，被 SIGKILL 时会残留。单用户开发机风险低。
- **默认注册尚未按 provision 门控（未决，暂不做）**。候选方案：仅当存在**健康**的标准直连 provider 时才注册 `atomcode_review`（AtomGit-only 机器上工具直接消失，只留 ask）。暂不做的理由：① 机器级不可用已由「挂载期降级描述 + 执行期拒绝 + 面板 reviewReason」三处"调用前告知"兜住（红线 1 哲学：留着被降级的工具比凭空消失更有信息量）；② 「健康」判定需要活池探针（sidecar 条目配置层可用 ≠ 月度池有量），是另一独立工作项；③ 改默认注册要连带改面板/stats/测试。待 ask-native 收口立项时一并定。
