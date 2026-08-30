import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProjectBinding } from "../../platform/project.js";
import type { AgentRuntime } from "../../platform/agent-launch.js";
import {
  installCodexIntegration, planCodexIntegration, readCodexLaunchSpec, uninstallCodexIntegration,
} from "./integration.js";

function fixture(): { temporary: string; project: ProjectBinding } {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-memory-codex-"));
  const root = join(temporary, "repo");
  const dataDir = join(temporary, "data");
  mkdirSync(root, { recursive: true });
  return {
    temporary,
    project: {
      id: "55555555-5555-4555-8555-555555555555",
      name: "codex-fixture",
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

test("Codex integration dry-run is non-mutating and install preserves other configuration", () => {
  const { temporary, project } = fixture();
  const directory = join(project.root, ".codex");
  const configPath = join(directory, "config.toml");
  mkdirSync(directory, { recursive: true });
  const original = `model = "gpt-test"\n\n[mcp_servers.existing]\ncommand = "existing"\n`;
  writeFileSync(configPath, original);
  try {
    installCodexIntegration(project, { dryRun: true });
    assert.equal(readFileSync(configPath, "utf8"), original);

    const installed = installCodexIntegration(project, { dryRun: false });
    assert.ok(installed.backupDir);
    const config = readFileSync(configPath, "utf8");
    assert.match(config, /model = "gpt-test"/u);
    assert.match(config, /\[mcp_servers\.existing\]/u);
    assert.match(config, /\[mcp_servers\.polarbear-memory\]/u);
    assert.equal(readCodexLaunchSpec(project)?.args.at(-1), project.root);
    assert.equal(planCodexIntegration(project).alreadyInstalled, true);
    installCodexIntegration(project, { dryRun: false });
    assert.equal(readFileSync(configPath, "utf8"), config);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Codex integration refuses to overwrite an unmanaged server with the same name", () => {
  const { temporary, project } = fixture();
  const directory = join(project.root, ".codex");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.toml"), `[mcp_servers.polarbear-memory]\ncommand = "custom"\n`);
  try {
    assert.equal(planCodexIntegration(project).conflict, true);
    assert.throws(() => installCodexIntegration(project, { dryRun: false }), /unmanaged/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Codex integration generates runtime-derived argv and migrates the legacy PATH command", () => {
  const { temporary, project } = fixture();
  const directory = join(project.root, ".codex");
  const configPath = join(directory, "config.toml");
  mkdirSync(directory, { recursive: true });
  writeFileSync(configPath, `model = "keep"\n\n[mcp_servers.polarbear-memory]\ncommand = "polarbear-memory"\nargs = [\n  "mcp",\n  "--stdio",\n  "--project-root",\n  ${JSON.stringify(project.root)}\n]\n`);
  try {
    const preview = planCodexIntegration(project, arbitraryRuntime);
    assert.equal(preview.legacyConfiguration, true);
    assert.equal(preview.conflict, false);
    installCodexIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    const migrated = readFileSync(configPath, "utf8");
    assert.match(migrated, /model = "keep"/u);
    assert.match(migrated, /command = "\/Arbitrary Runtime\/Current\/node"/u);
    assert.match(migrated, /"\/Arbitrary Package\/Polarbear\/dist\/cli\.js", "mcp"/u);
    assert.doesNotMatch(migrated, /command = "polarbear-memory"/u);
    installCodexIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    assert.equal(readFileSync(configPath, "utf8"), migrated);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Codex uninstall removes only the managed block", () => {
  const { temporary, project } = fixture();
  try {
    installCodexIntegration(project, { dryRun: false });
    const configPath = join(project.root, ".codex", "config.toml");
    const installed = readFileSync(configPath, "utf8");
    writeFileSync(configPath, `model = "keep"\n\n${installed}`);
    assert.equal(uninstallCodexIntegration(project, { dryRun: true }).plan.managedEntry, true);
    assert.match(readFileSync(configPath, "utf8"), /polarbear-memory/u);
    const result = uninstallCodexIntegration(project, { dryRun: false });
    assert.ok(result.backupDir);
    assert.equal(readFileSync(configPath, "utf8"), `model = "keep"\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
