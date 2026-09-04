import { parseArgs } from "node:util";
import { installCodexIntegration } from "../adapters/codex/integration.js";
import { installCodexAppServerIntegration } from "../adapters/codex/app-server-integration.js";
import { discoverGitContext } from "../platform/git.js";
import { resolveAgentRuntime } from "../platform/agent-launch.js";
import { loadProject } from "../platform/project.js";

export async function runCodexCommand(cwd: string, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "app-server") {
    const [serverAction, ...serverArgs] = rest;
    if (serverAction === "install") {
      const parsed = parseArgs({
        args: serverArgs,
        options: { "codex-command": { type: "string" }, "dry-run": { type: "boolean", default: false } },
        strict: true,
      });
      if (!parsed.values["codex-command"]) throw new Error("codex app-server install requires an absolute --codex-command path.");
      const project = loadProject(discoverGitContext(cwd));
      const result = installCodexAppServerIntegration(project, {
        codexCommand: parsed.values["codex-command"],
        dryRun: parsed.values["dry-run"],
        runtime: resolveAgentRuntime(),
      });
      console.log(`App Server descriptor: ${result.plan.descriptorPath}`);
      if (result.plan.alreadyInstalled) console.log("Managed Codex App Server integration is already installed.");
      else if (parsed.values["dry-run"]) console.log("Dry run only; no files were changed.");
      else {
        console.log(`Backup:               ${result.backupDir}`);
        console.log("Managed Codex App Server gateway installed for explicit client embedding.");
      }
      return;
    }
    if (serverAction !== "run") throw new Error("codex app-server requires `install` or `run`.");
    const parsed = parseArgs({
      args: serverArgs,
      options: {
        "codex-command": { type: "string", default: "codex" },
        "project-root": { type: "string" },
        task: { type: "string" },
      },
      strict: true,
    });
    const root = parsed.values["project-root"] ?? cwd;
    const project = loadProject(discoverGitContext(root));
    const { runCodexAppServerProcess } = await import("../adapters/codex/app-server-process.js");
    await runCodexAppServerProcess({
      project,
      codexCommand: parsed.values["codex-command"],
      ...(parsed.values.task ? { preferredTaskId: parsed.values.task } : {}),
    });
    return;
  }
  if (action !== "install") throw new Error("codex requires `install [--dry-run]` or `app-server install|run`.");
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
  console.log(`Agent rule: ${result.plan.rulePath}`);
  if (result.plan.alreadyInstalled) console.log("Codex integration is already installed.");
  else if (parsed.values["dry-run"]) console.log("Dry run only; no files were changed.");
  else {
    if (result.plan.migrationRequired) console.log("Existing Polarbear Codex MCP configuration detected and updated.");
    console.log(`Backup:     ${result.backupDir}`);
    console.log("Codex integration installed. Restart active Codex clients.");
  }
}
