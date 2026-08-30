# 参与贡献

[English](../../en/development/contributing.md)

## 修改代码前

依次阅读：

1. [`AGENTS.md`](../../../AGENTS.md)
2. [总体架构](../architecture/overview.md)
3. [实现映射](../implementation/repository-map.md)
4. 本次修改所属的唯一子系统文档。

不要再把旧的单体 PRD/TRD 当作当前实现事实源。

## 开发环境

```bash
npm install
npm run typecheck
npm test
```

Node 范围和依赖版本以 `package.json` / `package-lock.json` 为准。

## 设计规则

- 保留无关用户修改。
- 遵守 `protocol-* -> application -> domain`。
- Desktop 必须通过 Admin API。
- Provider 差异只能位于 adapter。
- Canonical 数据本地保存，derived index 可重建。
- 写操作统一使用 immediate transaction helper。
- 外部 `unknown` 输入必须校验并限长。
- Bug fix 同时增加回归测试。
- 不增加隐式联网、遥测或远程渲染。

## 文档规则

行为变化时：

1. 先修改 canonical code/contract；
2. 只修改一个 owning English document；
3. 用户可见变化同步对应中文翻译；
4. 导航没变化就不要改 index；
5. 不在叙述文档复制完整 CLI、API schema、DDL 或测试矩阵。

## 门禁

生产代码至少运行：

```bash
npm run typecheck
npm test
```

发布前运行：

```bash
npm run release:gates
```

具体 gate graph 以 `package.json` 为准。
