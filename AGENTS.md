# Polarbear Memory Engineering Guidelines

本文件是人类开发者与编码 Agent 的共同约束。修改代码前必须阅读；规范与代码冲突时，先修正代码或在 TRD 补充设计中记录经评审的例外，不能静默绕过。

## 1. 核心原则

1. 单一职责：一个类只对应一个主要变化原因。Facade 负责转发和用例编排，Service 负责一个业务能力，Repository 负责一种聚合的持久化，Mapper 只负责模型转换。
2. 依赖倒置：`protocol-* -> application -> domain`；`storage` 实现 application port。Domain 不依赖 SQLite、HTTP、MCP 或 CLI。
3. 组合优于继承：默认通过构造器组合 Service、Repository、Strategy；禁止为了复用 SQL 或工具函数建立业务继承树。
4. 模式解决变化，不追求模式数量。使用模式时必须能回答“隔离了哪个变化轴”。
5. 本地优先与可恢复：canonical 数据只存在本地数据库；派生索引可删除重建；迁移必须先备份、失败必须恢复。

## 2. 分层和设计模式

参考 Spring 的职责划分，但不引入容器式复杂度：

- Controller / Adapter：`protocol-local`、`protocol-mcp`、CLI。只解析输入、调用 application service、格式化输出。Agent 专属配置和 lifecycle hook 位于 `adapters/<agent>`；通用 MCP 不得复制到 Agent adapter。
- Application Service：实现 context、finalization、maintenance 等用例，不含 SQLite SQL。
- Facade：`SqliteMemoryStore` 是 `MemoryStore` 的兼容 Facade，只负责维持 port 和委托协作者；禁止把新的检索算法、映射器或迁移逻辑写回 Facade。
- Repository：封装 canonical 表的读写与存在性检查；不输出协议 DTO。
- Query Service / Strategy：封装可替换的检索与排序策略。当前混合检索位于 `KnowledgeQueryService`。
- Mapper：数据库 row 到领域聚合的转换只放在 `memory-read-model.ts`，并使用批量查询避免 N+1。
- Unit of Work：所有运行时写事务必须通过 `inImmediateTransaction`；被调用 Repository 不得自行开启嵌套事务。
- Audit Repository：生命周期审计统一通过 `recordLifecycleAssessment`。
- Derived Index：FTS 只由 `KnowledgeSearchIndex` 管理；canonical 写入不能依赖索引成功读取才能恢复。
- Migration Object：旧模式兼容只放在 `LegacyV1SchemaManager` / `migrate-v2.ts`，正常运行路径禁止访问 `legacy_*` 表。

## 3. 规模约束

- 新建生产类建议不超过 250 行，400 行为硬上限；超过时必须先按职责拆分。
- 新建函数建议不超过 40 行；超过 80 行必须拆出有业务名称的步骤。
- 一个类的公开方法应属于同一个能力域。超过 12 个公开方法时，优先拆 Facade + 多个 Service。
- `SqliteMemoryStore` 是兼容 Facade：不得超过 400 行，不得新增业务变化轴；业务 SQL 应位于对应 Service/Repository。职责映射见 `docs/en/implementation/repository-map.md`。
- Schema SQL 可按完整迁移单元保留在单文件，不以普通类行数衡量，但必须有版本、校验和与迁移测试。

## 4. 重复代码规则

- 同一结构出现第 2 次时检查是否同一业务概念；第 3 次必须提取，除非能证明只是偶然相似。
- 不允许重复 `BEGIN / COMMIT / ROLLBACK`、生命周期审计 INSERT、FTS 文档刷新或聚合 row mapping。
- Schema migration 可保留一次性、set-based 的事务与审计 `INSERT ... SELECT`，但必须位于 migration 模块并有恢复测试；运行时仍只能使用统一 Unit of Work 和 Audit Writer。
- 不能仅为减少行数抽取无业务含义的 `util`。优先命名为 Repository、Policy、Mapper、Factory、Strategy 或明确领域动作。
- 相同校验规则只保留一个实现；协议层可做格式校验，领域层仍必须维护业务不变量。

## 5. SQLite 与数据规则

- SQL 参数必须绑定；只有经过枚举约束的表名/列名和根据已限长数组生成的 `?` 占位符可动态拼接。
- public 写操作拥有事务边界；内部 helper 不开启事务。
- canonical 表：workspace、project、session、episode、evidence、knowledge、entity、relation、anchor、lifecycle assessment。
- derived 表：search document、FTS、可重算统计。派生表必须提供 rebuild 路径。
- JSON 读取必须来自本项目写入且受 schema 约束；外部 `unknown` 输入必须先验证。
- ID 使用 UUID；摘要使用 SHA-256；时间使用 UTC ISO-8601 字符串。
- 数据库升级禁止原地冒险修改：先生成迁移备份，失败恢复，并运行 foreign-key check。

## 6. API、兼容性与安全

- CLI、MCP 工具名及 Admin API 是发布契约。破坏性变化必须走主版本升级并同步 README、用户手册和 TRD。
- Desktop 不直接读写 `memory.db`，只通过 Memory Engine API 管理完整能力。
- 禁止默认联网。测试必须覆盖 deny-network；PlantUML、字体、图标、遥测和渲染不得访问远端。
- 不记录原始 prompt、secret、token、cookie 或完整环境变量；外部事件先脱敏再持久化。
- MCP stdio 的 stdout 只允许协议帧；日志和 Node warning 必须隔离到 stderr 或被明确处理。
- 外部依赖必须检查许可证；默认接受 Apache-2.0、MIT、BSD、ISC，新增 copyleft/SSPL/非商业许可证需人工评审。

## 7. 测试与交付门禁

每次生产代码修改至少执行：

```bash
npm run typecheck
npm test
```

发布前还必须执行：

```bash
npm run check
npm run benchmark:ga
npm run package:check
```

- 事务 helper 必须有成功提交和异常回滚测试。
- Repository 必须覆盖项目隔离、重复写入、外键失败与 migration 路径。
- 检索策略必须覆盖 lexical、entity、relation、temporal 和 deterministic ordering。
- 修复 bug 时先增加能复现问题的回归测试。
- 不得通过延长超时掩盖死锁、句柄泄漏或不确定性。

## 8. Documentation and workspace discipline

- All newly written or substantially revised engineering documentation, architecture text, code comments, TSDoc/JSDoc, test descriptions, commit messages, and public contract descriptions must be written in English. Maintained localized documents under `docs/zh-CN/` are the exception.
- Follow `docs/README.md`: update the single English document that owns the changed behavior, plus its Chinese counterpart when the behavior is user-visible. Do not update unrelated overviews or indexes.
- Canonical protocol/schema details remain in code and versioned contracts. Narrative documents explain intent, boundaries, and workflows rather than copying complete schemas.
- Mermaid diagrams must render locally from repository text or in a Mermaid-capable client. Remote rendering services are prohibited.
- Preserve existing user changes. Do not reset, checkout, or overwrite unrelated files.
- Do not publish build output, real databases, backups, logs, secrets, or private `.business` material.
- Before commit, inspect `git diff`, `npm pack --dry-run`, and the publication allowlist.

## 9. Code Review 检查表

- 新代码是否只有一个主要变化原因？
- 是否把协议、用例、领域和存储职责混在同一个类？
- 是否出现第 3 份相同事务、SQL、映射或校验？
- 是否绕过 Engine API 直接操作数据库？
- canonical / derived 边界是否清楚且索引可重建？
- 项目隔离、事务原子性、离线安全和许可证是否有测试或证据？
- UML、TRD、README、用户手册是否与实际行为一致？
