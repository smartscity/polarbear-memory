import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SqliteMemoryStore } from "./sqlite-store.js";
import { withExclusiveDatabaseMaintenance } from "./client-lease.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("exclusive maintenance blocks new clients and removes stale crashed leases", () => {
  const root = mkdtempSync(join(tmpdir(), "polarbear-client-lease-"));
  temporary.push(root);
  const databasePath = join(root, "memory.db");
  const first = new SqliteMemoryStore(databasePath);
  first.close();
  const clients = `${databasePath}.clients`;
  mkdirSync(clients, { recursive: true });
  const stale = join(clients, "stale.lease");
  writeFileSync(stale, `${JSON.stringify({ pid: 2_147_483_647 })}\n`);
  withExclusiveDatabaseMaintenance(databasePath, () => {
    assert.equal(existsSync(stale), false);
    assert.throws(() => new SqliteMemoryStore(databasePath), /maintenance/u);
  });
  const reopened = new SqliteMemoryStore(databasePath);
  reopened.close();
});

test("exclusive maintenance recovers a stale lock left by a crashed process", () => {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-stale-maintenance-"));
  temporary.push(directory);
  const databasePath = join(directory, "memory.db");
  writeFileSync(`${databasePath}.maintenance.lock`, `${JSON.stringify({ pid: 999_999_999 })}\n`);
  assert.equal(withExclusiveDatabaseMaintenance(databasePath, () => "recovered"), "recovered");
  assert.equal(existsSync(`${databasePath}.maintenance.lock`), false);
});
