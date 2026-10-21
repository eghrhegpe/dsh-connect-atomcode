# RELEASING.md — 发版手册

给"发一个新版本"这件事的完整落点。纪律条款在 `AGENTS.md`，这里只写**动作顺序**与**本仓库特有的坑**。

用法（三种入口）：

- **新发版**：按 3 → 11 顺序走（10 市场投稿与发版解耦，可择日做）。
- **断点续发**：先查 §1 状态判定表，确认卡在发版链哪一环，只补缺的那几步。
- **已发生 tag / npm / Release 任一动作**：先看 §2 不可逆点，再决定能不能修、如何修。

## 0. 发布形态（和兄弟插件同款）

| 项 | 值 |
|---|---|
| 包名 | `dsh-connect-atomcode`（无 scope） |
| 仓库 | `github.com/eghrhegpe/dsh-connect-atomcode`（默认分支 **master**，`ci.yml` 看这条分支） |
| 上游移植来源 | `Yinyuan34513/dsh-atomcode-bridge`（**MIT，只作出处引用，别改**） |
| tag | `v<package.json version>`（附注 tag） |
| npm | `package.json` 的 `prepack: npm run build` + `files` 白名单 + `publishConfig{registry: npmjs.org, access: public}` + 仓库根 `.npmrc` 再钉 registry |
| GitHub Release | `gh release create vX.Y.Z --verify-tag`，不附产物，正文是独立可读的公告 |

**tag、`master`、npm、Release 是四个独立事实**：任一先发生都不会带上其余三个。"tag 已推"或"npm 已发"都不等于发版完成，按 §1 判定。

产物**必须入库**（`lib/`、`client.js`、`src/`、`test/`、`docs/`、`scripts/`），因为 GitHub 直装源不跑 prepack。**不要**用 `prepare` 在安装时构建（pnpm 拒绝为 git 依赖跑构建脚本，见 `tsdown.config.mjs` 头部）。

## 1. 发版状态判定表（先判断，再动手）

先跑一遍下面的命令组，把当前状态定位到某一个格子。定位错了，后面的顺序会全错。

**这组命令已经脚本化**：`node scripts/release-status.mjs [X.Y.Z]` 一次打印上面 A–E 的实测值、下面的判定格子，
以及见「最终闭环清单」的逐条 ✓/✗（`?` = 查不动，与 `✗` 不同）。人机交接时**贴它的输出**，不要口头复述、
更不要靠记忆勾选。脚本只**填格子**（照抄本表），判定规则仍以本表为准；它只读，不 fetch / 不 push / 不动 tag。
它另外代填一行 **§3 号规**（`破坏性号`）：破坏性改动落在 patch 号且**未发布**时给 ✗，`--check` 一并因它退 1；
该版若已发布则记 ⚠ 历史、不判红——号收不回（§2 不可覆盖），拦在发版前才有意义。

```bash
# A. 仓库侧：tag 是否存在、指向哪里
git tag -l vX.Y.Z
git rev-list -n1 vX.Y.Z

# B. 仓库侧：版本提交是否已推（ahead 有输出 = 还躺在本地）
git status -sb
git log --oneline @{u}..HEAD

# C. 版本侧：package.json / CHANGELOG 是否已落到目标版本
grep '"version"' package.json
head -n 40 CHANGELOG.md

# D. npm 侧：目标版本是否已发（查不到 = 还没发）
npm view dsh-connect-atomcode@X.Y.Z version

# E. GitHub 侧：Release 是否已建
gh release view vX.Y.Z --json name,tagName,isDraft,isPrerelease,assets
```

| 状态 | 特征 | 还缺什么 | 下一步 |
|---|---|---|---|
| S0 未开始 | 无 tag、npm 还是旧版、无 Release | 全流程 | 从第 3 步走完整链路 |
| S1 代码已入库 | 修复已提交、已推；`package.json` 尚未升版 | 版本文件、tag、npm、Release | 先补齐 3/4，再走 6/7/8/9 |
| S2 已 tag | 有 tag、master 已推；npm 未发 | npm、Release | 走 7/8/9 |
| **S2′ 顺序颠倒：已 npm、未 tag** | `npm view @X.Y.Z` 能查到；`git tag -l vX.Y.Z` 为空（`master` 上的版本提交可能也还没推） | tag、master、Release | **先做 §8 内容核验**，把 tag 指到「被核验过的那个提交」（不是当时 HEAD），再推 master、补 Release（§9）；**不要重新 publish** |
| S3 已 npm | 有 tag、npm 已发；无 Release | Release | 只走 9 |
| S4 完整 | 四个事实都在 | 无 | 只做最终核对 |

**顺序颠倒（先发 npm 后打 tag）不会有任何东西报错——只能靠这张表认出来。** 认出之后按 S2′ 收口，别试图覆盖已发版本。

## 2. 不可逆点（先记住四条，再动手）

1. **npm 已发布 ⇒ 该版本号不可覆盖。** 目标版本若已在 npm 列表里，不能把 tag 移回去假装"补上一版"；正确动作是开下一个 `X.Y.(Z+1)`。
2. **Release 已建 ⇒ tag 基本钉死。** 尤其当 Release 与 npm 版本同时存在时，移动 tag 会让"用户装到的内容"与"Release 指向的内容"分叉。
3. **`--verify-tag` 漏掉 ⇒ 可能悄悄新建 tag。** tag 不存在时 `gh release create` 会把 tag 指向当前 HEAD。补 Release 前务必先确认 tag 已推。
4. **先 publish、后打 tag ⇒ 取证责任转移到你身上。** 当时的 HEAD 未必就是被 publish 的那份内容；补 tag 前必须按 §8 证明「npm 上那一版 == 某个提交的构建产物」。正序（6 → 7 → 9）时这件事免费：tag 在 publish 之前就定好了。

判断某个 tag 是否还能动（**任一事实已发生：不要移 tag，只发下一版**）：

```bash
npm view dsh-connect-atomcode versions      # 目标版本已在列？→ 不可移
gh release view vX.Y.Z --json tagName       # Release 已存在？→ 不可移
```

## 3. 版本号单一真源（package.json）

- 唯一手改点：`package.json` 的 `version`
- `src/host/index.ts` 在运行时读它（`JSON.parse(readFileSync(join(packageDir, "..", "package.json"), "utf8")).version`），**不存字面量**

（早年这里是「两处手改、两处必须一致」；后来改成运行时读 manifest，真源收敛成一处。断言在 `test/wiring.test.mjs` 的 version-truth 套件：`package.json is the only version declaration in the host half`——任何 src/host 文件里再出现版本字面量就红；`the committed artifact reports the manifest version at runtime` 钉住产物读的是 manifest。）产物 `lib/index.js` 由构建生成，**手改产物无效**（下一次构建就抹掉）。`cordis.patch.yml` 没有 version 字段。

**号规：破坏性改动不许落在 patch 号上。** 最新 CHANGELOG 节若声明了「破坏性改动」（`### 破坏性改动` 一类小标题），
版本号的第三段**必须为 0**——也就是必须升 minor。理由不是仪式感：按 semver 取「安全小版本」的更新通道
会把 patch 号当作**无破坏承诺**，patch 号装破坏性改动，等于让那条通道把破坏当修复直接吃进去。
`node scripts/release-status.mjs` 的发版前一刻读这一行（见 §1）；**发布之后号收不回**（§2 不可覆盖），
所以这一格只在未发布时判红，已发布就记 ⚠ 历史。先例是本仓库自己的 0.4.3：「ask 缺 working_dir 直接拒绝」
是行为变更，却进了 patch 号——这条规则就是为它立的。

### 3.1 第三处：注释里的版本号标签 —— 已改为**禁止**，有断言钉着

拆分/重构类提交习惯把「这次改动属于哪个版本」写进文件头注释与测试头注（当时是 `v… split` 这类写法，
同时散在 6 个 `src/host/*.ts` 和 8 个 `test/*.test.mjs` 里）。这**不是版本真源**，只是一段历史叙述——
但它在版本定稿**之前**就写死了：如果实际发布的是另一个号，这些标签会永久说谎。

**旧规则是「发版时 grep 一遍对齐」，而它已经失效过一次**：本文件曾把数量写死成「这 8 处」，
等到真去数的时候已经是 13 处（`src/host/daemon.ts` 里的两处旧标签、`tsdown.config.mjs` 一处、
以及测试里三处都漏了）——一个只能靠人手数的清单，就是一份会过期的清单。

现在的规则是**禁止**，不再是对齐：

> `src/**/*.ts`、`test/**/*.mjs`、`tsdown.config.mjs` 里**不许出现任何 `vX.Y.Z` 形式的版本标签**。
> 注释里写**事件名**（`the apply() split` / `the abort path` / `the earlier gate`），不写是哪个版本。

- 断言：`test/wiring.test.mjs` 的「no src/ or test/ file carries a vX.Y.Z release label in prose」——
  任何一处漏网就红，报出 `文件:行号`。所以**不需要再 grep**。
- 版本号只有一处手改（§3：`package.json`，`src/host/index.ts` 运行时读它）+ `CHANGELOG.md`（那是发布史，本来就该写号）；
  产物里的号由构建生成，手改无效。
- 想知道「某次改动属于哪个版本」：`git log` / `git tag` / `CHANGELOG.md`。注释不是发布史。

## 4. 记 CHANGELOG

在 `CHANGELOG.md` 顶部按**文首的尺子**补一段——**这是 DSH 插件市场渲染给用户看的更新日记**，不是维护者档案：
条目只写「你能得到什么 / 什么不再坏」，读者是没看过代码的人（判据、去向表、正反示例都在文件开篇）。格式为版本 / 日期 /
新增·修复（不设「变更 / 工程」当垃圾桶——内部重构、测试、文档维护一律去 `git log`），逐条标 commit 短哈希。
**先 `git log --date=short` 扫一遍 HEAD 里有哪些没入档的提交**——本仓库踩过"版本号停在旧版、一批新改动没写进 CHANGELOG"的坑，直接发会把它们错标。

## 5. 验证（改动 `src/` 或 `package.json` 时必须全跑）

```bash
npm run typecheck
npm run build
npm test
```

- `npm test` 不联网、不耗额度（假 daemon / 假 spawn / 纯函数）。
- `test/build-gate.test.mjs` 用真 `tsdown.config.mjs` 重跑构建，要求与提交的产物**逐字节**相同。
- 改动 `test/*.test.mjs` 后跑全量 `npm test`：套件由 `scripts/test.mjs` 自动发现，落盘即参跑——过去"新套件没挂进链"的失误从代码层消掉了。

## 6. 提交与打 tag

```bash
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin master vX.Y.Z
```

- **并行会话纪律**：工作树常同时有他人未提交改动。提交用路径限定
  `git commit -m "<说明>" -- <自己的文件>`，禁 `git add -A`；未跟踪新文件要先 `git add <文件>`
  再不带路径 `git commit` 提交索引。提交后 `git status --short` 复核没带走别人的东西。
- **tag 重打仅限 §2 的两条判据都成立时**（目标版本未上 npm、未建 Release）：
  `git push origin :refs/tags/vX.Y.Z` 删掉再推。任一事实已发生，重打/force 都禁止——
  npm 不可覆盖，唯一正解是开下一版，让漏掉的提交随 `X.Y.(Z+1)` 到达用户。

### 6.1 推荐顺序：先推 master、等 CI 绿，再 tag + publish

正序是「提交 → tag → 推 master → publish → Release」。挪成下面这样，多花约 50 秒，换两件事：
**tag 不会指向一个 CI 红的提交**，且发布内容与 `master` 天然对齐。

```bash
git push origin master
gh run list --limit 1 --json databaseId   # 取这条 push 的 run id
gh run watch <id> --exit-status            # 红了返回非零，可直接当门禁
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin master vX.Y.Z
```

- **为什么要等**：CI 在**发布提交**上绿，才算"发出去的这一版被真验过"。
- 顺手扫最近 5 条（`gh run list --limit 5`）：若连着 `failure`，说明**门禁本身可能已失效**——
  此时"本地全绿"是唯一证据，先修门禁，再发版。
- **CI 红了怎么办**：该版本**尚未 publish** 时移动 tag 合法（§2 第 1 条前提仍在）——修完再 tag；
  **已经 publish** 就只补 tag/Release（S2′/S3），不要试图覆盖已发版本。
- 不想等也可以：6 → 7 → 9 正序本身就是合法路径，只是少一道确认。

## 7. 发布到 npm

```bash
npm whoami            # 仓库目录内项目 .npmrc 已把 registry 钉到 npmjs；E401 = 没登录 npmjs
npm publish --dry-run # 可选：只打包不发布，检查 files 白名单
npm publish
npm view dsh-connect-atomcode version   # 应为 X.Y.Z
```

**本机注册表是 `registry.npmmirror.com`（只读镜像，会拒绝 publish）**，用户级 `~/.npmrc` 里写的就是它。
两道保险把它钉回 npmjs：

1. `package.json` 的 `publishConfig.registry = https://registry.npmjs.org/`（publish 时优先于 config registry）
2. 仓库根 `.npmrc` 的 `registry = https://registry.npmjs.org/`（防 `--registry` 或 stray 用户级设置覆盖）

**不要**在发布前临时改用户级 `.npmrc` 的 registry——它会改变你的安装源。

`files` 白名单要含：`lib/`、`client.js`、`src/`（可选）、`icon.svg`、`locale/`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`LICENSE`。可用 `npm publish --dry-run` 核对。

- **E401 preflight**：`npm publish` 会**先跑完 `prepack` 构建再失败**，失败信息看着像构建问题——发布前先 `npm whoami`。补救只有一条命令 `npm login`（交互式、需要凭据，AI 不要代做）。
- **人机 handoff 契约**：仓库侧（版本文件、CHANGELOG、构建、测试、提交、tag、推送、§8 核验、Release）AI 能全程做；**只有人能按 `npm publish`**。交接以命令输出为证，不靠记忆：AI 请求 publish 前必须逐条报出 ①工作树干净、无 ahead ②版本提交已在 `origin/master` ③tag 指向该提交 ④该提交 CI 绿 ⑤本地 `npm test` 全绿；人 publish 后回报一行 `npm view dsh-connect-atomcode@X.Y.Z version`，AI 拿到该行才做 §8 核验 + §9 Release。AI 的职责到"判定状态 + 交齐证据 + 收口"为止，不是"执行到你叫我做的那一步为止"。

## 8. 内容一致性核验（正序 / 补发都要做）

目的只有一个：**证明「用户装到的内容」与「tag 指向的提交」是同一份东西**。正序时它是收尾证据；
S2′（先发了 npm）时它是补 tag 的**前置条件**——两者都别省。

```bash
# 包名带 @版本，才会从 registry 取；不带版本会打包本地目录！
npm pack dsh-connect-atomcode@X.Y.Z --pack-destination tmp
tar -xzf tmp/dsh-connect-atomcode-X.Y.Z.tgz -C tmp     # 解包到 tmp/package/
```

与本机产物逐文件比 SHA256（build-gate 保证本地产物 == 新构建，所以一致即证明"发布内容 == 本提交的构建产物"），外加三条最便宜的检查：

| 检查 | 为什么是这条 |
|---|---|
| `tmp/package/` 全部文件（`lib/`、`client.js`、白名单内其余）与本机 SHA256 一致 | "同一份内容"的唯一硬证据；文件数相同只是必要条件 |
| `tmp/package/lib/index.js` 含运行时版本读码（`JSON.parse(readFileSync(join(packageDir, "..", "package.json"), "utf8")).version` 那一行） | 证明构建来自本版源码，不是缓存旧产物。单源版本制下 lib 产物里**没有** `version` 字面量可 grep（版本在运行时从 `package.json` 读，见 §3），所以这一条验的是读码行仍在，不是版本号本身 |
| `tmp/package/CHANGELOG.md` 含本版节 | 证明版本文件同步进了包 |
| `tmp/package/package.json.version` == X.Y.Z | 最低限度 |

- Windows/PowerShell 下比对前把路径分隔符统一（`lib\` 与 `lib/` 会让"文件清单不一致"这种假差异冒出来）。
- `tmp/` 是 gitignored scratch 目录，解包到那里安全。
- 不想全量比：确认包里有**本版新加的那句用户可见文案**——它能同时证伪"构建用了旧产物"和"发的是上一版"。

**不做这一步会怎样**：不会有任何东西报错。用户装到的是一份、GitHub 上 tag 指的是另一份，两者在下次有人对比之前一直"看起来都对"。

## 9. 创建 GitHub Release（**最容易漏，务必做**）

**tag 推送成功 ≠ 发布完成。** Release 是用户从 GitHub 进入时的第一屏，也是 tag 对外的说明。
它与 npm 包是两条独立通道：tag 推送不会自动创建 Release，npm 发出去也不会。

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — <一句话说明>" \
  --notes-file tmp/release-X.Y.Z.md \
  --verify-tag
```

- **`--verify-tag`（务必带上）**：tag 必须已存在（第 6 步推过）。漏了它，gh 会在 tag 不存在时**悄悄新建一个指向当前 HEAD 的 tag**——那可能不是你发布的那次提交。
- 不要用 `--notes-from-tag`（tag message 只有一行，正文会空得离谱），也不要用 `--generate-notes`（自动 commit 列表，与本仓库形态不符）。
- 不加 `--draft`、不加 `--prerelease`：均为正式发布。
- **不附任何构建产物**：本插件经 npm / 注册表分发，不要在 Release 里塞 `.tgz`。
- **正文形态**：可独立阅读的发布公告——本版主线一到两段（有两条主线就点名），后续按主题分节；允许表格、对照、取证；**不是 CHANGELOG 的复制粘贴**（CHANGELOG 是变更记录，Release 是发布公告）。
- **忘了怎么办**：事后补建与当时创建完全等效（版本、tag、正文都还在仓库里），只是 GitHub 上的时间戳晚。

核对清单（**做完逐条勾掉**）：

- [ ] `gh release list` 里能看到本次版本，标题以 `vX.Y.Z — ` 开头（破折号）
- [ ] Release 指向的 tag 与第 6 步推的是同一个：`gh release view vX.Y.Z --json tagName`
- [ ] 不是 draft、不是 prerelease
- [ ] `assets` 为空（与分发方式一致）
- [ ] 正文不是 CHANGELOG 的复制粘贴，单独读也讲得通

`gh release view vX.Y.Z --json name,tagName,isDraft,isPrerelease,assets` 一次确认以上五点。

## 10. 市场投稿

规则只认上游原文，本仓副本在 `awesome-dsh-plugin-submission/contributing.md`——**别在本文件转述规则**（此前那三条「别加 npm: 字段 / 别放截图 / 别手改 README」就是转述，上游一改就作废）。

本仓只有一件事实：条目文件 `awesome-dsh-plugin-submission/eghrhegpe__dsh-connect-atomcode.yml`，提 PR 时原样复制到
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的
`data/plugins/eghrhegpe__dsh-connect-atomcode.yml`。不要在这里再维护第二份 yaml。

## 11. 升级时对用户的影响

改名/换 id 属于破坏性变更：`cordis.patch.yml` 的 `id`、`src/client/index.ts` 的注册 id（红线 6，
`test/client-id.test.mjs` 逐字断言）、state 路径（`~/.dsh/state/<包名>/`）都跟着包名走。若改了包名，
旧版本用户已写入的 `provider.json` / `sessions.json` 不会自动迁移——发版说明里要写明。

## 最终闭环清单（完成判定，不再凭感觉）

发版是否完成，只看下面 5 个事实是否全部成立。**第 6 条是「发布前置」事实**：它不进 5 条的完整性判定，
但进 §7 的交接判定（见下）。这 6 条的机器可读版就是 `node scripts/release-status.mjs` 的最后几行——
交接时贴它的输出，别口头复述。

- [ ] **仓库可查**：`vX.Y.Z` tag 存在，且 `git rev-list -n1 vX.Y.Z` 指向本次要发布的 commit。
- [ ] **master 可查**：该 commit 已在 `origin/master`，`git log --oneline -5` 能追到版本提交。
- [ ] **版本文件可查**：`package.json` 是版本单一真源、`src/host/index.ts` 运行时读它（`npm test` 的 version-truth 断言绿）；`CHANGELOG.md` 顶部已有该版本节。
- [ ] **npm 可查**：`npm view dsh-connect-atomcode version` 返回目标版本。
- [ ] **GitHub Release 可查**：`gh release view vX.Y.Z --json tagName` 能查到，且 `isDraft=false`、`isPrerelease=false`、`assets=[]`。
- [ ] **发布提交上 CI 绿**：`gh run list` 里该 commit 的 run 结论是 `success`。它**不进上面 5 条的「完整发布」判定**
      （npm 与 Release 都在时，包本身是完整的），但**进「能不能请人 publish」的判定**——§7 要求 AI 在开口请人发布前
      逐条报出的五项证据里，第 ④ 项就是它。两处口径必须一致：**CI 红时不许开口请人发布**，先在本地把红修掉。
      （2026-10-17 的 0.4.3 就是从这里漏的：tag 指的那次提交上连着四条红 run 没人拦，因为这一条当时被写成「推荐」。）

只要有一个缺，就是"未完整发布"。回 §1 判定表定位缺的是哪一环，只补缺口；**任何一步都不得假设"前面那一步已经做完了"**。

## 本仓库特有的红线（发版前再过一遍）

- `src/host/daemon.ts` / `lib/daemon.js` 的 `Ported from \`dsh-atomcode-bridge\` (Yinyuan34513, MIT, 2026-08-15)`
  是**上游出处**，改名/搬运时保留原样。
- `~/.atomcode/config.toml` 永远只读；面板写的是插件自己的 state 文件。
- 版本号、`lib/index.js` 的 `name`/`version`、`client.js` 的注册 id，三者由 build 从 src 生成，
  只改 src，别手改产物。
