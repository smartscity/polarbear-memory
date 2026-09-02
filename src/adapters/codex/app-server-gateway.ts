import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { redactText } from "../../security/redaction.js";
import type { AgentLifecycleEvent, AgentLifecycleOutcome } from "../../domain/agent-lifecycle.js";

type JsonObject = Record<string, unknown>;

export interface LifecycleEventHandler {
  handle(event: AgentLifecycleEvent): AgentLifecycleOutcome;
}

const TOOL_ITEM_TYPES = new Set([
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabToolCall", "webSearch", "imageView",
]);

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRedactedText(value: string, maxBytes: number): string {
  const redacted = redactText(value, homedir());
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  let lower = 0;
  let upper = redacted.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(redacted.slice(0, midpoint), "utf8") <= maxBytes) lower = midpoint;
    else upper = midpoint - 1;
  }
  return redacted.slice(0, lower);
}

function requestKey(message: JsonObject): string | undefined {
  if (message.id === undefined) return undefined;
  return `${String(message.method)}:${JSON.stringify(message.id)}`;
}

function lifecyclePayload(params: JsonObject, item?: JsonObject): Record<string, string | boolean> {
  const status = text(item?.status) ?? text(object(params.turn)?.status);
  const itemType = text(item?.type);
  const payload: Record<string, string | boolean> = {
    ...(text(params.threadId) ? { threadIdHash: sha256(String(params.threadId)) } : {}),
    ...(text(params.turnId) ? { turnIdHash: sha256(String(params.turnId)) } : {}),
    ...(text(item?.id) ? { itemIdHash: sha256(String(item?.id)) } : {}),
    ...(itemType ? { itemType } : {}),
    ...(status ? { status } : {}),
    ...(typeof item?.success === "boolean" ? { success: item.success } : {}),
  };
  const error = item?.error ?? object(params.turn)?.error;
  if (error !== undefined) payload.errorSummary = boundedRedactedText(JSON.stringify(error), 4 * 1024);
  return payload;
}

function threadIdFrom(params: JsonObject): string | undefined {
  return text(params.threadId) ?? text(object(params.thread)?.id) ?? text(object(params.turn)?.threadId);
}

function turnIdFrom(params: JsonObject): string | undefined {
  return text(params.turnId) ?? text(object(params.turn)?.id);
}

export class CodexAppServerGateway {
  readonly #handler: LifecycleEventHandler;
  readonly #preferredTaskId: string | undefined;
  readonly #contextBudget: number | undefined;
  readonly #onFailure: ((event: AgentLifecycleEvent) => void) | undefined;
  readonly #requestCache = new Map<string, JsonObject>();
  readonly #assistantMessages = new Map<string, string>();

  constructor(
    handler: LifecycleEventHandler,
    options: { preferredTaskId?: string; contextBudget?: number; onFailure?: (event: AgentLifecycleEvent) => void } = {},
  ) {
    this.#handler = handler;
    this.#preferredTaskId = options.preferredTaskId;
    this.#contextBudget = options.contextBudget;
    this.#onFailure = options.onFailure;
  }

  transformClientMessage(value: unknown): unknown {
    const message = object(value);
    if (!message || (message.method !== "turn/start" && message.method !== "turn/steer")) return value;
    const cacheKey = requestKey(message);
    const cached = cacheKey ? this.#requestCache.get(cacheKey) : undefined;
    if (cached) return cached;
    const params = object(message.params);
    const threadId = params ? text(params.threadId) : undefined;
    const input = params && Array.isArray(params.input) ? params.input : undefined;
    if (!params || !threadId || !input) return value;
    const prompt = input.map(object)
      .filter((item): item is JsonObject => Boolean(item && item.type === "text" && typeof item.text === "string"))
      .map((item) => String(item.text)).join("\n");
    if (input.some((item) => {
      const candidate = object(item);
      return candidate?.type === "text" && text(candidate.text)?.startsWith("# Polarbear Context Packet");
    })) return value;

    const currentRequest = prompt ? boundedRedactedText(prompt, 16 * 1024) : "User submitted non-text input.";
    const outcome = this.#safeHandle({
      id: sha256(`codex-app-server\0${threadId}\0${String(message.id)}\0${sha256(currentRequest)}`),
      provider: "codex-app-server",
      type: "USER_PROMPT_SUBMITTED",
      sessionRefHash: sha256(threadId),
      occurredAt: new Date().toISOString(),
      payload: {
        promptDigest: sha256(currentRequest),
        promptBytes: String(Buffer.byteLength(prompt, "utf8")),
        inputItemCount: String(input.length),
        transportMethod: String(message.method),
      },
      currentRequest,
      ...(this.#preferredTaskId ? { preferredTaskId: this.#preferredTaskId } : {}),
      ...(this.#contextBudget === undefined ? {} : { contextBudget: this.#contextBudget }),
    });
    if (!outcome?.contextPacket?.rendered) return value;
    const transformed: JsonObject = {
      ...message,
      params: {
        ...params,
        input: [...input, { type: "text", text: outcome.contextPacket.rendered }],
      },
    };
    if (cacheKey) {
      this.#requestCache.set(cacheKey, transformed);
      if (this.#requestCache.size > 128) this.#requestCache.delete(this.#requestCache.keys().next().value as string);
    }
    return transformed;
  }

  observeServerMessage(value: unknown): void {
    const message = object(value);
    const method = text(message?.method);
    const params = object(message?.params);
    if (!method || !params) return;
    const threadId = threadIdFrom(params);
    if (!threadId) return;
    const turnId = turnIdFrom(params);
    const item = object(params.item);
    const itemType = text(item?.type);
    const base = {
      provider: "codex-app-server",
      sessionRefHash: sha256(threadId),
      occurredAt: new Date().toISOString(),
      ...(this.#preferredTaskId ? { preferredTaskId: this.#preferredTaskId } : {}),
      ...(this.#contextBudget === undefined ? {} : { contextBudget: this.#contextBudget }),
    } as const;

    if (method === "thread/started") {
      this.#safeHandle({ ...base, id: this.#eventId(method, threadId), type: "SESSION_STARTED", payload: {} });
      return;
    }
    if (method === "thread/closed") {
      this.#safeHandle({ ...base, id: this.#eventId(method, threadId), type: "SESSION_ENDED", payload: {} });
      return;
    }
    if ((method === "item/started" || method === "item/completed") && item && itemType === "contextCompaction") {
      this.#safeHandle({
        ...base,
        id: this.#eventId(method, threadId, turnId, text(item.id)),
        type: method === "item/started" ? "BEFORE_COMPACTION" : "AFTER_COMPACTION",
        payload: lifecyclePayload(params, item),
      });
      return;
    }
    if (method === "item/completed" && item && (itemType === "agentMessage" || itemType === "agent_message")) {
      const assistantMessage = text(item.text);
      if (assistantMessage && turnId) this.#assistantMessages.set(`${threadId}\0${turnId}`, boundedRedactedText(assistantMessage, 32 * 1024));
      return;
    }
    if ((method === "item/started" || method === "item/completed") && item && itemType && TOOL_ITEM_TYPES.has(itemType)) {
      const status = text(item.status);
      const failed = status === "failed" || status === "declined" || item.success === false;
      this.#safeHandle({
        ...base,
        id: this.#eventId(method, threadId, turnId, text(item.id), status),
        type: method === "item/started" ? "TOOL_STARTED" : failed ? "TOOL_FAILED" : "TOOL_COMPLETED",
        payload: lifecyclePayload(params, item),
      });
      return;
    }
    if (method === "turn/completed") {
      const turn = object(params.turn);
      const status = text(turn?.status) ?? "completed";
      const messageKey = turnId ? `${threadId}\0${turnId}` : undefined;
      const lastAssistantMessage = messageKey ? this.#assistantMessages.get(messageKey) : undefined;
      this.#safeHandle({
        ...base,
        id: this.#eventId(method, threadId, turnId, status),
        type: status === "failed" || status === "interrupted" ? "TURN_FAILED" : "TURN_COMPLETED",
        payload: {
          ...lifecyclePayload(params),
          ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
        },
      });
      if (messageKey) this.#assistantMessages.delete(messageKey);
    }
  }

  #eventId(method: string, ...parts: Array<string | undefined>): string {
    return sha256(["codex-app-server", method, ...parts.filter((part): part is string => Boolean(part))].join("\0"));
  }

  #safeHandle(event: AgentLifecycleEvent): AgentLifecycleOutcome | undefined {
    try {
      return this.#handler.handle(event);
    } catch {
      try { this.#onFailure?.(event); } catch { /* Failure diagnostics must remain fail-open. */ }
      return undefined;
    }
  }
}
