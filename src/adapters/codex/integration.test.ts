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
  writeFileSync(join(project.root, "AGENTS.md"), "# Existing project instructions\n");
  try {
    installCodexIntegration(project, { dryRun: true });
    assert.equal(readFileSync(configPath, "utf8"), original);

    const installed = installCodexIntegration(project, { dryRun: false });
    assert.ok(installed.backupDir);
    const config = readFileSync(configPath, "utf8");
    assert.match(config, /model = "gpt-test"/u);
    assert.match(config, /\[mcp_servers\.existing\]/u);
    assert.match(config, /\[mcp_servers\.polarbear-memory\]/u);
    const rule = readFileSync(join(project.root, "AGENTS.md"), "utf8");
    assert.match(rule, /# Existing project instructions/u);
    assert.match(rule, /BEGIN POLARBEAR MEMORY MANAGED CONTEXT/u);
    assert.match(rule, /MCP-assisted/u);
    assert.match(rule, /task_checkpoint/u);
    assert.equal(readCodexLaunchSpec(project)?.args.at(-1), project.root);
    const current = planCodexIntegration(project);
    assert.equal(current.classification, "CURRENT_MANAGED");
    assert.equal(current.alreadyInstalled, true);
    installCodexIntegration(project, { dryRun: false });
    assert.equal(readFileSync(configPath, "utf8"), config);
    assert.equal(readFileSync(join(project.root, "AGENTS.md"), "utf8"), rule);
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
    const plan = planCodexIntegration(project);
    assert.equal(plan.classification, "FOREIGN_COLLISION");
    assert.equal(plan.conflict, true);
    assert.throws(() => installCodexIntegration(project, { dryRun: false }), /unmanaged/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Codex integration migrates the Polarbear Memory 0.3.2 PATH configuration", () => {
  const { temporary, project } = fixture();
  const directory = join(project.root, ".codex");
  const configPath = join(directory, "config.toml");
  mkdirSync(directory, { recursive: true });
  writeFileSync(configPath, `model = "keep"\n\n[mcp_servers.polarbear-memory]\ncommand = "polarbear-memory"\nargs = ["mcp", "--stdio", "--project-root", "/project"]\n`);
  try {
    const preview = planCodexIntegration(project, arbitraryRuntime);
    assert.equal(preview.classification, "LEGACY_MANAGED");
    assert.equal(preview.migrationRequired, true);
    assert.equal(preview.conflict, false);
    installCodexIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    const migrated = readFileSync(configPath, "utf8");
    assert.match(migrated, /model = "keep"/u);
    assert.match(migrated, /command = "\/Arbitrary Runtime\/Current\/node"/u);
    assert.match(migrated, /"\/Arbitrary Package\/Polarbear\/dist\/cli\.js", "mcp"/u);
    assert.doesNotMatch(migrated, /command = "polarbear-memory"/u);
    assert.equal(readCodexLaunchSpec(project)?.args.at(-1), project.root);
    installCodexIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    assert.equal(readFileSync(configPath, "utf8"), migrated);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Codex integration normalizes a repairable installed-package launch", () => {
  const { temporary, project } = fixture();
  const directory = join(project.root, ".codex");
  const configPath = join(directory, "config.toml");
  mkdirSync(directory, { recursive: true });
  writeFileSync(configPath, `model = "keep"\n\n[mcp_servers.polarbear-memory]\ncommand = "/Old Runtime/node"\nargs = [${JSON.stringify(arbitraryRuntime.cliEntrypoint)}, "mcp", "--stdio", "--project-root", "/previous/project"]\nrequired = false\n`);
  try {
    const preview = planCodexIntegration(project, arbitraryRuntime);
    assert.equal(preview.classification, "REPAIRABLE_POLARBEAR");
    assert.equal(preview.migrationRequired, true);
    assert.equal(preview.conflict, false);

    installCodexIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    const migrated = readFileSync(configPath, "utf8");
    assert.match(migrated, /model = "keep"/u);
    assert.match(migrated, /# BEGIN POLARBEAR MEMORY MANAGED MCP/u);
    assert.match(migrated, /required = true/u);
    assert.equal(readCodexLaunchSpec(project)?.args.at(-1), project.root);
    installCodexIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    assert.equal(readFileSync(configPath, "utf8"), migrated);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("Codex install repairs a missing managed AGENTS rule without changing the current MCP launch", () => {
  const { temporary, project } = fixture();
  try {
    installCodexIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    const configPath = join(project.root, ".codex", "config.toml");
    const config = readFileSync(configPath, "utf8");
    rmSync(join(project.root, "AGENTS.md"));
    assert.equal(planCodexIntegration(project, arbitraryRuntime).alreadyInstalled, false);
    installCodexIntegration(project, { dryRun: false, runtime: arbitraryRuntime });
    assert.equal(readFileSync(configPath, "utf8"), config);
    assert.match(readFileSync(join(project.root, "AGENTS.md"), "utf8"), /task_checkpoint/u);
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
    const rulePath = join(project.root, "AGENTS.md");
    const managedRule = readFileSync(rulePath, "utf8");
    writeFileSync(rulePath, `# Keep this instruction\n\n${managedRule}`);
    assert.equal(uninstallCodexIntegration(project, { dryRun: true }).plan.managedEntry, true);
    assert.match(readFileSync(configPath, "utf8"), /polarbear-memory/u);
    const result = uninstallCodexIntegration(project, { dryRun: false });
    assert.ok(result.backupDir);
    assert.equal(readFileSync(configPath, "utf8"), `model = "keep"\n`);
    assert.equal(readFileSync(rulePath, "utf8"), "# Keep this instruction\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
