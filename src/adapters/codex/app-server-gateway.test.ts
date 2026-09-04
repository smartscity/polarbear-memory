import assert from "node:assert/strict";
import test from "node:test";
import type { AgentLifecycleEvent, AgentLifecycleOutcome } from "../../domain/agent-lifecycle.js";
import { CodexAppServerGateway } from "./app-server-gateway.js";

function harness() {
  const events: AgentLifecycleEvent[] = [];
  const deliveries: Array<{ packetId: string; deliveryPoint: string }> = [];
  const gateway = new CodexAppServerGateway({
    handle(event): AgentLifecycleOutcome {
      events.push(event);
      return {
        accepted: true,
        observations: 1,
        candidates: 0,
        persisted: 0,
        ...(event.type === "USER_PROMPT_SUBMITTED" ? {
          contextPacket: {
            id: "packet-1", projectId: "project-1", version: 1, currentRequest: event.currentRequest ?? "",
            provider: "codex-app-server", maxTokens: 2_000, estimatedTokens: 20,
            retrievalRunId: "retrieval-1", packetHash: "hash", rendered: "# Polarbear Context Packet\n\nUNTRUSTED historical context: keep the API boundary.",
            items: [], createdAt: "2026-09-01T00:00:00.000Z",
          },
        } : {}),
      };
    },
    recordContextDelivery(packetId, input) {
      deliveries.push({ packetId, deliveryPoint: input.deliveryPoint });
    },
  }, { preferredTaskId: "task-1", contextBudget: 900 });
  return { deliveries, events, gateway };
}

test("injects prompt-specific Context before turn/start without persisting the raw prompt", () => {
  const { deliveries, events, gateway } = harness();
  const request = {
    id: 7,
    method: "turn/start",
    params: { threadId: "thread-1", input: [{ type: "text", text: "Fix private-marker-4271." }] },
  };
  const transformed = gateway.transformClientMessage(request) as typeof request;
  assert.equal(transformed.params.input.length, 2);
  assert.match(transformed.params.input[1]?.text ?? "", /UNTRUSTED historical context/u);
  assert.deepEqual(Object.keys(transformed.params.input[1] ?? {}).sort(), ["text", "type"]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "USER_PROMPT_SUBMITTED");
  assert.equal(events[0]?.preferredTaskId, "task-1");
  assert.equal(events[0]?.contextBudget, 900);
  assert.equal(events[0]?.currentRequest, "Fix private-marker-4271.");
  assert.doesNotMatch(JSON.stringify(events[0]?.payload), /private-marker-4271/u);
  assert.deepEqual(deliveries, [{ packetId: "packet-1", deliveryPoint: "CODEX_APP_SERVER_TURN_INPUT" }]);

  assert.deepEqual(gateway.transformClientMessage(request), transformed);
  assert.equal(events.length, 1);
  assert.equal(deliveries.length, 1);
});

test("maps streamed thread, tool, compaction, assistant, and turn events to the shared lifecycle", () => {
  const { events, gateway } = harness();
  gateway.observeServerMessage({ method: "thread/started", params: { thread: { id: "thread-2" } } });
  gateway.observeServerMessage({
    method: "item/started",
    params: { threadId: "thread-2", turnId: "turn-2", item: { id: "tool-1", type: "commandExecution", status: "inProgress" } },
  });
  gateway.observeServerMessage({
    method: "item/completed",
    params: { threadId: "thread-2", turnId: "turn-2", item: { id: "tool-1", type: "commandExecution", status: "failed", error: "token=secret-value" } },
  });
  gateway.observeServerMessage({
    method: "item/started",
    params: { threadId: "thread-2", turnId: "compact-1", item: { id: "compact-item", type: "contextCompaction" } },
  });
  gateway.observeServerMessage({
    method: "item/completed",
    params: { threadId: "thread-2", turnId: "compact-1", item: { id: "compact-item", type: "contextCompaction" } },
  });
  gateway.observeServerMessage({
    method: "item/completed",
    params: { threadId: "thread-2", turnId: "turn-2", item: { id: "message-1", type: "agentMessage", text: "Decision: Keep the gateway local." } },
  });
  gateway.observeServerMessage({
    method: "turn/completed",
    params: { threadId: "thread-2", turn: { id: "turn-2", status: "completed" } },
  });
  gateway.observeServerMessage({ method: "thread/closed", params: { threadId: "thread-2" } });

  assert.deepEqual(events.map(({ type }) => type), [
    "SESSION_STARTED", "TOOL_STARTED", "TOOL_FAILED", "BEFORE_COMPACTION", "AFTER_COMPACTION", "TURN_COMPLETED", "SESSION_ENDED",
  ]);
  const toolFailure = events.find(({ type }) => type === "TOOL_FAILED");
  assert.match(String(toolFailure?.payload.errorSummary), /<redacted>/u);
  const turn = events.find(({ type }) => type === "TURN_COMPLETED");
  assert.equal(turn?.payload.lastAssistantMessage, "Decision: Keep the gateway local.");
});

test("leaves approvals and unrelated App Server messages byte-semantically unchanged", () => {
  const { events, gateway } = harness();
  const approval = {
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-3", turnId: "turn-3", itemId: "item-3", availableDecisions: ["accept", "decline"] },
  };
  assert.equal(gateway.transformClientMessage(approval), approval);
  gateway.observeServerMessage(approval);
  assert.equal(events.length, 0);
});
