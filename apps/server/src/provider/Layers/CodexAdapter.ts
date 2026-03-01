/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type CanonicalItemType,
  type CanonicalRequestType,
  type RuntimeContentStreamKind,
  type RuntimeEventRawSource,
  type RuntimeTurnState,
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "codex" as const;

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: () => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  sessionId: ProviderSessionId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(
  sessionId: ProviderSessionId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(sessionId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toTurnState(value: unknown): RuntimeTurnState | undefined {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return undefined;
  }
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shouldDropItemType(type: string): boolean {
  if (type.includes("preamble") || type.includes("reasoning") || type.includes("thought")) {
    return true;
  }
  return type === "work" || type.startsWith("work ");
}

function toCanonicalItemType(normalizedType: string): CanonicalItemType | undefined {
  if (normalizedType.includes("agent message")) return "assistant_message";
  if (normalizedType.includes("command")) return "command_execution";
  if (normalizedType.includes("file change")) return "file_change";
  if (normalizedType.includes("mcp") && normalizedType.includes("tool")) return "mcp_tool_call";
  if (normalizedType.includes("web search")) return "web_search";
  if (normalizedType.includes("tool")) return "dynamic_tool_call";
  return undefined;
}

function isToolItemType(itemType: CanonicalItemType): boolean {
  return (
    itemType === "command_execution" ||
    itemType === "file_change" ||
    itemType === "mcp_tool_call" ||
    itemType === "dynamic_tool_call" ||
    itemType === "web_search"
  );
}

function titleForItemType(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "web_search":
      return "Web search";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

function toCanonicalRequestType(requestKind: string): CanonicalRequestType {
  switch (requestKind) {
    case "command":
      return "command_execution_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.text),
    asString(item.path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function makeEventBase(event: ProviderEvent) {
  const rawSource: RuntimeEventRawSource =
    event.kind === "request"
      ? "codex.app-server.request"
      : "codex.app-server.notification";

  return {
    eventId: event.id,
    provider: event.provider,
    sessionId: RuntimeSessionId.makeUnsafe(event.sessionId),
    createdAt: event.createdAt,
    ...(event.threadId !== undefined ? { threadId: ThreadId.makeUnsafe(event.threadId) } : {}),
    ...(event.turnId !== undefined ? { turnId: TurnId.makeUnsafe(event.turnId) } : {}),
    ...(event.itemId !== undefined ? { itemId: RuntimeItemId.makeUnsafe(event.itemId) } : {}),
    ...(event.requestId !== undefined
      ? { requestId: RuntimeRequestId.makeUnsafe(event.requestId) }
      : {}),
    providerRefs: {
      providerSessionId: event.sessionId,
      ...(event.threadId !== undefined ? { providerThreadId: event.threadId } : {}),
      ...(event.turnId !== undefined ? { providerTurnId: event.turnId } : {}),
      ...(event.itemId !== undefined ? { providerItemId: event.itemId } : {}),
    },
    raw: {
      source: rawSource,
      method: event.method,
      payload: event.payload,
    },
  } as const;
}

function mapToRuntimeEvents(event: ProviderEvent): ReadonlyArray<ProviderRuntimeEvent> {
  const base = makeEventBase(event);
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...base,
        type: "runtime.error" as const,
        payload: {
          message: event.message,
          class: "provider_error" as const,
          ...(payload ? { detail: payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request" && event.requestId && event.requestKind) {
    const detail =
      asString(payload?.command) ?? asString(payload?.reason) ?? asString(payload?.prompt);
    return [
      {
        ...base,
        requestId: RuntimeRequestId.makeUnsafe(event.requestId),
        type: "request.opened" as const,
        payload: {
          requestType: toCanonicalRequestType(event.requestKind),
          ...(detail ? { detail } : {}),
          ...(payload ? { args: payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    return [
      {
        ...base,
        requestId: RuntimeRequestId.makeUnsafe(event.requestId),
        type: "request.resolved" as const,
        payload: {
          requestType: event.requestKind
            ? toCanonicalRequestType(event.requestKind)
            : ("unknown" as const),
          ...(decision ? { decision } : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved" && event.requestId) {
    return [
      {
        ...base,
        requestId: RuntimeRequestId.makeUnsafe(event.requestId),
        type: "request.resolved" as const,
        payload: {
          requestType: event.requestKind
            ? toCanonicalRequestType(event.requestKind)
            : ("unknown" as const),
          ...(payload?.decision ? { decision: String(payload.decision) } : {}),
        },
      },
    ];
  }

  if (event.method === "item/completed") {
    const item = asObject(payload?.item);
    if (!item) return [];
    const normalizedType = normalizeItemType(item.type ?? item.kind);
    const canonicalType = toCanonicalItemType(normalizedType);

    if (canonicalType === "assistant_message") {
      const itemId = event.itemId ?? asString(item.id);
      if (!itemId) return [];
      return [
        {
          ...base,
          itemId: RuntimeItemId.makeUnsafe(itemId),
          type: "item.completed" as const,
          payload: {
            itemType: "assistant_message" as const,
            status: "completed" as const,
          },
        },
      ];
    }

    if (canonicalType && isToolItemType(canonicalType) && !shouldDropItemType(normalizedType)) {
      return [
        {
          ...base,
          type: "item.completed" as const,
          payload: {
            itemType: canonicalType,
            status: "completed" as const,
            title: titleForItemType(canonicalType),
            ...(payload ? { detail: itemDetail(item, payload) } : {}),
          },
        },
      ];
    }
  }

  if (event.method === "item/started") {
    const item = asObject(payload?.item);
    if (!item) return [];
    const normalizedType = normalizeItemType(item.type ?? item.kind);
    if (shouldDropItemType(normalizedType)) return [];
    const canonicalType = toCanonicalItemType(normalizedType);
    if (!canonicalType || !isToolItemType(canonicalType)) return [];

    return [
      {
        ...base,
        type: "item.started" as const,
        payload: {
          itemType: canonicalType,
          status: "inProgress" as const,
          title: titleForItemType(canonicalType),
          ...(payload ? { detail: itemDetail(item, payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...base,
        type: "session.started" as const,
        payload: {
          ...(event.message ? { message: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...base,
        type: "session.exited" as const,
        payload: {
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const threadId =
      event.threadId ??
      (payloadThreadId ? ProviderThreadId.makeUnsafe(payloadThreadId) : undefined);
    if (!threadId) {
      return [];
    }
    return [
      {
        ...base,
        threadId: ThreadId.makeUnsafe(threadId),
        type: "thread.started" as const,
        payload: {
          providerThreadId: ProviderThreadId.makeUnsafe(threadId),
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const payloadTurnId = asString(turn?.id);
    const turnId =
      event.turnId ?? (payloadTurnId ? ProviderTurnId.makeUnsafe(payloadTurnId) : undefined);
    if (!turnId) {
      return [];
    }
    return [
      {
        ...base,
        turnId: TurnId.makeUnsafe(turnId),
        type: "turn.started" as const,
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const state = toTurnState(turn?.status) ?? ("completed" as const);
    return [
      {
        ...base,
        type: "turn.completed" as const,
        payload: {
          state,
          ...(asString(asObject(turn?.error)?.message)
            ? { errorMessage: asString(asObject(turn?.error)?.message) }
            : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(turn?.costUsd !== undefined ? { totalCostUsd: asNumber(turn.costUsd) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated" && payload) {
    const explanation = asString(payload.explanation);
    const rawPlan = payload.plan;
    if (Array.isArray(rawPlan)) {
      const plan = rawPlan.map((step: unknown) => {
        const s = asObject(step);
        return {
          step: asString(s?.step) ?? "",
          status: (asString(s?.status) ?? "pending") as "pending" | "inProgress" | "completed",
        };
      });
      return [
        {
          ...base,
          type: "turn.plan.updated" as const,
          payload: {
            ...(explanation !== undefined ? { explanation } : {}),
            plan,
          },
        },
      ];
    }
  }

  if (
    event.method === "item/agentMessage/delta" &&
    event.textDelta &&
    event.textDelta.length > 0
  ) {
    return [
      {
        ...base,
        type: "content.delta" as const,
        payload: {
          streamKind: "assistant_text" as const,
          delta: event.textDelta,
        },
      },
    ];
  }

  if (event.method === "item/reasoning/textDelta" && event.textDelta) {
    return [
      {
        ...base,
        type: "content.delta" as const,
        payload: {
          streamKind: "reasoning_text" as const,
          delta: event.textDelta,
          ...(asNumber(payload?.contentIndex) !== undefined
            ? { contentIndex: asNumber(payload?.contentIndex) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/reasoning/summaryTextDelta" && event.textDelta) {
    return [
      {
        ...base,
        type: "content.delta" as const,
        payload: {
          streamKind: "reasoning_summary_text" as const,
          delta: event.textDelta,
          ...(asNumber(payload?.summaryIndex) !== undefined
            ? { summaryIndex: asNumber(payload?.summaryIndex) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta" && event.textDelta) {
    return [
      {
        ...base,
        type: "content.delta" as const,
        payload: {
          streamKind: "plan_text" as const,
          delta: event.textDelta,
        },
      },
    ];
  }

  if (event.method === "item/commandExecution/outputDelta" && event.textDelta) {
    return [
      {
        ...base,
        type: "content.delta" as const,
        payload: {
          streamKind: "command_output" as const,
          delta: event.textDelta,
        },
      },
    ];
  }

  if (event.method === "item/fileChange/outputDelta" && event.textDelta) {
    return [
      {
        ...base,
        type: "content.delta" as const,
        payload: {
          streamKind: "file_change_output" as const,
          delta: event.textDelta,
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    return [
      {
        ...base,
        type: "runtime.warning" as const,
        payload: {
          message: "MCP tool call progress",
          detail: payload,
        },
      },
    ];
  }

  if (event.method === "error" && event.message) {
    return [
      {
        ...base,
        type: "runtime.error" as const,
        payload: {
          message: event.message,
          class: "provider_error" as const,
          ...(payload ? { detail: payload } : {}),
        },
      },
    ];
  }

  return [];
}

const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogPath !== undefined
        ? makeEventNdjsonLogger(options.nativeEventLogPath)
        : undefined;

    const manager = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (options?.manager) {
          return options.manager;
        }
        if (options?.makeManager) {
          return options.makeManager();
        }
        return new CodexAppServerManager();
      }),
      (manager) =>
        Effect.sync(() => {
          try {
            manager.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    const startSession: CodexAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.startSession(input),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            sessionId: "pending",
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            cause,
          }),
      });
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: () => manager.sendTurn(input),
        catch: (cause) => toRequestError(input.sessionId, "turn/start", cause),
      });

    const interruptTurn: CodexAdapterShape["interruptTurn"] = (sessionId, turnId) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(sessionId, turnId),
        catch: (cause) => toRequestError(sessionId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (sessionId) =>
      Effect.tryPromise({
        try: () => manager.readThread(sessionId),
        catch: (cause) => toRequestError(sessionId, "thread/read", cause),
      });

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (sessionId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.rollbackThread(sessionId, numTurns),
        catch: (cause) => toRequestError(sessionId, "thread/rollback", cause),
      });
    };

    const respondToRequest: CodexAdapterShape["respondToRequest"] = (
      sessionId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(sessionId, requestId, decision),
        catch: (cause) => toRequestError(sessionId, "item/requestApproval/decision", cause),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (sessionId) =>
      Effect.sync(() => {
        manager.stopSession(sessionId);
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: CodexAdapterShape["hasSession"] = (sessionId) =>
      Effect.sync(() => manager.hasSession(sessionId));

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        manager.stopAll();
      });

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: ProviderEvent) => {
          nativeEventLogger?.write({
            observedAt: new Date().toISOString(),
            event,
          });
          Queue.offerAllUnsafe(runtimeEventQueue, mapToRuntimeEvents(event));
        };
        manager.on("event", listener);
        return listener;
      }),
      (listener) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            manager.off("event", listener);
          });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
