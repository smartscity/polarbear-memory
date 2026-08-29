import { parseArgs } from "node:util";
import { installClaudeIntegration, restoreLatestClaudeIntegration } from "../adapters/claude-code/integration.js";
import { discoverGitContext } from "../platform/git.js";
import { loadProject } from "../platform/project.js";

export function runClaudeCommand(cwd: string, args: string[]): void {
  const [action, ...rest] = args;
  const project = loadProject(discoverGitContext(cwd));
  if (action === "install") {
    const parsed = parseArgs({
      args: rest,
      options: { "dry-run": { type: "boolean", default: false }, command: { type: "string" } },
      strict: true,
    });
    const result = installClaudeIntegration(project, {
      dryRun: parsed.values["dry-run"],
      ...(parsed.values.command ? { command: parsed.values.command } : {}),
    });
    console.log(`MCP config: ${result.plan.mcpPath}`);
    console.log(`Rule:       ${result.plan.rulePath}`);
    console.log(`Hooks:      ${result.plan.settingsPath}`);
    if (result.plan.alreadyInstalled) console.log("Claude Code integration is already installed.");
    else if (parsed.values["dry-run"]) console.log("Dry run only; no files were changed.");
    else {
      console.log(`Backup:     ${result.backupDir}`);
      console.log("Claude Code integration installed. Approve the project MCP server when Claude prompts.");
    }
    return;
  }
  if (action === "restore" && rest.length === 0) {
    console.log(`Restored Claude Code integration from ${restoreLatestClaudeIntegration(project)}`);
    return;
  }
  throw new Error("claude requires `install [--dry-run]` or `restore`.");
}

export async function runHookCommand(cwd: string, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "ingest") return;
  try {
    const parsed = parseArgs({ args: rest, options: { event: { type: "string" } }, strict: true });
    if (parsed.values.event !== "Stop" && parsed.values.event !== "SessionEnd") return;
    const raw: unknown = JSON.parse(await readStdinBounded(256 * 1024));
    if (!raw || typeof raw !== "object" || (raw as { hook_event_name?: unknown }).hook_event_name !== parsed.values.event) return;
    const { ingestClaudeHook } = await import("../adapters/claude-code/hooks.js");
    ingestClaudeHook(raw, cwd);
  } catch {
    // Hooks are observational and must never block Claude Code or write protocol noise.
  }
}

export async function runSpoolCommand(cwd: string, args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "replay") throw new Error("spool requires `replay`.");
  const project = loadProject(discoverGitContext(cwd));
  const { replayProjectSpool } = await import("../adapters/claude-code/hooks.js");
  const result = replayProjectSpool(project);
  console.log(`Spool replayed: ${result.replayed}`);
  console.log(`Spool failed:   ${result.failed}`);
  console.log(`Memories:      ${result.finalized}`);
}

async function readStdinBounded(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("Hook input exceeds the size limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
