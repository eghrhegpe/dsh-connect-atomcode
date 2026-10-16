# RELEASING.md — 发版手册

给"发一个新版本"这件事的完整落点。纪律条款在 `AGENTS.md`，这里只写**动作顺序**与**本仓库特有的坑**。

## 0. 发布形态（和兄弟插件同款）

| 项 | 值 |
|---|---|
| 包名 | `dsh-connect-atomcode`（无 scope） |
| 仓库 | `github.com/eghrhegpe/dsh-connect-atomcode` |
| 上游移植来源 | `Yinyuan34513/dsh-atomcode-bridge`（**MIT，只作出处引用，别改**） |
| tag | `v<package.json version>`（附注 tag） |
| npm | `package.json` 的 `prepack: npm run build` + `files` 白名单 + `publishConfig{registry: npmjs.org, access: public}` + 仓库根 `.npmrc` 再钉 registry |

产物**必须入库**（`lib/`、`client.js`、`src/`、`test/`、`docs/`、`scripts/`），因为 GitHub 直装源不跑 prepack。**不要**用 `prepare` 在安装时构建（pnpm 拒绝为 git 依赖跑构建脚本，见 `tsdown.config.mjs` 头部）。

## 1. 版本号两处手改

- `package.json` 的 `version`
- `src/host/index.ts` stats body 的 `version: '...'`

两处必须一致。断言在 `test/wiring.test.mjs`；产物 `lib/index.js` 由构建生成，**手改产物无效**（下一次构建就抹掉）。`cordis.patch.yml` 没有 version 字段。

## 2. 记 CHANGELOG

在 `CHANGELOG.md` 顶部按既有格式补一段（版本 / 日期 / 新增·修复·变更三小节），逐条标 commit 短哈希。**先 `git log --date=short` 扫一遍 HEAD 里有哪些没入档的提交**——本仓库踩过"版本号停在旧版、一批新改动没写进 CHANGELOG"的坑，直接发会把它们错标。

## 3. 验证（改动 `src/` 或 `package.json` 时必须全跑）

```bash
npm run typecheck
npm run build
npm test
```

- `npm test` 不联网、不耗额度（假 daemon / 假 spawn / 纯函数）。
- `test/build-gate.test.mjs` 用真 `tsdown.config.mjs` 重跑构建，要求与提交的产物**逐字节**相同。
- 改了 `scripts.test` 链要连带核对 `test/` 下每个 `*.test.mjs` 都挂进链里。

## 4. 提交与打 tag

```bash
git tag -a v0.4.2 -m "0.4.2 — <一句话说明>"
git push origin master v0.4.2
```

- **并行会话纪律**：工作树常同时有他人未提交改动。提交用路径限定
  `git commit -m "<说明>" -- <自己的文件>`，禁 `git add -A`；未跟踪新文件要先 `git add <文件>`
  再不带路径 `git commit` 提交索引。提交后 `git status --short` 复核没带走别人的东西。
- **tag 重打**：若远程已有同名 tag（比如上次发到一半改了提交），
  `git push origin v0.4.2 --force`（或先 `git push origin :refs/tags/v0.4.2` 再推）。tag 未分发前 force 是安全的。

## 5. 发布到 npm

```bash
npm whoami            # 确认已登录 npmjs（token 在用户级 .npmrc，见下）
npm publish --dry-run # 可选：只打包不发布，检查 files 白名单
npm publish
npm view dsh-connect-atomcode version  # 应为 0.4.2
```

**本机注册表是 `registry.npmmirror.com`（只读镜像，会拒绝 publish）**，用户级 `~/.npmrc` 里写的就是它。
两道保险把它钉回 npmjs：

1. `package.json` 的 `publishConfig.registry = https://registry.npmjs.org/`（publish 时优先于 config registry）
2. 仓库根 `.npmrc` 的 `registry = https://registry.npmjs.org/`（防 `--registry` 或 stray 用户级设置覆盖）

**不要**在发布前临时改用户级 `.npmrc` 的 registry——它会改变你的安装源。

`files` 白名单要含：`lib/`、`client.js`、`src/`（可选）、`icon.svg`、`locale/`、`cordis.patch.yml`、`README.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md`。可用 `npm publish --dry-run` 核对。

## 6. 市场投稿

`docs/submission/eghrhegpe__dsh-connect-atomcode.yml` 复制到
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的
`data/plugins/eghrhegpe__dsh-connect-atomcode.yml`，开 PR。CI 有 pr-check + check-submission。

- **别加 `npm:` 字段**（市场从仓库元数据推断）
- **别在 yml 里放截图**（市场读仓库根 `screenshots.json` / `icon.svg`）
- README 由仓库的脚本自动生成，投稿时别手改市场 README

## 7. 升级时对用户的影响

改名/换 id 属于破坏性变更：`cordis.patch.yml` 的 `id`、`src/client/index.ts` 的注册 id（红线 6，
`test/client-id.test.mjs` 逐字断言）、state 路径（`~/.dsh/state/<包名>/`）都跟着包名走。若改了包名，
旧版本用户已写入的 `provider.json` / `sessions.json` 不会自动迁移——发版说明里要写明。

## 本仓库特有的红线（发版前再过一遍）

- `src/host/daemon.ts` / `lib/daemon.js` 的 `Ported from \`dsh-atomcode-bridge\` (Yinyuan34513, MIT, 2026-08-15)`
  是**上游出处**，改名/搬运时保留原样。
- `~/.atomcode/config.toml` 永远只读；面板写的是插件自己的 state 文件。
- 版本号、`lib/index.js` 的 `name`/`version`、`client.js` 的注册 id，三者由 build 从 src 生成，
  只改 src，别手改产物。