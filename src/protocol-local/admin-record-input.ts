import type { FileAnchor } from "../domain/lifecycle.js";
import { MVP_MEMORY_TYPES, type RecordMemoryInput } from "../domain/memory.js";
import { ApiError } from "./admin-errors.js";

const COMPLETION_STATES = ["OPEN", "COMPLETED", "CANCELLED"] as const;
const ENTITY_KINDS = ["MODULE", "FILE", "SYMBOL", "SERVICE", "API", "DATABASE_TABLE", "DEPENDENCY", "ISSUE", "CONCEPT"] as const;
const ENTITY_ROLES = ["SUBJECT", "AFFECTS", "REFERENCES", "DEPENDS_ON", "RELATED"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_ARGUMENT", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiError("INVALID_ARGUMENT", `${label} is required.`);
  const result = value.trim();
  if (Buffer.byteLength(result, "utf8") > maxBytes) throw new ApiError("INVALID_ARGUMENT", `${label} exceeds its size limit.`);
  return result;
}

function optionalText(value: unknown, label: string, maxBytes: number): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : requiredText(value, label, maxBytes);
}

function enumValue<const T extends readonly string[]>(value: unknown, label: string, values: T, fallback?: T[number]): T[number] {
  if (value === undefined && fallback !== undefined) return fallback;
  const normalized = requiredText(value, label, 64).toUpperCase();
  if (!values.includes(normalized as T[number])) throw new ApiError("INVALID_ARGUMENT", `Unsupported ${label}.`);
  return normalized as T[number];
}

function score(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1000) {
    throw new ApiError("INVALID_ARGUMENT", `${label} must be an integer between 0 and 1000.`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string, limit: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limit) throw new ApiError("INVALID_ARGUMENT", `${label} must contain at most ${limit} items.`);
  return value.map((item, index) => requiredText(item, `${label}[${index}]`, 4096));
}

function anchors(value: unknown): FileAnchor[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new ApiError("INVALID_ARGUMENT", "fileAnchors must contain at most 100 items.");
  return value.map((item, index) => {
    const input = record(item, `fileAnchors[${index}]`);
    const startLine = scoreLine(input.startLine, `fileAnchors[${index}].startLine`);
    const endLine = scoreLine(input.endLine, `fileAnchors[${index}].endLine`);
    if (startLine && endLine && endLine < startLine) throw new ApiError("INVALID_ARGUMENT", "file anchor endLine must not be earlier than startLine.");
    return {
      path: requiredText(input.path, `fileAnchors[${index}].path`, 4096),
      ...optionalFields(input, index),
      ...(startLine ? { startLine } : {}),
      ...(endLine ? { endLine } : {}),
    };
  });
}

function scoreLine(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10_000_000) {
    throw new ApiError("INVALID_ARGUMENT", `${label} must be a positive integer.`);
  }
  return value as number;
}

function optionalFields(input: Record<string, unknown>, index: number): Omit<FileAnchor, "path" | "startLine" | "endLine"> {
  const prefix = `fileAnchors[${index}]`;
  const values = {
    entityId: optionalText(input.entityId, `${prefix}.entityId`, 256),
    symbol: optionalText(input.symbol, `${prefix}.symbol`, 1024),
    contentDigest: optionalText(input.contentDigest, `${prefix}.contentDigest`, 256),
    capturedCommit: optionalText(input.capturedCommit, `${prefix}.capturedCommit`, 256),
    lastCheckedCommit: optionalText(input.lastCheckedCommit, `${prefix}.lastCheckedCommit`, 256),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function entities(value: unknown): RecordMemoryInput["entities"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new ApiError("INVALID_ARGUMENT", "entities must contain at most 100 items.");
  return value.map((item, index) => {
    const input = record(item, `entities[${index}]`);
    const confidence = score(input.confidence, `entities[${index}].confidence`);
    const metadata = input.metadata === undefined ? undefined : record(input.metadata, `entities[${index}].metadata`);
    for (const metadataValue of Object.values(metadata ?? {})) {
      if (metadataValue !== null && !["string", "number", "boolean"].includes(typeof metadataValue)) {
        throw new ApiError("INVALID_ARGUMENT", "Entity metadata values must be scalar JSON values.");
      }
    }
    return {
      kind: enumValue(input.kind, `entities[${index}].kind`, ENTITY_KINDS),
      canonicalKey: requiredText(input.canonicalKey, `entities[${index}].canonicalKey`, 4096),
      displayName: requiredText(input.displayName, `entities[${index}].displayName`, 2048),
      role: enumValue(input.role, `entities[${index}].role`, ENTITY_ROLES, "SUBJECT"),
      ...(confidence === undefined ? {} : { confidence }),
      ...(metadata ? { metadata: metadata as Record<string, string | number | boolean | null> } : {}),
    };
  });
}

export function parseRecordMemoryInput(raw: Record<string, unknown>): RecordMemoryInput {
  const content = optionalText(raw.content, "content", 16 * 1024);
  const confidence = score(raw.confidence, "confidence");
  const importance = score(raw.importance, "importance");
  const files = stringArray(raw.files, "files", 100);
  const fileAnchors = anchors(raw.fileAnchors);
  const commitSha = optionalText(raw.commitSha, "commitSha", 256);
  const branchName = optionalText(raw.branchName, "branchName", 1024);
  const validFrom = optionalText(raw.validFrom, "validFrom", 128);
  const validTo = optionalText(raw.validTo, "validTo", 128);
  const episodeId = optionalText(raw.episodeId, "episodeId", 256);
  const evidenceIds = stringArray(raw.evidenceIds, "evidenceIds", 100);
  const linkedEntities = entities(raw.entities);
  return {
    type: enumValue(raw.type, "type", MVP_MEMORY_TYPES),
    summary: requiredText(raw.summary, "summary", 2048),
    ...(content ? { content } : {}),
    ...(files ? { files } : {}),
    ...(fileAnchors ? { fileAnchors } : {}),
    completionState: enumValue(raw.completionState, "completionState", COMPLETION_STATES, "OPEN"),
    sourceType: "CLI",
    ...(confidence === undefined ? {} : { confidence }),
    ...(importance === undefined ? {} : { importance }),
    ...(commitSha ? { commitSha } : {}),
    ...(branchName ? { branchName } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    ...(episodeId ? { episodeId } : {}),
    ...(evidenceIds ? { evidenceIds } : {}),
    ...(linkedEntities ? { entities: linkedEntities } : {}),
  };
}
