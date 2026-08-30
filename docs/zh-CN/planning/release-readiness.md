# 发布就绪状态

[English](../../en/planning/release-readiness.md)

工程竣工与公开发布认证是两个不同决策。

## 自动化证据

完整发布门禁是：

```bash
npm run release:gates
```

格式、类型、合同漂移、测试、许可证、依赖、bundle、SBOM、benchmark、安全公告和 npm 包安装冒烟的具体命令图，以 `package.json` 为唯一事实源，不在本文重复维护。

## 外部证据

以下事项无法只靠仓库测试证明：

- 固定真实 provider/model 的 token 与 usage 测量；
- 持续 dogfood 期间没有 P0/P1 数据或安全缺陷；
- 发布时针对受支持 Codex/Claude CLI 的实机冒烟；
- macOS 公共安装包的 Apple 签名和公证；
- 发布账号、证书和 registry 权限可用。

## 判定规则

- 自动门禁失败：不可发布。
- 自动门禁通过但外部证据未完成：只能称 release candidate。
- 自动门禁与适用外部证据全部完成：可以进入计划中的公开发布。

版本号以 `package.json` 为准。发布前 Git tag、npm 版本、release notes 与 SBOM 必须一致。
