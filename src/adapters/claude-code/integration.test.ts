import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProjectBinding } from "../../platform/project.js";
import type { AgentRuntime } from "../../platform/agent-launch.js";
import { installClaudeIntegration, planClaudeIntegration, restoreLatestClaudeIntegration, uninstallClaudeIntegration } from "./integration.js";

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

const arbitraryRuntime: AgentRuntime = {
  executable: "/Arbitrary Runtime/Current/node",
  cliEntrypoint: "/Arbitrary Package/Polarbear/dist/cli.js",
};

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
    assert.match(readFileSync(join(project.root, ".claude", "rules", "polarbear-memory.md"), "utf8"), /context_get/);
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

test("Claude integration migrates MCP and hooks to the shared runtime launch", () => {
  const { temporary, project } = fixture();
  const mcpPath = join(project.root, ".mcp.json");
  const settingsPath = join(project.root, ".claude", "settings.json");
  mkdirSync(join(project.root, ".claude"), { recursive: true });
  writeFileSync(mcpPath, `${JSON.stringify({
    mcpServers: {
      existing: { command: "keep" },
      "polarbear-memory": { command: "polarbear-memory", args: ["mcp", "--stdio"] },
    },
  }, null, 2)}\n`);
  writeFileSync(settingsPath, `${JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "'polarbear-memory' hook ingest --event Stop" }] }] },
  }, null, 2)}\n`);
  try {
    assert.equal(planClaudeIntegration(project, arbitraryRuntime).legacyConfiguration, true);
    installClaudeIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.equal(mcp.mcpServers.existing?.command, "keep");
    assert.equal(mcp.mcpServers["polarbear-memory"]?.command, arbitraryRuntime.executable);
    assert.equal(mcp.mcpServers["polarbear-memory"]?.args[0], arbitraryRuntime.cliEntrypoint);
    assert.equal(mcp.mcpServers["polarbear-memory"]?.args.at(-1), project.root);
    const installedSettings = readFileSync(settingsPath, "utf8");
    assert.doesNotMatch(installedSettings, /'polarbear-memory' hook/u);
    assert.match(installedSettings, /Arbitrary Runtime/u);
    const installed = `${readFileSync(mcpPath, "utf8")}\n${installedSettings}`;
    installClaudeIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    assert.equal(`${readFileSync(mcpPath, "utf8")}\n${readFileSync(settingsPath, "utf8")}`, installed);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Claude uninstall is previewable and removes only managed entries", () => {
  const { temporary, project } = fixture();
  const mcpPath = join(project.root, ".mcp.json");
  try {
    writeFileSync(mcpPath, `${JSON.stringify({ mcpServers: { existing: { command: "keep-me" } } }, null, 2)}\n`);
    installClaudeIntegration(project, { dryRun: false });
    const settingsPath = join(project.root, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: { Stop: unknown[] } };
    settings.hooks.Stop.unshift({ hooks: [{ type: "command", command: "keep-me", timeout: 2 }] });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const preview = uninstallClaudeIntegration(project, { dryRun: true });
    assert.deepEqual(preview.plan, { mcpEntry: true, hooks: 8, managedRule: true, modifiedRulePreserved: false });
    assert.ok((JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers["polarbear-memory"]);

    const result = uninstallClaudeIntegration(project, { dryRun: false });
    assert.ok(result.backupDir);
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.ok(mcp.mcpServers.existing);
    assert.equal(mcp.mcpServers["polarbear-memory"], undefined);
    const nextSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: { Stop: unknown[]; SessionEnd: unknown[] } };
    assert.equal(nextSettings.hooks.Stop.length, 1);
    assert.equal(nextSettings.hooks.SessionEnd.length, 0);
    assert.throws(() => readFileSync(join(project.root, ".claude", "rules", "polarbear-memory.md"), "utf8"), /ENOENT/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
