import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const components = Object.entries(lock.packages ?? {}).filter(([path]) => path).map(([path, metadata]) => ({
  type: "library",
  name: path.replace(/^node_modules\//u, ""),
  version: metadata.version ?? "unknown",
  ...(metadata.license ? { licenses: [{ license: { id: metadata.license } }] } : {}),
  ...(metadata.integrity ? { hashes: [{ alg: "SHA-512", content: metadata.integrity.replace(/^sha512-/u, "") }] } : {}),
  properties: [{ name: "polarbear:development", value: String(Boolean(metadata.dev)) }],
})).sort((left, right) => left.name.localeCompare(right.name));
const document = `${JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: { component: { type: "application", name: pkg.name, version: pkg.version } },
  components,
}, null, 2)}\n`;
const output = fileURLToPath(new URL("docs/SBOM.cdx.json", root));
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== document) throw new Error("SBOM is stale. Run npm run sbom:generate.");
  console.log(`SBOM is current: ${components.length} components.`);
} else {
  writeFileSync(output, document, { encoding: "utf8", mode: 0o600 });
  console.log(`Generated ${output} with ${components.length} components.`);
}
