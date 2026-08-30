# 代码仓库与实现映射

[English](../../en/implementation/repository-map.md)

## 目录职责

| 路径 | 职责 |
|---|---|
| `src/domain/` | 与 provider/storage 无关的领域类型与不变量 |
| `src/application/` | Use case、context planning、finalization、maintenance、benchmark 和 port |
| `src/storage/` | SQLite repository、schema、migration、index 和兼容 facade |
| `src/runtime/` | AgentRuntime、router、session manager 和 rotation policy |
| `src/adapters/` | Claude Code / Codex 专属集成 |
| `src/protocol-mcp/` | Agent-facing MCP adapter |
| `src/protocol-local/` | 本地 Admin API transport/router |
| `src/cli/`、`src/cli.ts` | 人类 CLI adapter |
| `src/platform/` | Git、Project identity、file anchor 和确定性 Agent process launch |
| `src/security/` | 脱敏和信任边界 |
| `api/` | Admin API 合同与 DTO 源 |
| `fixtures/` | benchmark 与安全 fixture |
| `scripts/` | 构建、审计、打包、SBOM 和发布门禁 |

## 核心所有权规则

- `SqliteMemoryStore` 只是兼容 facade，不能继续塞入业务算法。
- Repository 只负责一种聚合或持久化能力。
- Application service 负责 use case，并依赖 port。
- Protocol adapter 不暴露数据库 row。
- Provider 差异只放在 `src/adapters/<provider>/`。
- 写事务边界统一使用 `inImmediateTransaction`。
- Memory row mapping 统一位于 `memory-read-model.ts`。
- FTS 只由 `KnowledgeSearchIndex` 管理，并且可重建。

## 修改路由

| 修改 | 主要源码 | 只需同步的文档 |
|---|---|---|
| Memory 类型/不变量 | `src/domain/memory.ts` | `architecture/memory-engine.md` |
| Schema/migration | `src/storage/schema-v2.ts` | `architecture/memory-engine.md` |
| Context selection | `src/application/context-planner.ts` | `architecture/context-os.md` |
| Rotation/runtime | `src/runtime/`、`src/adapters/` | `architecture/context-os.md` |
| 生成的 Agent launch | `src/platform/agent-launch.ts`、`src/adapters/` | `architecture/overview.md`、`protocols/mcp.md` |
| MCP tool | `src/protocol-mcp/` | `protocols/mcp.md` |
| Admin method/DTO | `api/`、`src/protocol-local/` | `protocols/admin-api.md` |
| CLI 行为 | `src/cli.ts`、`src/cli/` | 对应 guide |
| Release gate | `package.json`、`scripts/` | `development/releasing.md` |

这个映射替代“改一次架构就同时修改大 TRD、UML 补充、README 和用户手册”的旧规则。
