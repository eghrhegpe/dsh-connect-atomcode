# 设计决策与「不做」清单

本文件收纳两类东西，都是**改代码前该先读、改完后别忘更新**的：

- **仍然有效的决策** —— 当前设计受哪些已定型的约束；
- **未修 / 明确不做** —— 已经想过、权衡过、决定不做的事。**别把它当成"没做"，也别自己"顺手做了"。**

每个版本改了什么见 [`../CHANGELOG.md`](../CHANGELOG.md)；这份文件只讲**现在为什么是这样**。
（原先这两节挂在 `README.md` 的「v0.4 治理记录」标题下——那是把"当前约束"混进"版本历史"，
2026-10-16 拆开：历史进 CHANGELOG，约束留在这里。）

---

## 仍然有效的决策

- **ask_max_rounds 默认 25（不再是 0）**。它是**停止等待 + 尽力停止**的止损：断客户端这条 HTTP 流，并向 daemon 发 `POST /chat/stop` 请求停掉该回合（见下条）；请求失败或回合刚开始还没拿到 session_id 时，daemon 侧回合可能继续跑完。对无人值守的 agent 而言，这个数字约束的是**用户等多久**、不是 agent 干多少（25 轮 shell/写文件/出网足以造成实质损害）——请连同 `README.md` 的安全姿态一节一起读。轮数上限 1000 在代码里钳制（见下条）：熔断不是能被一个巨大数字关掉的东西
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
- **三个旋钮的上限钳制在代码里，不在描述里**（2026-10-17）。`timeout_secs` / `max_rounds` / `max_duration_secs` 都曾经只在参数描述里承诺上限，代码原样放行：`1e9` 分别变成 1e12ms 线预算（被宿主守卫砍成"已取消"，描述承诺的超时没出现）、熔断失效（只剩 30min 墙钟）、保险丝失效（进程兜底 max+60s 越过宿主 30min，保险丝不是变长而是看不见地失效）。上限统一收在 `config.ts`（`HOST_TOOL_TIMEOUT_MS` / `MAX_ROUNDS_CEILING` / `MAX_REVIEW_DURATION_SECS`），解析器（`resolveMaxRounds` / `resolveDurationSecs`）同时钳制**每调用参数和配置默认值**——钳制只挂在参数路径时，面板会把一个代码永不执行的预算显示给用户。`0` 是"关熔断"的**字面量**，永不被钳制成数字；墙钟旋钮没有 `0` 语义（`0`/非法值回落默认）。`resolveMaxRounds` 从 `tools.ts` 移到 `config.ts`：默认值、门槛、上限、解析器是一个策略，拆在两个模块里就要么重复要么只钳一半
- **「熔断会不会被改名致盲」从猜测变成实测对照，并明确记下「没有」的那条兜底**（2026-10-17）。熔断数的是 `tool_start` 事件，所以 AtomCode 给这类事件改名就会让它静默失效——此前 render 只能说「若被改名的是这类事件，熔断会少计/可能已失效」，因为插件手上没有第二个数。现在有了：daemon 在 `done` 里自报它自己的工具调用次数（`done.tool_calls`，实测帧里 `done.stats.tool_calls` 是同一个数），于是两者可以**对照**，结论只有三种，全部照实说：一致（改名不在被计数的事件里，本轮熔断是准的，但要提醒下一次改名未必还避开它）、对不上（给出两个数字，指出本回合熔断**确实**没生效）、daemon 没报（照实说无法当场判定）。第三条是刻意的：`daemon_tool_calls` **绝不**回落成本端计数——那样两边恒等，"对照"这个动作就永远返回"一致"；也**绝不**把「它报了 0」和「它什么都没说」合并成同一个值（0 是测量结果，null 是未知）。
  - **明确不做的**：没有加一条不依赖事件名的**中途**兜底保险丝，因为这条协议上不存在这样的信号，加任何一条都是装饰。逐个排除过：SSE **字节预算**——改名后的工具事件仍有字节，但按实测的事件体量，撞到任何合理阈值所需的时间远超 30min 墙钟，等于永不触发；**总事件数**预算——合法的长回复按 token 逐帧下发，光文本就能到几千帧，阈值必须定得比失控回合还高，同样永不触发；**探测到漂移就收紧墙钟**——违反既有原则（加性未知事件不得让健康回合失败），会把正常的长回合砍掉。所以漂移这一路的真实边界是：**墙钟超时 + 上一版接上的 `/chat/stop`**（触发时真的会去停掉 daemon 侧回合），而轮数这个紧边界只在词汇表完好时有效——这一条现在会**当场判定**，不再留给读者猜
- **ask 缺 working_dir 时拒绝该回合，而不是跑完之后提示**（2026-10-17）。红线 8 此前只对 `review` 生效（`tools.ts` 里直接 refuse），对 `ask` 退化成 render 里的一句话——**而 render 在回合结束之后才执行**：一句"工具在没人指定的目录里无人值守跑了"的警告，是随着那件事的结果一起送达的。更糟的是两个工具的强弱装反了：review 是有界的一次性评审，ask 才是带完整自主工具循环、能跑 shell 的那个。现在两者都拒绝。默认只拦**危险的那个组合**——`approval_mode: bypass`（出厂默认）**且**三层目录都取不到（调用参数 > 宿主会话 cwd > 插件配置 `working_dir`）——因为非 bypass 时人在环里，缺目录不构成无人值守。三条出路都写进错误文本：传 `working_dir`、配 `working_dir`、或显式传 `allow_unattended: true` 表示知情同意（把隐式危险默认换成一句必须说出口的话，与 `0 才是关熔断` 同一种做法）。**不静默改道沙箱目录**：调用方没给目录也可能是想读 home 下的文件，悄悄换个目录跑是把看得见的风险换成看不见的错答案。拒绝发生在碰 daemon 之前，所以没有回合被启动过。已确认既有测试全部显式传了 `working_dir`，不受影响
  - **⚠️ 后续更正（2026-10-17 同晚）**：本条「默认只拦危险的那个组合（bypass 且缺目录）」的触发条件**已被下方探针裁定推翻并落地**——headless 自动放行对**任何** mode 成立，门与 `approval_mode` 解耦：现在**任何 mode 下**三层取不到目录都拒绝，`allow_unattended=true` 是唯一放行；配套更新：单测里非 legal 的 `on-request` 换成合法枚举值 `accept_edits` 钉行为
  - ✅ **口径冲突已实测裁定**（2026-10-17 当天补做，`scripts/probes/approval-mode.mjs`，flash 档位共 3 个回合）：daemon 5.2.3 的 `approval_mode` 是**封闭枚举 `build | accept_edits | bypass | plan`**（未知值在模型调用前的 422 参数门拒绝，零额度）；单测里用的 `on-request` **不是**合法值（只有 test/ 里的假 daemon 收过它）。`build` 与 `accept_edits` 下强制命令类工具（bash 写文件）的无人值守回合**全程零 `permission_request`**：命令被自动放行执行（`tool_result success=true`），回合 7~8s 收口。这与二进制里的 `[headless] auto-approved` 字符串吻合，而本机 `~/.atomcode/config.toml` 没有任何 approval / yolo / ask-timeout 键——是 **daemon 设计而非本机配置**。于是原假设「关掉 bypass 会让无人值守回合卡在交互式审批上、工具直接不可用」**证伪**：非 bypass 不挂起，但换过去也**不形成人审门**（无人值守时与 bypass 效果等同），还会**丢掉只在 bypass 组合上触发的「缺目录就拒绝」门**。README 的「共享仓库请务必改成非 bypass」与 DECISIONS「关掉即不可用」两句**都错在各自的方向上**，两侧已同步更正；`POST /chat/permission {session_id, decision, tool_name}`（Y/A/N）应答通道存在，但只在有客户端连着 daemon 时才有"等人"的语义。另注：line 35 该条 rationale 里「非 bypass 时人在环里」的**前提**被同一实测推翻（无人值守时没有任何人在环里），门的触发条件已在**同一天落地解耦**（见 line 35 后续更正）：缺目录的拒绝不再挂在 bypass 上，`allow_unattended` 成为唯一的知情放行
- **回合进行中的读数走 `onProgress` → `stats.ask.inFlight`，不进工具返回值**（2026-10-17）。ask 的回复是**整轮聚合**后一次性返回的，所以一次跑几分钟的回合在它自己的返回值和面板上都只存在于终态：详情页每 5s 轮询，却只能显示一个不动的计数，与插件卡死无法区分。现在 `askChat` 在 SSE 事件落地后回调读数，工具写进 `stats.ask.inFlight`，快照带出去。三条边界是刻意的：①**只报计数与耗时，不报内容**——进度通道要是把部分回复也带上，就会变成第二份、更差的交付物被渲染到别处；②**`elapsedMs` 由 host 在构造快照时算**，不发起始时间戳——客户端与服务端有时钟偏移时，那会显示成一条"开始于未来"的回合；③**观察者抛异常被吞掉**（与 session store 的 `onError` 同一条规则：上报者不能弄死它上报的东西）——不吞的话，一个写错的回调会从聚合循环内部中断一条健康回合。清理放在 `finally` 里且**按对象身份判断**（`if (stats.ask.inFlight === live)`）：bag 只有一个槽位，模型完全可以并行发两个 ask，谁先结束就无条件清空的话，会把还在跑的那条从面板上抹掉。槽位只有一个，所以重叠时显示较新的一条——面板能有效展示的就是一条
  - 顺带修掉的一处结构问题：`usedTools` 原本靠类型推断，`report()` 这个闭包在第一次 `push` 之前就读它，推断失败（`TS7034`）。显式标了元素类型——闭包引用会把数组类型钉在读它那一刻
- **会话键按 daemon 身份判死，TTL 退化为兜底**（2026-10-17）。侧边对话的主要死因是 daemon 重启/空闲退出（~30min 级），而 24h 挂钟 TTL 看不见它：三小时前写的 id，daemon 十分钟前重启过，TTL 判定「还活着」，每次 `continue` 都拿它撞一次失败、烧一个回合，恢复手段（`reset_session`）只在失败文本里出现。现在 `set()` 随条目记录 daemon 指纹（`readDaemonIdentity`：`port:pid:token` 的 sha256 前 16 位——token 哈希而非原文，state 文件不是凭证库；pid 单独不够，刚释放的 pid 最容易被复用），`get()/count()/prune()` 走同一个 `isResumable`：指纹不符即死，与年龄无关。**未知永不等于死**：没有指纹字段（旧数据）、身份文件读不到（daemon 没起、`--no-auth` 不写文件）、探针抛错，都按"无法判定"放行，退化到纯 TTL 行为——误杀一条活会话是这条规则唯一不能引入的失败模式。顺带：`count()`+`oldestAgeMs()` 两次全量读合并为 `snapshot()` 一次读（5s 轮询的同文件双读双 parse），单因子入口保留给只要一个事实的调用方

- **一次返回只有一份上下文预算，而且预算算的是「模型读到的东西」**（2026-10-17）。此前有四个数各管一段：ask 的 `REPLY_CAP`、review 的 `REPORT_CAP`（都是 200_000）、`TOOLS_CAP`、`FINDINGS_CAP`——没有任何一个概念叫「本回合的预算」。真正的缺陷不在常量多，而在**review 的截断是按字段而不是按返回**：render 先把 findings 清单打出来，再把原文打出来，两个字段各自被各自的 cap 放行，于是一次返回可以携带接近**两倍**预算的内容。一个只有部分副本遵守的预算不是预算。现在：`OUTPUT_CAP` 是唯一常量，两条路径共用 `capProse`；review 的 render 先算 `rawBudget = max(REVIEW_REPORT_FLOOR, OUTPUT_CAP - digestChars)`，把清单已经吃掉的字数从原文预算里扣掉——**扣在有清单的那一侧，因为清单是这一侧的产物**。截断标记的文案也合成一处（`capProse`），只有 `remedy` 分段：被砍的回复和被砍的报告该做的事不一样，而标记本身的写法不许可调用点各自发明（此前一处写 "ask AtomCode to write the full text to a file"、一处只写裸的 "N more characters"，两种约定就是教读者信任其中一个、错过另一个）。标记写在返回文本**内部**：静默截断在模型眼里是一份完整答案，半个文档变成一段自信的错误总结正是这么来的——与 `tools_truncated` / `findings_parsed` 各自成字段而不是靠"没写"来表达，是同一条理由
  - `REVIEW_REPORT_FLOOR = 20_000` 是刻意的下限，不是"0 也能跑"：清单归一化过 severity/file/line/message，会丢掉原始行里的其它字段，所以一条 render 说"原文见下"却一个字都不打，正是这个预算要防的那种静默截肢。有了下限，最坏情况就是一个**能被人拿在手里的数**（`OUTPUT_CAP + REVIEW_REPORT_FLOOR`），而不是一条带例外、没人量得清大小的规则
  - 预算是**字符数**不是 token：这一侧永远看不到模型的 tokenizer，而字符数是唯一不用它也能核对的度量。它是给模型读的量（`render`），不是线上的量
  - 两处独立的截断同时发生时（findings 被字段上限截断 + 原文被本回合预算收到 `rawBudget`），`shortfalls` 会把**两条各自的**原因都写出来，而不是合并成一句"内容不完整"——读者需要知道该去调哪一个旋钮

> 机制层的硬约束（为什么不做 provider 接管、额度为什么只能靠文本解析、三条私有无版本协议怎么办）
> 写在 `../AGENTS.md` 的「三条事实」——那里是给改代码的人的入口，本文件不重复。

## 未修 / 明确不做

- **`approval_mode: bypass` 的默认值本身没改**。它不是插件能单方面收回的东西。**⚠️ 2026-10-17 实测更正**：本条旧文「关掉后 ask 回合会卡在交互式审批上、工具直接不可用」**不成立**——headless daemon 在非 bypass 时也会自动放行 ask 类工具（`[headless] auto-approved`，`scripts/probes/approval-mode.mjs` 同目录实测），无人值守下非 bypass 与 bypass 效果等同；而「共享仓库请自行改成非 bypass」的建议已被撤回：那样做既造不出人审门（无人值守时 headless 自动放行对任何 mode 成立）；旧版「缺目录就拒绝」门只挂在 bypass 上、换 mode 即静默丢掉的耦合已修（门的触发条件与 `approval_mode` 解耦，见 line 35 后续更正）。**真正有效的缓解**是有界的轮数 + 目录门（三层取不到目录即拒绝，与 `approval_mode` 无关）+ 不把 `atomcode_ask` 指向不该让工具跑的仓库；DSH 的权限 preset 对 ask 回合零感知（它穿透），不能指望
- **协议仍无版本钉扎**。真正的解法需要官方提供 `/protocol` 或稳定的事件契约；本版只能做到"坏了说清楚"。
- **`GET` 触发 spawn** 保留。只读轮询拉起后台进程是一个设计张力点，但"打开面板即有数据"是有意的权衡（README 已如实描述）。
- **会话键是 per-working_dir 而非 per-对话**。DSH 不暴露稳定的对话 id，这是合理妥协；现在**在工具描述里写明**了，免得模型误以为 `continue` 续的是自己这条对话。
- **`diff_text` 的临时文件**仍在系统 tempdir，被 SIGKILL 时会残留。单用户开发机风险低。
- **默认注册尚未按 provision 门控（未决，暂不做）**。候选方案：仅当存在**健康**的标准直连 provider 时才注册 `atomcode_review`（AtomGit-only 机器上工具直接消失，只留 ask）。暂不做的理由：① 机器级不可用已由「挂载期降级描述 + 执行期拒绝 + 面板 reviewReason」三处"调用前告知"兜住（红线 1 哲学：留着被降级的工具比凭空消失更有信息量）；② 「健康」判定需要活池探针（sidecar 条目配置层可用 ≠ 月度池有量），是另一独立工作项；③ 改默认注册要连带改面板/stats/测试。待 ask-native 收口立项时一并定。
