# Polarbear Memory npm 发布指南

本文面向 `polarbear-memory` 维护者，说明如何把 CLI 安全发布到 npm Public Registry，使用户可以通过 npm 安装。本文只讲 npm 包；签名、公证的 macOS `.pkg` 仍按 [MACOS_RELEASE.md](MACOS_RELEASE.md) 发布。

## 1. 用户最终如何安装

Polarbear Memory 是 CLI。推荐用户全局安装：

```bash
npm install --global polarbear-memory
polarbear-memory --version
```

用户也可以只在项目中安装并通过 `npx` 运行：

```bash
npm install --save-dev polarbear-memory
npx polarbear-memory --version
```

当前 `package.json` 要求 Node.js `>=24.10.0 <27`。不满足该范围的用户可能收到 `EBADENGINE`，因此 README 和 npm 包页面必须显著写明 Node 版本要求。

## 2. 当前状态

截至 2026-08-27，仓库内的 npm 包结构门禁已经完成：

- Apache-2.0 许可证和第三方声明已经落地。
- `package.json#files` 是发布内容白名单。
- `tsconfig.npm.json` 只生成运行时 JavaScript，不生成测试、fixture、声明文件或 source map。
- `npm run package:audit` 审计 npm 实际计算出的 tarball 文件清单，而不是只检查源码目录。
- `npm run package:smoke` 从真实 `.tgz` 安装到临时目录，并执行版本检查和 `init --dry-run`。

当前 dry-run tarball 为 27 个文件、约 212 KB。PRD、TRD、用户手册、验证方案、`.business/`、`src/`、测试、fixture、脚本和 source map 均不发布。首次正式发布仍需完成 npm 账号、2FA、包名复查和 release commit 审核。

Registry 对 `polarbear-memory` 当前返回 HTTP 404，包名看起来尚未占用，但这不构成预留。正式发布前必须再次检查：

```bash
npm view polarbear-memory name version
```

若返回 `E404`，通常表示尚无此包；若已存在且不属于你的账号或组织，请改用 scoped 名称，例如 `@smartscity/polarbear-memory`。不要发起名称冒用或覆盖尝试。

## 3. 已实施的包结构规范

### 3.1 Apache-2.0 许可证（已完成）

Polarbear Memory 已正式选择 Apache License 2.0：

- 根目录 `LICENSE` 保存完整 Apache License 2.0 文本。
- `package.json` 与 `package-lock.json` 使用 SPDX identifier `Apache-2.0`。
- npm tarball 必须保留 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。

每次发布仍须执行：

```bash
npm run licenses:check
npm run sbom:check
```

### 3.2 `package.json` 发布白名单

当前配置为：

```json
{
  "name": "polarbear-memory",
  "version": "0.1.0",
  "private": false,
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/smartscity/polarbear-memory.git"
  },
  "homepage": "https://github.com/smartscity/polarbear-memory#readme",
  "bugs": {
    "url": "https://github.com/smartscity/polarbear-memory/issues"
  },
  "bin": {
    "polarbear-memory": "dist/cli.js"
  },
  "files": [
    "dist",
    "api/admin-v1.json",
    "README.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "LICENSE"
  ],
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
```

不要只依赖 `.gitignore` 或 `.npmignore` 决定发布内容。`files` 是第一层白名单；独立 production build 是第二层；对 npm 真实 pack manifest 的逐路径审计是第三层。`README.md`、`LICENSE` 和 `package.json` 也会由 npm 按规则自动包含，白名单中仍显式列出 README 和 LICENSE，便于维护者审阅意图。

发布生命周期和门禁已经配置：

```json
{
  "scripts": {
    "build:npm": "tsc -p tsconfig.npm.json",
    "prepack": "npm run clean && npm run build:npm",
    "package:check": "npm run clean && npm run build:npm && npm run package:audit && npm run package:smoke",
    "prepublishOnly": "npm run release:gates"
  }
}
```

`prepack` 保证 tarball 使用刚刚构建的代码；`prepublishOnly` 防止 `npm publish` 跳过测试、依赖审计和包结构门禁。`package:smoke` 安装依赖时会访问 npm Registry，但 production build 和打包本身不联网，也不会读取或打包用户的 Memory 数据。

### 3.3 保持 CLI 入口可运行

`src/cli.ts` 的第一行必须保留：

```text
#!/usr/bin/env node
```

构建后检查：

```bash
head -n 1 dist/cli.js
node dist/cli.js --version
```

npm 会根据 `bin` 字段为本地和全局安装创建命令 shim。

## 4. 准备 npm 账号

1. 在 npmjs.com 创建维护者账号。
2. 为账号启用 2FA，并保存 recovery codes。
3. 本机确认使用官方 Registry：

```bash
npm config get registry
```

期望结果：

```text
https://registry.npmjs.org/
```

4. 登录并确认身份：

```bash
npm login
npm whoami
```

npm 当前要求直接发布使用启用了 2FA 的账号，或使用允许 bypass 2FA 的 granular access token。对自动化发布，本文更推荐后面的 Trusted Publishing，不建议保存长期 write token。

本次检查发现当前开发机的默认 `~/.npm` cache 含有 root-owned 文件，普通用户运行 `npm pack` 会得到 `EPERM`。不要用 `sudo npm publish` 绕过它，否则可能继续制造 root-owned 文件并让发布身份边界混乱。推荐按 npm 官方方案使用 Node version manager 重新安装 Node/npm，确保 cache 和全局安装目录归当前用户；在修复前仅做无副作用的本地打包检查时，可以临时指定可写 cache：

```bash
npm_config_cache=/tmp/polarbear-memory-npm-cache npm pack --dry-run
```

真正登录和发布前应彻底修复 npm 权限配置，而不是长期依赖临时 cache。

## 5. 发布前完整检查

必须从干净、已提交的 release commit 操作，不要从含未提交文件的工作区发布：

```bash
git status --short
git branch --show-current
git log -1 --oneline
npm ci --ignore-scripts
npm run release:check
```

`release:check` 已包含 `package:check`。然后仍应人工检查真正会进入 Registry 的 tarball：

```bash
npm pack --dry-run
npm pack
tar -tf polarbear-memory-0.1.0.tgz
npm publish --dry-run --access public
```

最后一条会完整触发 `prepublishOnly`，但不会占用版本号或写入 Registry；它是正式 publish 前最接近真实流程的演练。内部 tarball smoke test 会显式隔离外层 npm 的 `dry-run` 配置，仍然创建并安装临时 `.tgz`，完成后自动清理。

逐项确认：

- 没有 `.env`、token、证书、密钥、个人路径或 Memory 数据。
- 没有 `.business/`、内部设计草稿、测试、fixture、`src/` 和发布脚本。
- 包含 `dist/cli.js` 及其全部运行时模块。
- 包含 README、许可证、安全策略和第三方许可证声明。
- `dependencies` 完整；运行时依赖不能误放在 `devDependencies`。

在仓库外测试“用户拿到的包”，而不是测试源码目录：

```bash
mkdir /tmp/polarbear-memory-package-smoke
cd /tmp/polarbear-memory-package-smoke
npm init --yes
npm install /path/to/polarbear-memory/polarbear-memory-0.1.0.tgz
npx polarbear-memory --version
git init demo
cd demo
npx polarbear-memory init --dry-run
```

完成后删除本地 `.tgz`，避免误提交。

## 6. 第一次手工发布

确认 npm 包名仍可用、release commit 已推送、2FA 正常后：

```bash
cd /path/to/polarbear-memory
npm publish --access public
```

若 npm 要求 OTP，按提示输入 authenticator code。不要把 OTP 或 access token 写进 shell history、文档或 CI log。

发布后立即验证：

```bash
npm view polarbear-memory name version dist-tags repository engines
npm install --global polarbear-memory@0.1.0
polarbear-memory --version
npm uninstall --global polarbear-memory
```

再检查 npm 包页面：

```text
https://www.npmjs.com/package/polarbear-memory
```

确认 README、许可证、repository、版本和安装命令正确。

## 7. 推荐的长期方式：GitHub Actions Trusted Publishing

是的，GitHub 可以自动发布 npm 包。推荐触发链路是：

```text
维护者合并 release commit
  → push 与 package version 一致的 vMAJOR.MINOR.PATCH tag
  → GitHub Actions 在 GitHub-hosted runner 执行全部 release gates
  → 生成并保存 unsigned macOS release candidate
  → npm 通过 OIDC 验证指定 repository/workflow
  → npm publish --provenance
```

这不是“GitHub 自己拥有 npm 密码”，而是 npm Trusted Publishing 在每次 workflow 运行时验证 GitHub OIDC 短期身份。因此不需要把长期 `NPM_TOKEN` 存进 GitHub Secrets。只有指定仓库、指定 workflow 和可选 GitHub Environment 能取得发布权限。

第一次发布并取得包所有权后，在 npmjs.com 打开：

```text
Packages → polarbear-memory → Settings → Trusted publishing
```

绑定以下内容：

- Organization/User：`smartscity`
- Repository：`polarbear-memory`
- Workflow filename：`release-gates.yml`
- Environment：若使用 GitHub protected environment，填写对应名称
- Allowed actions：优先只允许 `npm stage publish`；若团队接受自动直发，再允许 `npm publish`

Trusted Publishing 使用 OIDC 短期凭证，不需要在 GitHub Secrets 保存 `NPM_TOKEN`。npm 官方当前要求 npm CLI `11.5.1+`、Node.js `22.14.0+`，并且必须使用 GitHub-hosted runner。GitHub Actions/GitLab Trusted Publishing 会自动生成 provenance；公开包要获得 provenance，源码仓库也必须公开。

仓库当前的 [release-gates.yml](../.github/workflows/release-gates.yml) 已实现完整链路：PR 和手工触发只运行 checks；普通 main push 不触发该 workflow；只有 push `v*.*.*` tag 才继续执行精确 SemVer 校验、macOS artifact 和 npm publish。校验要求 tag、`package.json` 与 `package-lock.json` 三者版本完全相同，并拒绝 `v1.2`、`release-1.2.3` 或带额外后缀的 tag。

当前 workflow 使用 GitHub Secret `NPM_TOKEN`，同时申请 `id-token: write` 生成 provenance。完成 npm Trusted Publisher 配置后，应删除 `NODE_AUTH_TOKEN` 环境变量和长期 write token，由 OIDC 直接授权；其余 job 不需要改变。

`npm publish` 会自动触发 `prepublishOnly`，从而再次执行 `release:gates`；这是 Registry 写入前的最后一道本地包门禁。

工作流文件名、repository owner/name 与 npm Trusted Publisher 设置必须完全一致，大小写也要一致。Trusted Publishing 配置成功后，建议在 npm package settings 中选择“Require two-factor authentication and disallow tokens”，并撤销不再使用的 automation write tokens。

更稳妥的流程是把最后一步改为：

```bash
npm stage publish --access public
```

Staged Publishing 要求 npm CLI `11.15.0+`，并且只适用于 Registry 中已经存在的包，不能代替第一次发布。然后由维护者在 npmjs.com 的 Staged Packages 页面审核 tarball 并用 2FA 批准。这样 CI 不能未经人工确认直接把不可变版本推向公众。

## 8. 后续版本发布

遵循 Semantic Versioning：

- `patch`：兼容性 bug/security fix。
- `minor`：向后兼容的新能力。
- `major`：不兼容变更。

示例：

```bash
git switch main
git pull --ff-only
npm ci --ignore-scripts
npm version 0.1.2 --no-git-tag-version
npm run sbom:generate
npm run release:check
git add package.json package-lock.json docs/SBOM.cdx.json
git commit -m "release: v0.1.2"
git tag v0.1.2
git push origin main
git push origin v0.1.2
```

上面的 `0.1.2` 只是示例，必须换成实际新版本。先提交版本文件和生成的 SBOM，再对该提交打 tag；不能先打 tag 再修改版本。tag push 会触发自动发布，GitHub Release 可在成功后补充 release notes。不要手工修改一个已经发布的 tarball；同一个 `name@version` 永远不能再次使用，即使该版本后来被 unpublish。

若要先发候选版本：

```bash
npm version prerelease --preid=rc
npm publish --tag next --access public
```

用户显式安装：

```bash
npm install --global polarbear-memory@next
```

验证稳定后发布新的正式版本，不要把未经验证的 RC 直接移动为 `latest`。

## 9. 发布错误后的处理

优先 deprecate 有问题的版本并立即发布修复版：

```bash
npm deprecate polarbear-memory@0.1.0 "Known issue: upgrade to 0.1.1"
npm version patch
npm publish --access public
```

不要把 `npm unpublish` 当作常规回滚。npm Registry 的版本是不可变记录：

- 已使用的 `name@version` 永远不能重新使用。
- 新包通常只有在发布后 72 小时内且没有其他 public package 依赖它时才能 unpublish。
- 完全 unpublish 一个包后，包名至少 24 小时不能重新发布。
- unpublish 不可撤销；超过政策条件时应使用 deprecate。

如果怀疑发布了 credential 或敏感信息，先立即撤销 credential，再联系 npm Support；仅删除 Git commit 或发新版本不能从已经发布的 tarball 中抹掉秘密。

## 10. 每次发布的最短检查清单

- [ ] 许可证已批准，根目录包含正确的 `LICENSE`。
- [ ] `private` 为 `false`，`repository` 与真实 GitHub 仓库一致。
- [ ] npm 账号和 package publishing 强制 2FA。
- [ ] release commit 干净、已 review、已推送。
- [ ] `npm run release:check` 通过。
- [ ] `npm pack --dry-run` 只包含允许公开的运行时文件和文档。
- [ ] 从 `.tgz` 安装后的 CLI smoke test 通过。
- [ ] version/tag/GitHub Release 三者一致。
- [ ] 使用 Trusted Publishing 或人工 OTP；没有长期 write token。
- [ ] 发布后从 Registry 全新安装并验证。

## 11. npm 官方参考资料

- [Creating and publishing unscoped public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [npm publish](https://docs.npmjs.com/cli/commands/npm-publish/)
- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- [Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing/)
- [Resolving EACCES permissions errors](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/)
- [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- [Creating and publishing organization scoped packages](https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/)
- [npm Unpublish Policy](https://docs.npmjs.com/policies/unpublish/)
