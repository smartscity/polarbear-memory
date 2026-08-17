# Polarbear Memory 知识淘汰机制验证方案

> **适用产品**：Polarbear Memory
> **文档版本**：v1.0 Draft
> **文档日期**：2026-08-16
> **对应设计**：`TRD.md` 第 11 节“四层知识淘汰机制”
> **状态**：MVP-3 自动化验收已落地；真实 Agent 对照实验、4 周 dogfood 和扩展类型矩阵仍是外部验证门槛

### 当前自动化覆盖（2026-08-17）

| 验证范围 | 自动化入口 | 状态 |
| --- | --- | --- |
| stale、反馈不能洗白 stale、无关文件变化 | `src/application/retention-validation.test.ts` 7.1 | 已覆盖 |
| conflict preservation、supersession、一致性、幂等与无环 | `src/application/retention-validation.test.ts` 7.2 | 已覆盖 |
| TASK_STATE 单活跃、完成项退出、长期 DECISION/PITFALL 保护、精确去重 | `src/application/retention-validation.test.ts` 7.3 | 已覆盖 |
| dry-run/apply、reason/policy/assessor、archive restore、无自动 purge | `src/application/retention-validation.test.ts` 7.4 | 已覆盖 |
| 180 天增长、低频 PITFALL、污染与归档 precision proxy | `src/application/benchmark.test.ts` + `fixtures/retention-180d` | 已覆盖 |
| 10k incremental maintenance 与 context/search 性能 | `src/application/maintenance.test.ts` | 已覆盖 |
| Agent MCP 无物理 purge、恶意 Memory 为惰性数据 | `src/protocol-mcp/server.test.ts` + security fixture | 已覆盖 |

当前 MVP 类型只有 `DECISION / PITFALL / TASK_STATE / TODO`。本方案中的 `FACT / ARCHITECTURE / CONVENTION / FAILURE / WORKAROUND / PREFERENCE / CANDIDATE` 不应伪装成已有覆盖；需要先通过独立 schema/API 演进评审，再启用对应验收行。

## 1. 验证目标

本方案验证 Polarbear Memory 在长期使用后，是否同时满足以下目标：

1. 有用知识仍能在需要时被召回。
2. 已完成、被替代、过期或低价值知识不再持续污染 Context Pack。
3. 活跃知识集合不会随 session 数量无意义地线性增长。
4. stale 或冲突知识不会被当成当前确定事实。
5. 自动治理过程可解释、可回放、可恢复。
6. Agent 和自动维护任务都不能静默物理删除 canonical Memory。

验证的不是“删得越多越好”，而是：

> 在保持任务成功率和关键知识召回率的前提下，用尽可能小、尽可能可信的活跃集合支撑新 session。

## 2. 核心假设

### H1：活跃集合可以趋稳

在任务持续产生但完成率稳定的项目中，启用四层淘汰后，`ACTIVE + POTENTIALLY_STALE` 数量应主要随未完成工作和长期知识增长，而不是随 session 总数线性增长。

### H2：上下文污染可以显著下降

与“不淘汰”基线相比，已完成任务状态、旧 TODO、被替代决策和无价值候选进入 Context Pack 的比例应明显下降。

### H3：不会牺牲关键知识

低频但高代价的 `PITFALL/FAILURE`、长期有效的 `DECISION/ARCHITECTURE/CONVENTION` 不应仅因为时间或低使用频率被自动归档。

### H4：stale 判断与价值衰减相互独立

近期频繁使用不能洗白 stale Memory；长期未使用也不能把 verified Memory 判定为错误。

### H5：所有自动动作可逆且可解释

对于每次降权、警告或归档，系统都能给出 policy version、reason codes、输入信号和评估时间；归档恢复后正文、revision、evidence 和关系保持不变。

## 3. 验证范围

### 3.1 覆盖范围

- 第一层：Correctness / stale detection。
- 第二层：Supersession / conflict / dedup。
- 第三层：Utility / relevance decay。
- 第四层：Retention / archive / purge boundary。
- 按 Memory 类型的差异化策略。
- Context Compiler 的过滤、排序和 Warning 行为。
- 长期容量增长与维护任务性能。
- CLI、MCP 和 Desktop Admin Plane 的权限边界。

### 3.2 本轮不验证

- 团队共享 Memory 和服务端同步。
- 云 embedding 或云模型摘要。
- CodeGraph 对 symbol stale detection 的额外收益。
- SSD 上物理不可恢复的数据擦除保证。
- 用户跨设备迁移后的 retention policy 合并。

## 4. 成功指标

### 4.1 正确性指标

| 指标 | 定义 | Go 阈值 |
| --- | --- | ---: |
| HIGH stale recall | 应标为 HIGH 的样本中被警告或排除的比例 | 100% |
| stale false-negative rate | 已失效但仍进入确定事实区的比例 | 0%（阻断项） |
| verified false-stale rate | 来源未变化的 verified Memory 被错误标为 HIGH 的比例 | ≤ 2% |
| supersession consistency | 已确认 supersede 后只有新结论进入普通 Context 的比例 | 100% |
| conflict preservation | 证据不足的冲突没有被静默覆盖的比例 | 100% |

### 4.2 价值与召回指标

| 指标 | 定义 | Go 阈值 |
| --- | --- | ---: |
| critical memory recall@budget | 预算内召回标注为关键知识的任务比例 | ≥ 95% |
| low-frequency pitfall recall | 90–180 天未使用的关键 PITFALL 在相关任务中被召回的比例 | ≥ 95% |
| context pollution rate | Pack 中与当前任务无关、已完成或已被替代内容的 token 占比 | ≤ 5% |
| obsolete task-state inclusion | 已完成任务旧状态进入普通 Pack 的比例 | ≤ 1% |
| useful density | 被 oracle 标为有用的 Pack token 占比 | ≥ 80% |
| task success delta | 相对“不淘汰”组的任务成功率变化 | 不下降超过 2 个百分点 |

### 4.3 增长与存储指标

| 指标 | 定义 | Go 阈值 |
| --- | --- | ---: |
| active growth slope | 稳态阶段每 100 个已完成 session 新增活跃 Memory 数 | ≤ 10，且不持续加速 |
| task-state boundedness | 每个 task/scope 同时存在的活跃 TASK_STATE | ≤ 1 |
| duplicate active rate | 活跃集合中的语义重复比例 | ≤ 3% |
| candidate archive precision | 自动归档候选中确实不应进入普通 Context 的比例 | ≥ 95% |
| raw-event retention compliance | 超过 retention 的 Raw Event 被清理比例 | 100% |
| canonical auto-purge count | 自动维护或 Agent 物理删除的 canonical Memory 数 | 0（阻断项） |

### 4.4 可逆性与性能指标

| 指标 | 定义 | Go 阈值 |
| --- | --- | ---: |
| archive restore fidelity | archive → restore 后正文、证据、revision、关系一致率 | 100% |
| lifecycle explanation coverage | 自动状态变化带完整 reason/audit 的比例 | 100% |
| maintenance idempotency | 同一输入重复执行不产生额外状态变化 | 100% |
| incremental maintenance p95 | 10k Memory 下日常增量维护耗时 | < 200 ms |
| context latency impact p95 | 启用 lifecycle 后增加的 `memory_context` 延迟 | < 50 ms |

## 5. 对照实验设计

采用三个可重复运行的 treatment：

| 组别 | 策略 | 目的 |
| --- | --- | --- |
| A：No Retirement | 仅写入和 FTS，不 stale、不 supersede、不衰减 | 观察无限累积基线 |
| B：Naive TTL | 所有 Memory 使用统一 30 天 TTL | 证明简单按时间删除会损失长期知识 |
| C：Four-Layer | TRD 四层机制和类型化 policy | 候选产品方案 |

所有组使用相同事件序列、任务查询、token budget、随机种子和编译器版本。不得给 C 组额外输入或更大 Context Pack。

B 组的统一 TTL 仅用于模拟其检索可见性和指标后果，不在生产数据上执行不可逆删除；三个 treatment 都运行在隔离的 fixture 数据库中。

预期结果：

- A 的 recall 可能较高，但污染率和 active growth 持续上升。
- B 的规模较小，但长期决策与低频 PITFALL 召回明显下降。
- C 应同时维持关键召回、压低污染并使活跃集合趋稳。

如果 C 只比 A 更小，却不能保持任务成功率与关键召回，则验证失败。

## 6. 测试数据集

### 6.1 合成长期项目 `retention-180d`

用可控时钟模拟 180 天、360 个 session、60 个 task。事件至少包含：

- 60 条 `DECISION`，其中 12 条后来被 supersede。
- 40 条 `ARCHITECTURE/CONVENTION`，其中 8 条来源发生变化。
- 80 条 `PITFALL/FAILURE`，其中 20 条是低频高代价知识。
- 360 次 `TASK_STATE` 更新，每个 task 多次推进。
- 180 条 `TODO`，包含完成、取消、长期未完成和 reopen。
- 30 条 `WORKAROUND`，在 14–60 天内分别失效或转正。
- 100 条低置信 `CANDIDATE`，其中少量后来获得 evidence。
- 重复、近似重复、冲突和跨 branch scope 样本。

每条样本必须带 oracle label：

```text
memory_id
valid_from / valid_to
expected_lifecycle
expected_verification
relevant_tasks[]
must_recall_for[]
must_not_assert_for[]
expected_reason_codes[]
criticality = LOW | MEDIUM | HIGH
```

### 6.2 Git 变化数据集 `stale-git-history`

建立真实 Git fixture，通过 commit 序列覆盖：

- 无关文件修改。
- anchor 文件修改但 digest 仍匹配。
- symbol 内容改变。
- 文件重命名和删除。
- branch merge、branch delete、task reopen。
- 旧决策被新实现明确替代。
- 高频使用但已经失效的知识。

### 6.3 恶意与边界数据集 `retention-adversarial`

- Agent 反复写入相同 TASK_STATE，尝试撑大数据库。
- 恶意 Memory 声称自己永不过期、禁止 archive 或要求执行 purge。
- 伪造高 importance 和 positive feedback。
- 系统时钟前跳、后退和夏令时变化。
- lifecycle job 在事务中途被终止并重放。
- 10k Memory 同时到达 `review_after`。
- 用户刚恢复的 Memory 被同一规则立即再次归档。

### 6.4 真实 Dogfood 数据

选择 2–3 个本地项目运行至少 4 周。只记录结构化指标和用户人工标签，不上传 Memory 内容。每周随机抽取：

- 20 个被选入 Pack 的 Memory。
- 20 个被排除或降权的 Memory。
- 全部自动归档 Memory。
- 全部 stale HIGH 和 supersede 事件。

由用户判断 useful / irrelevant / wrong / should-restore，作为 synthetic fixture 之外的真实性校验。

## 7. 四层机制逐层验证

### 7.1 第一层：正确性淘汰

步骤：

1. 在 commit A 记录带 file anchor 的 FACT、DECISION 和 PITFALL。
2. 分别执行无关修改、相关但语义不变修改、语义变化、symbol 删除。
3. 每次运行 incremental stale scan。
4. 检查 risk、reason codes、checked commit 和 Context Pack section。

必须证明：

- 无关修改不会造成大面积 HIGH stale。
- 语义已变样本不会进入确定事实区。
- 最近命中过多少次都不能抵消 HIGH stale。
- `verify` 后再次发生相关变化，Memory 可以重新变 stale。

### 7.2 第二层：替代淘汰

步骤：

1. 建立旧 DECISION A。
2. 建立冲突但尚未确认的新候选 B，验证系统只创建 `CONTRADICTS`。
3. 用户或可靠 evidence 确认 B 后建立 `B SUPERSEDES A`。
4. 查询当前决策与历史原因。

必须证明：

- 当前查询只把 B 当作当前结论。
- “为什么以前使用 A”仍能展开 A 的来源与历史。
- 重复执行 supersede 幂等，不形成环。
- TASK_STATE 连续更新后每个 task/scope 只有一个 active state。

### 7.3 第三层：价值衰减

步骤：

1. 准备近期常用、长期未用、任务已完成、scope 消失和低频高代价五类 Memory。
2. 用可控时钟推进 7、14、30、90、180 天。
3. 在相关和无关任务下分别生成 Context Pack。
4. 比较 reason codes、relevance score、选择结果和 token 占比。

必须证明：

- 相关性随任务和 scope 改变，而不是只按年龄下降。
- 长期未使用的关键 DECISION/PITFALL 在相关任务中仍能恢复排名。
- selected count 不会形成无限自增强。
- completed TASK_STATE 和 TODO 不污染后续无关任务。
- correctness risk 与 relevance score 可以独立变化。

### 7.4 第四层：存储保留

步骤：

1. 生成到期 Raw Event、expired diagnostic、低价值 CANDIDATE 和 canonical Memory。
2. 运行 `maintain --dry-run`，保存计划。
3. 运行正式维护并再次执行相同命令。
4. 对自动归档项执行 restore。
5. 从 Agent MCP、自动维护和 Human Admin 三条路径分别尝试 purge。

必须证明：

- dry-run 与正式执行的计划一致。
- Raw Event 和可重建数据按 policy 清理。
- canonical Memory 只被归档，不被自动 purge。
- Agent purge 被 policy 拒绝。
- Human purge 要求明确确认并留下 audit。
- archive → restore 数据完全一致，第二次维护不会立即反复归档。

## 8. 按类型验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| TASK_STATE 更新 20 次 | 一个 active，历史 revision/superseded 可查 |
| task 完成 7 天 | TASK_STATE 自动归档，不进入默认 Pack |
| TODO 完成或取消 | 立即退出默认 Pack，7 天后归档 |
| TODO 长期未完成 | 不能静默标记完成或删除 |
| WORKAROUND 超过 14 天 | 进入 review；相关来源变化则 stale |
| FACT 无 anchor 且 90 天未验证 | 请求复核，不直接判错或 purge |
| DECISION 180 天未使用 | 仍可 verified；相关任务下可以召回 |
| ARCHITECTURE 来源变化 | stale warning，不因 importance 绕过 |
| PITFALL 180 天未命中 | 相关高风险任务中仍能召回 |
| PREFERENCE 仅出现一次相反 Agent 行为 | 不自动 supersede 用户偏好 |
| CANDIDATE 30 天无 evidence/使用 | 自动归档且可恢复 |
| 任意 canonical Memory | 自动维护不能物理 purge |

## 9. 长期增长实验

### 9.1 运行方式

对 A/B/C 三组分别重放 `retention-180d`。每个模拟日结束记录：

```text
total_memories
active_memories
stale_memories
archived_memories
superseded_memories
candidate_memories
raw_event_count
db_bytes
active_by_type
context_useful_tokens
context_pollution_tokens
maintenance_duration_ms
```

### 9.2 增长曲线判定

将 180 天分为 warm-up（1–30）、growth（31–90）和 steady（91–180）三段。重点比较 steady 阶段：

- session 数持续增加时，completed-task Memory 是否继续堆积在 active 集合。
- active growth slope 是否趋稳。
- archived 增加是否有 ≥95% 的正确归档率。
- DB bytes 增长来自 canonical 历史还是无意义 raw/duplicate 数据。

不能只看数据库文件总大小。保留 revision 和 evidence 会让文件增长，但只要活跃集合、Context Pack 污染和维护延迟受控，就不等同于产品失败。数据库达到软上限时必须产生人工可审阅的清理建议。

## 10. 端到端任务验证

为每组运行相同的 resume 任务：

1. 继续一个昨天未完成的 task。
2. 查询一个 120 天前的架构决策。
3. 重现一个 150 天前出现过的罕见故障。
4. 在实现变化后询问旧 FACT。
5. 询问已被新决策替代的历史原因。
6. 开始与过去任务无关的新工作。

记录：

- task success。
- time to first correct edit。
- file reads / searches / tool calls。
- total tokens 和 Context Pack tokens。
- useful、irrelevant、wrong、stale token 数。
- 是否因误归档重新探索。
- 是否因旧知识污染做出错误行动。

## 11. 可运行接口约定

### 11.1 当前可运行入口

```bash
# 完整自动化回归（包含四层机制、fixture、MCP 和本地 Admin API）
npm test

# 只运行验证方案 7.1–7.4
npm run build
node --test --test-concurrency=1 dist/application/retention-validation.test.js

# 运行 GA fixture 汇总门槛
npm run benchmark:ga
```

测试使用 application 层的显式 `now` 注入可控时钟；生产 CLI 不开放伪造时间。

### 11.2 后续 benchmark/report 契约

以下多 treatment 报告接口尚未实现，保留为真实对照实验和报告流水线契约：

```bash
# 运行四层机制测试集
polarbear-memory benchmark fixtures/retention-180d \
  --treatments no-retirement,naive-ttl,four-layer \
  --seed 42

# 生成机器可读和人类可读报告
polarbear-memory benchmark report \
  --format json \
  --format markdown
```

生产 CLI 不应允许普通用户伪造时间；未来如增加 `--now`，只能在 test build 或显式 fixture mode 可用。

## 12. 报告格式

每次验证生成：

```text
artifacts/retention/<run-id>/
├── manifest.json
├── policy.json
├── environment.json
├── metrics.json
├── report.md
├── growth.csv
├── failures.jsonl
└── lifecycle-audit.jsonl
```

`manifest.json` 至少记录：

- Git commit。
- schema、policy、compiler 和 fixture version。
- treatment、seed 和模拟时钟范围。
- bundled Node 与 SQLite 版本。
- Context budget。
- OS/CPU metadata。

报告必须同时展示收益和失败样本，不能只报告平均值。所有阻断指标必须列出具体 Memory ID、任务和 reason codes，便于复现。

## 13. Go / Iterate / Stop 规则

### Go

同时满足：

- 所有阻断项为零。
- 第 4 节所有 Go 阈值达标。
- C 组关键召回和任务成功率不劣于 A 组允许范围。
- C 组污染率和 active growth 显著优于 A。
- C 组长期知识召回显著优于 B。
- 4 周 dogfood 未出现关键知识静默丢失。

### Iterate

出现以下任一情况：

- 自动归档 precision 为 90%–95%。
- stale false positive 偏高，但没有错误确定性输出。
- 活跃集合下降但尚未趋稳。
- 性能未达标但结果正确。
- synthetic 达标、dogfood 有可修正的 policy 偏差。

此时只调整 policy、reason 和阈值，并用相同 fixture 回归；不能通过降低关键召回指标来换取更小数据库。

### Stop

出现以下任一情况时不得进入 v0.1 GA：

- stale 错误知识进入确定事实区。
- 自动 purge canonical Memory。
- 关键 `DECISION/ARCHITECTURE/PITFALL` 因年龄或低频被自动归档。
- archive 无法完整恢复。
- 相比 A 组任务成功率下降超过 2 个百分点。
- 多轮调参后 active growth 仍与 session 数近似线性。

## 14. MVP-3 Definition of Done

- [ ] 三组对照实验可由单条命令重复运行。
- [ ] fixture 使用可控时钟，不依赖真实等待 180 天。
- [ ] oracle labels 经人工 review 并进入版本控制。
- [ ] correctness 与 relevance 独立计算、独立展示。
- [ ] 所有 lifecycle action 有 versioned reason codes。
- [ ] `maintain --dry-run` 与正式执行结果一致。
- [ ] TASK_STATE 单活跃与各类型 policy 全部通过。
- [ ] HIGH stale recall 100%，false negative 为 0。
- [ ] critical memory recall ≥95%，context pollution ≤5%。
- [ ] 自动归档 precision ≥95%，关键长期知识误归档为 0。
- [ ] archive restore fidelity 100%。
- [ ] canonical auto-purge count 为 0。
- [ ] 10k Memory 下增量维护和 Context 延迟满足 SLO。
- [ ] 4 周 dogfood 完成并记录 Go / Iterate / Stop 结论。

只有以上项目完成，才能声称 Polarbear Memory 已经证明“长期记忆不会退化成长期噪音”。
