import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { createMemoryMcpServer } from "./server.js";
import type { ProjectBinding } from "../platform/project.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-memory-mcp-"));
  temporaryDirectories.push(temporary);
  const root = join(temporary, "repo");
  assert.equal(spawnSync("git", ["init", "-q", root], { shell: false }).status, 0);
  const project: ProjectBinding = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "mcp-fixture",
    root,
    configPath: join(root, ".polarbear", "config.toml"),
    dataDir: join(temporary, "data"),
    databasePath: join(temporary, "memory.db"),
  };
  const store = new SqliteMemoryStore(project.databasePath);
  store.initializeProject(project);
  return { store, project };
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  return block.text;
}

async function connected(includeAdminTools = false) {
  const { store, project } = fixture();
  const server = createMemoryMcpServer({ store, project, includeAdminTools });
  const client = new Client({ name: "polarbear-memory-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { store, server, client };
}

test("default MCP surface preserves Memory tools and adds Context OS tools", async () => {
  const { store, server, client } = await connected();
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "constraint_record", "context_explain", "context_get", "decision_record", "memory_context", "memory_feedback",
      "memory_get", "memory_record", "memory_search", "memory_verify", "task_checkpoint", "task_get",
    ]);
    await assert.rejects(client.callTool({ name: "memory_status", arguments: {} }));
    const invalidBudget = await client.callTool({
      name: "memory_context",
      arguments: { task: "invalid budget", budget: 199 },
    });
    assert.equal(invalidBudget.isError, true);

    const escaped = await client.callTool({
      name: "memory_record",
      arguments: { type: "TODO", summary: "Must not persist", files: ["../outside.txt"] },
    });
    assert.equal(escaped.isError, true);
    assert.equal(store.status("33333333-3333-4333-8333-333333333333").total, 0);

    const recorded = await client.callTool({
      name: "memory_record",
      arguments: { type: "DECISION", summary: "FAILED is a terminal settlement state", files: ["src/settlement.ts"] },
    });
    const memory = JSON.parse(firstText(recorded)) as { id: string };
    const expanded = await client.callTool({ name: "memory_get", arguments: { memory_id: memory.id } });
    assert.match(firstText(expanded), /UNTRUSTED_PROJECT_MEMORY/u);

    const context = await client.callTool({
      name: "memory_context",
      arguments: { task: "continue failed settlement", budget: 400 },
    });
    assert.match(firstText(context), /FAILED is a terminal settlement state/);

    const verified = await client.callTool({
      name: "memory_verify",
      arguments: { memory_id: memory.id, result: "VERIFIED", reason: "Checked the current state transition code." },
    });
    assert.match(firstText(verified), /"verificationState": "VERIFIED"/);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

test("Context OS MCP flow checkpoints a task and explains a bounded packet", async () => {
  const { store, server, client } = await connected();
  try {
    const projectId = "33333333-3333-4333-8333-333333333333";
    const task = store.contextOs().createTask(projectId, {
      title: "Settlement retry", objective: "Implement and verify bounded settlement retry.", phase: "IMPLEMENTATION",
    });
    const decision = await client.callTool({
      name: "decision_record",
      arguments: { task_id: task.id, summary: "Retry from reconciliation", rationale: "The terminal failure is asynchronous." },
    });
    assert.match(firstText(decision), /Retry from reconciliation/u);
    const checkpoint = await client.callTool({
      name: "task_checkpoint",
      arguments: {
        task_id: task.id, status: "ACTIVE", phase: "IMPLEMENTATION", summary: "Retry counter added.",
        state: { changed: ["Added retry counter."], remaining: ["Add integration coverage."] },
      },
    });
    assert.match(firstText(checkpoint), /Retry counter added/u);
    const context = await client.callTool({
      name: "context_get",
      arguments: { task_id: task.id, current_request: "Continue settlement retry", max_tokens: 600, provider: "codex" },
    });
    const packet = JSON.parse(firstText(context)) as { id: string; estimatedTokens: number; maxTokens: number };
    assert.ok(packet.estimatedTokens <= packet.maxTokens);
    const explanation = await client.callTool({ name: "context_explain", arguments: { packet_id: packet.id } });
    assert.match(firstText(explanation), /budgetByCategory/u);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

test("admin MCP surface adds status and reversible forget only", async () => {
  const { store, server, client } = await connected(true);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 14);
    assert.ok(names.includes("memory_status"));
    assert.ok(names.includes("memory_forget"));

    const recorded = await client.callTool({
      name: "memory_record",
      arguments: { type: "TODO", summary: "Add recovery coverage" },
    });
    const memory = JSON.parse(firstText(recorded)) as { id: string };
    const forgotten = await client.callTool({
      name: "memory_forget",
      arguments: { memory_id: memory.id, reason: "Task was cancelled by the user." },
    });
    assert.match(firstText(forgotten), /"lifecycleStatus": "ARCHIVED"/);
    assert.equal(store.get("33333333-3333-4333-8333-333333333333", memory.id)?.lifecycleStatus, "ARCHIVED");
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});
