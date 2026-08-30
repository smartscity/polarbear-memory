import { parseArgs } from "node:util";
import { installCodexIntegration } from "../adapters/codex/integration.js";
import { discoverGitContext } from "../platform/git.js";
import { resolveAgentRuntime } from "../platform/agent-launch.js";
import { loadProject } from "../platform/project.js";

export function runCodexCommand(cwd: string, args: string[]): void {
  const [action, ...rest] = args;
  if (action !== "install") throw new Error("codex requires `install [--dry-run]`.");
  const parsed = parseArgs({
    args: rest,
    options: { "dry-run": { type: "boolean", default: false } },
    strict: true,
  });
  const project = loadProject(discoverGitContext(cwd));
  const result = installCodexIntegration(project, {
    dryRun: parsed.values["dry-run"],
    runtime: resolveAgentRuntime(),
  });
  console.log(`MCP config: ${result.plan.configPath}`);
  if (result.plan.alreadyInstalled) console.log("Codex integration is already installed.");
  else if (parsed.values["dry-run"]) console.log("Dry run only; no files were changed.");
  else {
    if (result.plan.legacyConfiguration) console.log("Legacy Codex MCP configuration detected and updated.");
    console.log(`Backup:     ${result.backupDir}`);
    console.log("Codex integration installed. Restart active Codex clients.");
  }
}
