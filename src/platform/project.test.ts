import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readProjectPolicy, updateProjectPolicy } from "./project.js";

test("treats a legacy configured budget as custom while new defaults remain auto", () => {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-project-policy-"));
  const configPath = join(directory, "config.toml");
  try {
    writeFileSync(
      configPath,
      'capture_mode = "summary"\nraw_event_retention_days = 7\ndefault_context_budget = 1000\n',
      "utf8",
    );
    assert.deepEqual(readProjectPolicy(configPath), {
      captureMode: "summary",
      rawEventRetentionDays: 7,
      contextBudgetMode: "custom",
      defaultContextBudget: 1000,
    });
    const updated = updateProjectPolicy(configPath, { rawEventRetentionDays: 30 });
    assert.equal(updated.contextBudgetMode, "custom");
    assert.equal(updated.defaultContextBudget, 1000);
    assert.match(readFileSync(configPath, "utf8"), /context_budget_mode = "custom"/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
