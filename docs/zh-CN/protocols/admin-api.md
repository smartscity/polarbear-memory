# 本地 Admin API

[English](../../en/protocols/admin-api.md)

## 角色

Admin API 是 Polarbear Desktop 与本地管理客户端的完整控制面边界。Desktop 永远不能直接打开 `memory.db`。

权威合同是 [`api/admin-v1.json`](../../../api/admin-v1.json)，权威 TypeScript DTO 是 [`api/admin-v1.types.ts`](../../../api/admin-v1.types.ts)。本文只解释架构与兼容规则，不重复每个方法字段。

## Transport

- 当前用户范围的 Unix-domain socket；
- 不监听 TCP；
- service directory 权限 `0700`；
- socket/token 文件权限 `0600`；
- 有界 UTF-8 JSON-line frame；
- token 使用 constant-time 比较；
- 响应不暴露数据库路径和本地 secret。

## 能力族

合同覆盖 system negotiation、project 状态/诊断/配置、Memory 全生命周期、Context 构建/解释、Task/Checkpoint/Run、Agent activity、Observation distillation、Usage、Maintenance、Backup/Restore 和 Knowledge promotion。

精确 capability 列表请直接读取 `api/admin-v1.json`。

## 版本规则

- `system.hello` 返回 API/Engine 版本、transport 和 capability。
- Client 按 capability negotiation，不能假设所有方法存在。
- Breaking change 必须升级 API major。
- Additive minor change 必须同步 JSON/types、router、测试和 Desktop 生成合同。
- `npm run admin-contract:check` 阻止 drift。

Protocol router 只负责解析、授权、调用 application service 和格式化 DTO；事务、迁移、验证与 lifecycle 仍属于 Engine。
