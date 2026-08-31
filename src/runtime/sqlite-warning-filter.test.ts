import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { SQLITE_EXPERIMENTAL_WARNING_MESSAGE } from "./sqlite-warning-filter.js";

function emitWarning(message: string, type: string): string {
  const moduleUrl = new URL("./sqlite-warning-filter.js", import.meta.url).href;
  const source = `
    import { installSqliteExperimentalWarningFilter } from ${JSON.stringify(moduleUrl)};
    installSqliteExperimentalWarningFilter();
    process.emitWarning(${JSON.stringify(message)}, ${JSON.stringify(type)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stderr;
}

test("suppresses only the known node:sqlite ExperimentalWarning", () => {
  assert.equal(emitWarning(SQLITE_EXPERIMENTAL_WARNING_MESSAGE, "ExperimentalWarning"), "");
  assert.match(emitWarning("A different experimental feature", "ExperimentalWarning"), /A different experimental feature/u);
  assert.match(emitWarning(SQLITE_EXPERIMENTAL_WARNING_MESSAGE, "Warning"), /SQLite is an experimental feature/u);
});
