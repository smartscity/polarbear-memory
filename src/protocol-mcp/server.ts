import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { compileContext } from "../application/context.js";
import type { MemoryStore } from "../application/ports.js";
import { MVP_MEMORY_TYPES } from "../domain/memory.js";
import { discoverGitContext, normalizeRepoFile } from "../platform/git.js";
import type { ProjectBinding } from "../platform/project.js";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Internal error";
  const home = process.env.HOME;
  return { isError: true, ...text(home ? message.replaceAll(home, "<home>") : message) };
}

function asJson(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

export interface MemoryMcpOptions {
  store: MemoryStore;
  project: ProjectBinding;
  includeAdminTools?: boolean;
}

export function createMemoryMcpServer(options: MemoryMcpOptions): McpServer {
  const { store, project } = options;
  const server = new McpServer({ name: "polarbear-memory", version: "0.0.3" });

  server.registerTool("memory_context", {
    title: "Get relevant project memory",
    description: "Call at session start or when switching tasks. Returns only task-relevant local project memory within a token budget.",
    inputSchema: z.object({
      task: z.string().min(1).max(4_096),
      budget: z.number().int().min(200).max(4_000).default(1_000),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ task, budget }) => {
    try {
      return text(compileContext(store, project.id, task, budget).markdown);
    } catch (error) {
      return safeError(error);
    }
  });

  server.registerTool("memory_get", {
    title: "Get one memory",
    description: "Expand one Memory by UUID, including source, state and associated files.",
    inputSchema: z.object({ memory_id: z.uuid() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ memory_id }) => {
    try {
      const memory = store.get(project.id, memory_id);
      return memory ? asJson(memory) : { isError: true, ...text(`Memory not found: ${memory_id}`) };
    } catch (error) {
      return safeError(error);
    }
  });

  server.registerTool("memory_search", {
    title: "Search project memory",
    description: "Search local project memory for decisions, pitfalls, task state or TODOs.",
    inputSchema: z.object({
      query: z.string().min(1).max(4_096),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, limit }) => {
    try {
      return asJson(store.search(project.id, query, limit).map(({ memory }) => ({
        id: memory.id,
        type: memory.type,
        summary: memory.summary,
        lifecycleStatus: memory.lifecycleStatus,
        verificationState: memory.verificationState,
        confidence: memory.confidence,
        importance: memory.importance,
        files: memory.files,
      })));
    } catch (error) {
      return safeError(error);
    }
  });

  server.registerTool("memory_record", {
    title: "Record reusable project memory",
    description: "Record a durable decision, pitfall, current task state or TODO. Never store full transcripts, secrets or conversational filler.",
    inputSchema: z.object({
      type: z.enum(MVP_MEMORY_TYPES),
      summary: z.string().min(1).max(2_048),
      content: z.string().min(1).max(16_384).optional(),
      files: z.array(z.string().min(1).max(1_024)).max(20).default([]),
      confidence: z.number().int().min(0).max(1_000).default(700),
      importance: z.number().int().min(0).max(1_000).default(500),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ type, summary, content, files, confidence, importance }) => {
    try {
      const git = discoverGitContext(project.root);
      const memory = store.record(project.id, {
        type,
        summary,
        ...(content ? { content } : {}),
        files: files.map((file) => normalizeRepoFile(project.root, file)),
        sourceType: "MCP",
        confidence,
        importance,
        ...(git.head ? { commitSha: git.head } : {}),
        ...(git.branch ? { branchName: git.branch } : {}),
      });
      return asJson(memory);
    } catch (error) {
      return safeError(error);
    }
  });

  server.registerTool("memory_verify", {
    title: "Verify or dispute memory",
    description: "Update verification after checking current code or evidence. Verification does not bypass future stale checks.",
    inputSchema: z.object({
      memory_id: z.uuid(),
      result: z.enum(["VERIFIED", "DISPUTED", "UNVERIFIED"]),
      reason: z.string().min(1).max(2_048),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ memory_id, result, reason }) => {
    try {
      return asJson(store.verify(project.id, memory_id, result, reason));
    } catch (error) {
      return safeError(error);
    }
  });

  if (options.includeAdminTools) {
    server.registerTool("memory_status", {
      title: "Inspect Memory status",
      description: "Return local project Memory counts for diagnostics.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => asJson(store.status(project.id)));

    server.registerTool("memory_forget", {
      title: "Archive one memory",
      description: "Archive a Memory so it leaves normal retrieval. This never physically purges data.",
      inputSchema: z.object({ memory_id: z.uuid(), reason: z.string().min(1).max(2_048) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ memory_id, reason }) => {
      try {
        return asJson(store.archive(project.id, memory_id, reason));
      } catch (error) {
        return safeError(error);
      }
    });
  }

  return server;
}

export async function serveMemoryMcpStdio(options: MemoryMcpOptions): Promise<void> {
  const server = createMemoryMcpServer(options);
  await server.connect(new StdioServerTransport(undefined, undefined, { maxBufferSize: 256 * 1024 }));
}
