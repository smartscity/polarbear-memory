# 发布流程

[English](../../en/development/releasing.md)

## 事实源

- package version/scripts：`package.json`；
- locked dependency：`package-lock.json`；
- Admin contract：`api/admin-v1.json`、`api/admin-v1.types.ts`；
- SBOM：`docs/SBOM.cdx.json`；
- 发布判定：[发布就绪状态](../planning/release-readiness.md)。

## 准备

1. 确认工作区只有预期修改。
2. 选择版本，并同步 package、lock 与 SBOM metadata。
3. 验证 Admin API 与 Desktop 生成合同兼容。
4. 使用受支持 provider CLI 做 release-time smoke。
5. 关闭适用的外部 readiness blocker。

## 自动门禁

```bash
npm ci --ignore-scripts
npm run release:gates
npm pack --dry-run
```

Package audit 负责发布白名单，不要只依赖 `.gitignore` 或 `.npmignore`。

CI 还会使用最低支持的 Node 24 版本和最新支持的 Node 26 版本，在 macOS、Linux 与 Windows 上运行 Agent integration suite，覆盖结构化 launch 生成、旧配置迁移、带空格路径、最小 PATH 下的 MCP 启动以及 doctor 修复诊断。

## npm 发布

只从已评审且 tag 与 package version 一致的 commit 发布：

```bash
npm publish --access public
```

发布后在干净环境安装精确版本并验证。已经发布的 `name@version` 永远不能复用。

## macOS 安装包

本地验证 unsigned artifact：

```bash
npm run release:macos:unsigned
```

公共 artifact 必须完成 Apple signing、installer signing、notarization、stapling 和验证：

```bash
npm run release:macos
```

Unsigned/unnotarized build 不能称为正式 macOS 发布。

## 最终一致性

推送 tag 前确认：package version、Git tag、npm version、release notes 与 SBOM 一致；release gates 在目标 commit 通过；tarball 不包含数据库、备份、日志、secret、私有业务文件或 test-only dependency。
