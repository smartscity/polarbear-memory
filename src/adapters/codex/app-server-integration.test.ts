import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { discoverGitContext } from "../../platform/git.js";
import { planProject, writeProjectConfig } from "../../platform/project.js";
import {
  installCodexAppServerIntegration, planCodexAppServerIntegration, readCodexAppServerLaunchSpec,
  readCodexAppServerProviderLaunchSpec,
  uninstallCodexAppServerIntegration,
} from "./app-server-integration.js";

test("managed App Server descriptor installs idempotently and uninstalls without touching foreign Codex config", () => {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-app-server-install-"));
  const priorDataRoot = process.env.POLARBEAR_MEMORY_DATA_DIR;
  try {
    const root = join(temporary, "repo");
    assert.equal(spawnSync("git", ["init", "-q", root], { shell: false }).status, 0);
    process.env.POLARBEAR_MEMORY_DATA_DIR = join(temporary, "data");
    const project = planProject(discoverGitContext(root));
    writeProjectConfig(project);
    mkdirSync(join(root, ".codex"), { recursive: true });
    const codexConfig = join(root, ".codex", "config.toml");
    writeFileSync(codexConfig, "model = \"custom-model\"\n");
    const runtime = { executable: process.execPath, cliEntrypoint: join(process.cwd(), "dist-test", "cli.js") };

    const installed = installCodexAppServerIntegration(project, {
      codexCommand: process.execPath, dryRun: false, runtime,
    });
    assert.ok(installed.backupDir);
    const descriptor = JSON.parse(readFileSync(installed.plan.descriptorPath, "utf8")) as {
      mode: string; transport: string; command: string; args: string[]; codexCommand: string; projectRoot: string;
    };
    assert.equal(descriptor.mode, "LIFECYCLE_MANAGED");
    assert.equal(descriptor.transport, "stdio");
    assert.equal(descriptor.command, process.execPath);
    assert.equal(descriptor.codexCommand, process.execPath);
    assert.deepEqual(readCodexAppServerLaunchSpec(project), { command: descriptor.command, args: descriptor.args });
    assert.deepEqual(readCodexAppServerProviderLaunchSpec(project), {
      command: process.execPath, args: ["app-server", "--listen", "stdio://"],
    });
    assert.equal(readFileSync(codexConfig, "utf8"), "model = \"custom-model\"\n");

    const repeated = installCodexAppServerIntegration(project, {
      codexCommand: process.execPath, dryRun: false, runtime,
    });
    assert.equal(repeated.plan.alreadyInstalled, true);
    assert.equal(repeated.backupDir, undefined);
    assert.equal(planCodexAppServerIntegration(project).alreadyInstalled, true);

    const staleDescriptor = { ...descriptor, projectRoot: join(temporary, "different-repo") };
    writeFileSync(installed.plan.descriptorPath, `${JSON.stringify(staleDescriptor, null, 2)}\n`);
    assert.equal(planCodexAppServerIntegration(project).alreadyInstalled, false);
    assert.equal(readCodexAppServerLaunchSpec(project), undefined);
    assert.equal(readCodexAppServerProviderLaunchSpec(project), undefined);
    writeFileSync(installed.plan.descriptorPath, `${JSON.stringify({ ...descriptor, projectRoot: root }, null, 2)}\n`);

    const removed = uninstallCodexAppServerIntegration(project, { dryRun: false });
    assert.equal(removed.managedDescriptor, true);
    assert.ok(removed.backupDir);
    assert.equal(existsSync(installed.plan.descriptorPath), false);
    assert.equal(readFileSync(codexConfig, "utf8"), "model = \"custom-model\"\n");
  } finally {
    if (priorDataRoot === undefined) delete process.env.POLARBEAR_MEMORY_DATA_DIR;
    else process.env.POLARBEAR_MEMORY_DATA_DIR = priorDataRoot;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("managed App Server installer refuses an ambiguous foreign descriptor", () => {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-app-server-conflict-"));
  const priorDataRoot = process.env.POLARBEAR_MEMORY_DATA_DIR;
  try {
    const root = join(temporary, "repo");
    assert.equal(spawnSync("git", ["init", "-q", root], { shell: false }).status, 0);
    process.env.POLARBEAR_MEMORY_DATA_DIR = join(temporary, "data");
    const project = planProject(discoverGitContext(root));
    writeProjectConfig(project);
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "polarbear-app-server.json"), "{\"owner\":\"foreign\"}\n");
    assert.throws(() => installCodexAppServerIntegration(project, {
      codexCommand: process.execPath,
      dryRun: false,
      runtime: { executable: process.execPath, cliEntrypoint: join(process.cwd(), "dist-test", "cli.js") },
    }), /unmanaged Codex App Server descriptor/u);
  } finally {
    if (priorDataRoot === undefined) delete process.env.POLARBEAR_MEMORY_DATA_DIR;
    else process.env.POLARBEAR_MEMORY_DATA_DIR = priorDataRoot;
    rmSync(temporary, { recursive: true, force: true });
  }
});
