import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = resolve(repository, "docs");

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  }).sort();
}

function relativeSet(language) {
  const root = resolve(docs, language);
  return new Set(markdownFiles(root).map((path) => relative(root, path)));
}

const english = relativeSet("en");
const chinese = relativeSet("zh-CN");
const missingChinese = [...english].filter((path) => !chinese.has(path));
const missingEnglish = [...chinese].filter((path) => !english.has(path));
if (missingChinese.length > 0 || missingEnglish.length > 0) {
  throw new Error(`Documentation language trees differ. Missing zh-CN: ${missingChinese.join(", ") || "none"}; missing en: ${missingEnglish.join(", ") || "none"}.`);
}

const markdown = [
  resolve(repository, "README.md"), resolve(repository, "SECURITY.md"), resolve(repository, "AGENTS.md"),
  resolve(docs, "README.md"), ...markdownFiles(resolve(docs, "en")), ...markdownFiles(resolve(docs, "zh-CN")),
];
const linkPattern = /\]\(([^)]+)\)/gu;
for (const file of markdown) {
  const body = readFileSync(file, "utf8");
  for (const match of body.matchAll(linkPattern)) {
    const raw = match[1]?.trim() ?? "";
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(raw)) continue;
    const target = raw.replace(/^<|>$/gu, "").split("#", 1)[0]?.split("?", 1)[0];
    if (!target) continue;
    const resolved = resolve(dirname(file), decodeURIComponent(target));
    if (!existsSync(resolved)) throw new Error(`Broken documentation link in ${relative(repository, file)}: ${raw}`);
  }
}

const retiredNames = [
  "CONTEXT_OS_DESIGN.md", "CONTEXT_OS_USER_GUIDE.md", "GA_READINESS.md", "MACOS_RELEASE.md",
  "MEMORY_RETENTION_VALIDATION.md", "NPM_RELEASE.md", "PRD.md", "TRD.md", "TRD_UML_DESIGN.md", "USER_MANUAL.md",
];
for (const file of markdown) {
  const body = readFileSync(file, "utf8");
  const retired = retiredNames.find((name) => body.includes(name));
  if (retired) throw new Error(`Retired documentation path ${retired} is still referenced by ${relative(repository, file)}.`);
}

console.log(`Documentation OK: ${english.size} mirrored files per language and ${markdown.length} Markdown files checked.`);
