import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(readFileSync(resolve(root, "api/admin-v1.json"), "utf8"));
const contractTypes = readFileSync(resolve(root, "api/admin-v1.types.ts"), "utf8").trim();
const runtimeContractSource = readFileSync(resolve(root, "api/runtime-launch-v1.json"), "utf8");
const runtimeContract = JSON.parse(runtimeContractSource);
const router = readFileSync(resolve(root, "src/protocol-local/admin-router.ts"), "utf8");
const body = router.match(/export const ADMIN_CAPABILITIES = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
const implemented = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

if (JSON.stringify(implemented) !== JSON.stringify(contract.capabilities)) {
  console.error("Engine Admin capability implementation has drifted from api/admin-v1.json.");
  process.exitCode = 1;
}
if (!router.includes(`export const ADMIN_API_VERSION = "${contract.version}";`)) {
  console.error("Engine Admin API version has drifted from api/admin-v1.json.");
  process.exitCode = 1;
}
if (runtimeContract.contract !== "polarbear-memory-runtime-launch"
  || runtimeContract.schemaVersion !== 1
  || JSON.stringify(runtimeContract.relativePath) !== JSON.stringify(["runtime", "launch.json"])
  || JSON.stringify(runtimeContract.runtimeFields) !== JSON.stringify(["executable", "cliEntrypoint"])) {
  console.error("Engine runtime launch contract is invalid.");
  process.exitCode = 1;
}

const desktopRoot = process.env.POLARBEAR_DESKTOP_ROOT;
if (desktopRoot) {
  const desktop = JSON.parse(readFileSync(resolve(desktopRoot, "apps/desktop/contracts/memory/admin-v1.json"), "utf8"));
  const desktopTypes = readFileSync(resolve(desktopRoot, "apps/desktop/contracts/memory/admin-v1.types.ts"), "utf8").trim();
  const desktopRuntimeContractSource = readFileSync(resolve(desktopRoot, "apps/desktop/contracts/memory/runtime-launch-v1.json"), "utf8");
  if (desktop.version !== contract.version || JSON.stringify(desktop.capabilities) !== JSON.stringify(contract.capabilities)) {
    console.error("Polarbear Desktop's vendored Memory Admin contract has drifted from the Engine contract.");
    process.exitCode = 1;
  }
  if (desktopTypes !== contractTypes) {
    console.error("Polarbear Desktop's vendored Memory Admin DTOs have drifted from the Engine contract.");
    process.exitCode = 1;
  }
  if (desktopRuntimeContractSource !== runtimeContractSource) {
    console.error("Polarbear Desktop's vendored runtime launch contract has drifted from the Engine contract.");
    process.exitCode = 1;
  }
}
