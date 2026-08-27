import { readFileSync } from "node:fs";

const metadata: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!metadata || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string") {
  throw new Error("package.json version is missing or invalid.");
}

export const VERSION = metadata.version;
