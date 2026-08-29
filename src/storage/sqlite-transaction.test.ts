import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { inImmediateTransaction } from "./sqlite-transaction.js";

test("inImmediateTransaction commits a successful unit of work", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE values_table(value TEXT NOT NULL) STRICT");
    const result = inImmediateTransaction(database, () => {
      database.prepare("INSERT INTO values_table(value) VALUES (?)").run("committed");
      return 42;
    });
    assert.equal(result, 42);
    const row = database.prepare("SELECT value FROM values_table").get() as { value: string };
    assert.equal(row.value, "committed");
  } finally {
    database.close();
  }
});

test("inImmediateTransaction rolls back and preserves the operation error", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE values_table(value TEXT NOT NULL) STRICT");
    assert.throws(() => inImmediateTransaction(database, () => {
      database.prepare("INSERT INTO values_table(value) VALUES (?)").run("rolled-back");
      throw new Error("operation failed");
    }), /operation failed/u);
    assert.deepEqual(database.prepare("SELECT value FROM values_table").all(), []);
  } finally {
    database.close();
  }
});
