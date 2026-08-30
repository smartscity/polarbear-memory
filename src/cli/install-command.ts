import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { installClaudeIntegration, planClaudeIntegration } from "../adapters/claude-code/integration.js";
import { installCodexIntegration, planCodexIntegration } from "../adapters/codex/integration.js";
import { discoverGitContext } from "../platform/git.js";
import { planProject, writeProjectConfig } from "../platform/project.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { resolveAgentRuntime } from "../platform/agent-launch.js";
import { ensureRuntimeLaunchDescriptor, planRuntimeLaunchDescriptor } from "../platform/runtime-descriptor.js";

function status(alreadyInstalled: boolean, dryRun: boolean): string {
  if (alreadyInstalled) return "ALREADY INSTALLED";
  return dryRun ? "WOULD INSTALL" : "INSTALLED";
}

export function runInstallCommand(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { "dry-run": { type: "boolean", default: false }, command: { type: "string" } },
    strict: true,
  });
  const project = planProject(discoverGitContext(cwd));
  const projectInitialized = existsSync(project.configPath);
  const runtime = resolveAgentRuntime();
  if (parsed.values.command) {
    console.error("Warning: --command is deprecated and ignored; Agent launch paths are derived from the active runtime.");
  }

  const runtimeDescriptor = parsed.values["dry-run"]
    ? planRuntimeLaunchDescriptor(runtime)
    : ensureRuntimeLaunchDescriptor(runtime);

  const claudePlan = planClaudeIntegration(project, runtime);
  const codexPlan = planCodexIntegration(project, runtime);
  if (codexPlan.conflict) {
    throw new Error("Codex already has an unmanaged `polarbear-memory` MCP server. Remove or rename it before installing.");
  }

  if (!parsed.values["dry-run"] && !projectInitialized) {
    writeProjectConfig(project);
    const store = new SqliteMemoryStore(project.databasePath);
    try {
      store.initializeProject(project);
    } finally {
      store.close();
    }
  }

  installClaudeIntegration(project, { dryRun: parsed.values["dry-run"], runtime });
  installCodexIntegration(project, { dryRun: parsed.values["dry-run"], runtime });

  console.log(`Project      ${projectInitialized ? "ALREADY INITIALIZED" : parsed.values["dry-run"] ? "WOULD INITIALIZE" : "INITIALIZED"}`);
  const descriptorAction = parsed.values["dry-run"] && runtimeDescriptor.action !== "CURRENT"
    ? `WOULD ${runtimeDescriptor.action}`
    : runtimeDescriptor.action;
  console.log(`Runtime descriptor ${descriptorAction} (${runtimeDescriptor.path})`);
  console.log("Agent integrations");
  console.log(`Claude Code  ${status(claudePlan.alreadyInstalled, parsed.values["dry-run"])}`);
  console.log(`Codex        ${status(codexPlan.alreadyInstalled, parsed.values["dry-run"])}`);
  if (claudePlan.legacyConfiguration || codexPlan.migrationRequired) {
    console.log(parsed.values["dry-run"]
      ? "Legacy Agent configuration detected; runtime launch commands would be updated."
      : "Legacy Agent configuration detected; runtime launch commands were updated.");
  }
  if (parsed.values["dry-run"]) {
    console.log("\nDry run only; no files were changed.");
  } else if (claudePlan.alreadyInstalled && codexPlan.alreadyInstalled) {
    console.log("\nAll supported Agent integrations are already installed.");
  } else {
    if (claudePlan.backupRequired || codexPlan.backupRequired) console.log("\nExisting configuration was backed up before managed changes.");
    console.log("Restart active Agent clients to load Polarbear Memory.");
  }
}
