import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProjectBinding } from "../platform/project.js";
import { installClaudeIntegration, planClaudeIntegration, restoreLatestClaudeIntegration } from "./integration.js";

function fixture(): { temporary: string; project: ProjectBinding } {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-memory-claude-"));
  const root = join(temporary, "repo");
  const dataDir = join(temporary, "data");
  mkdirSync(root, { recursive: true });
  return {
    temporary,
    project: {
      id: "44444444-4444-4444-8444-444444444444",
      name: "claude-fixture",
      root,
      configPath: join(root, ".polarbear", "config.toml"),
      dataDir,
      databasePath: join(dataDir, "memory.db"),
    },
  };
}

test("Claude integration dry-run is non-mutating and install preserves other MCP servers", () => {
  const { temporary, project } = fixture();
  const mcpPath = join(project.root, ".mcp.json");
  const original = `${JSON.stringify({ mcpServers: { existing: { command: "existing-server", args: [] } } }, null, 2)}\n`;
  writeFileSync(mcpPath, original);
  try {
    installClaudeIntegration(project, { dryRun: true });
    assert.equal(readFileSync(mcpPath, "utf8"), original);

    const installed = installClaudeIntegration(project, { dryRun: false });
    assert.ok(installed.backupDir);
    const config = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.ok(config.mcpServers.existing);
    assert.ok(config.mcpServers["polarbear-memory"]);
    assert.match(readFileSync(join(project.root, ".claude", "rules", "polarbear-memory.md"), "utf8"), /memory_context/);
    const settings = JSON.parse(readFileSync(join(project.root, ".claude", "settings.json"), "utf8")) as {
      hooks: { Stop: unknown[]; SessionEnd: unknown[] };
    };
    assert.equal(settings.hooks.Stop.length, 1);
    assert.equal(settings.hooks.SessionEnd.length, 1);
    assert.equal(planClaudeIntegration(project).alreadyInstalled, true);

    restoreLatestClaudeIntegration(project);
    assert.equal(readFileSync(mcpPath, "utf8"), original);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Claude restore removes newly installed managed files without deleting the backup", () => {
  const { temporary, project } = fixture();
  try {
    const installed = installClaudeIntegration(project, { dryRun: false });
    assert.ok(installed.backupDir);
    const restoredFrom = restoreLatestClaudeIntegration(project);
    assert.equal(restoredFrom, installed.backupDir);
    assert.throws(() => readFileSync(join(project.root, ".mcp.json"), "utf8"), /ENOENT/);
    assert.match(readFileSync(join(restoredFrom, ".mcp.json.installed"), "utf8"), /polarbear-memory/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
