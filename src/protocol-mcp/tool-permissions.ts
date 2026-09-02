export const DEFAULT_MCP_TOOL_NAMES = [
  "constraint_record",
  "context_explain",
  "context_get",
  "decision_record",
  "memory_context",
  "memory_feedback",
  "memory_get",
  "memory_record",
  "memory_search",
  "memory_verify",
  "task_checkpoint",
  "task_create",
  "task_get",
] as const;

export const CLAUDE_DEFAULT_MCP_PERMISSION_RULES = DEFAULT_MCP_TOOL_NAMES
  .map((name) => `mcp__polarbear-memory__${name}`);
