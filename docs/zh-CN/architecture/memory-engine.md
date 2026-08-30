# Memory Engine

[English](../../en/architecture/memory-engine.md)

## 目的

Memory Engine 在任何单一 Agent session 之外保存可复用工程知识。它实现已批准的 Option B：Evidence 与 Episode 支撑带版本的 Knowledge、Entity、Relation 和有界检索。

## Canonical 模型

```text
Project
 ├─ Session → Episode → Evidence
 ├─ Knowledge → Knowledge Version
 │              ├─ Evidence
 │              ├─ Entity
 │              ├─ Relation
 │              ├─ Anchor
 │              └─ Lifecycle Assessment
```

完整 SQL 和迁移 checksum 只由 `src/storage/schema-v2.ts` 维护，叙述文档不复制整份 DDL。

## Memory 对外抽象

对外 Memory 聚合包含：类型、正文、来源、证据、置信度、重要性、相关性、正确性风险、生命周期、验证状态、文件锚点、实体、关系、版本历史与使用元数据。

当前类型定义以 `src/domain/memory.ts` 为准。

## Runtime launch descriptor

`polarbear-memory install` 会确保 `<Polarbear data root>/runtime/launch.json` 存在带 schema version 的 descriptor，其中记录执行安装器的绝对 `process.execPath` 与包内 `dist/cli.js` 路径。Descriptor 修复不依赖项目初始化或 Agent 配置是否发生变化：缺失时创建，过期时替换，当前版本则保持文件不变。

Canonical path、schema version 和 runtime fields 由 `api/runtime-launch-v1.json` 定义；Desktop 使用该 contract 的 vendored copy。Desktop 会校验两个路径，并以结构化参数启动 Engine：`runtime executable`、`CLI entrypoint`、`service`、`run`；不会解析 Codex 配置，也不会启动 shell。显式 Desktop override 仍然优先，便于恢复。

## 写入与检索

```text
已校验输入
  → 事务写入 Knowledge + Version + Evidence
  → 建立 Entity / Relation / Anchor
  → 刷新 derived search document

查询
  → lexical + entity + relation + temporal 候选
  → lifecycle / correctness 过滤
  → 确定性排序
  → hydrate Memory 聚合
```

## 生命周期与保留

知识退出活跃上下文采用四层机制：

1. **正确性**：争议或来源失效的知识提高风险并显示警告。
2. **替代**：新结论通过显式 relation 替代旧结论，历史证据仍保留。
3. **价值**：达到保留期的已完成短期任务状态可以退出 active set。
4. **存储保留**：长期 canonical 知识不会仅因时间久或使用少被静默清除。

自动 lifecycle 动作必须有界、可解释、有审计并且可逆；只有用户明确 purge 才物理删除。

原《知识淘汰机制验证方案》不再作为活动规格维护。已验收行为归本文所有，可执行证据归以下测试和 fixture 所有：

- `src/application/retention-validation.test.ts`；
- `src/application/maintenance.test.ts`；
- `fixtures/retention-180d/fixture.json`；
- `npm run benchmark:ga`。

## 迁移与恢复

- 文件数据库迁移前创建 preflight backup。
- Additive migration 在事务内执行并检查 foreign key。
- 失败时恢复备份，并保留失败候选供诊断。
- 新版本 Engine 创建的数据库不会被旧 Engine 写入。
- Derived index 可以从 canonical state 重建。
