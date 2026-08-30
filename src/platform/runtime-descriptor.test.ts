import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RUNTIME_DESCRIPTOR_SCHEMA_VERSION,
  createRuntimeLaunchDescriptor,
  managedRuntimeDescriptorPath,
  publishRuntimeLaunchDescriptor,
  readRuntimeLaunchDescriptor,
} from "./runtime-descriptor.js";

function fixture(): { root: string; runtime: { executable: string; cliEntrypoint: string } } {
  const root = mkdtempSync(join(tmpdir(), "polarbear runtime descriptor with spaces-"));
  const executable = join(root, "Node 24", "node");
  const cliEntrypoint = join(root, "Polarbear Memory", "dist", "cli.js");
  mkdirSync(join(root, "Node 24"), { recursive: true });
  mkdirSync(join(root, "Polarbear Memory", "dist"), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\n", { encoding: "utf8", mode: 0o700, flag: "w" });
  chmodSync(executable, 0o700);
  writeFileSync(cliEntrypoint, "export {};\n", { encoding: "utf8", mode: 0o600, flag: "w" });
  return { root, runtime: { executable, cliEntrypoint } };
}

test("publishes a structured runtime descriptor for arbitrary absolute runtime locations", () => {
  const { root, runtime } = fixture();
  try {
    const path = publishRuntimeLaunchDescriptor(runtime, root);
    assert.equal(path, managedRuntimeDescriptorPath(root));
    assert.deepEqual(readRuntimeLaunchDescriptor(root), {
      schemaVersion: RUNTIME_DESCRIPTOR_SCHEMA_VERSION,
      runtime,
    });
    const source = readFileSync(path, "utf8");
    assert.match(source, /Node 24/u);
    assert.match(source, /Polarbear Memory/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts supported Node runtime paths without version-specific discovery", () => {
  const { root, runtime } = fixture();
  try {
    for (const name of ["node-v20", "node-v22", "node-v24"]) {
      const executable = join(root, name);
      writeFileSync(executable, "#!/bin/sh\n", { encoding: "utf8", mode: 0o700, flag: "w" });
      chmodSync(executable, 0o700);
      assert.equal(createRuntimeLaunchDescriptor({ ...runtime, executable }).runtime.executable, executable);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing or stale runtime descriptor paths", () => {
  const { root, runtime } = fixture();
  try {
    assert.throws(() => readRuntimeLaunchDescriptor(root), /descriptor is unavailable/u);
    const path = managedRuntimeDescriptorPath(root);
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: RUNTIME_DESCRIPTOR_SCHEMA_VERSION,
      runtime: { ...runtime, executable: "relative-node" },
    }), { encoding: "utf8" });
    assert.throws(() => readRuntimeLaunchDescriptor(root), /invalid executable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
