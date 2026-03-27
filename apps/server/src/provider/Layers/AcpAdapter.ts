import type { ChildProcessWithoutNullStreams } from "node:child_process";
import nodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  TurnId,
  type ThreadId,
} from "@t3tools/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema, Stream } from "effect";

import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  attachAcpJsonRpcConnection,
  disposeAcpChild,
  spawnAcpChildProcess,
  type AcpJsonRpcConnection,
} from "../acp/AcpJsonRpcConnection.ts";
import type { AcpInboundMessage } from "../acp/AcpTypes.ts";
import { AcpProcessExitedError, AcpRpcError, type AcpError } from "../acp/AcpErrors.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { AcpAgentRegistry } from "../Services/AcpAgentRegistry.ts";
import { AcpAdapter, type AcpAdapterShape } from "../Services/AcpAdapter.ts";

const PROVIDER = "acp" as const;
const ACP_RESUME_VERSION = 1 as const;

export interface AcpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface AcpSessionContext {
  threadId: ThreadId;
  session: ProviderSession;
  child: ChildProcessWithoutNullStreams;
  conn: AcpJsonRpcConnection;
  acpSessionId: string;
  notificationFiber?: Fiber.Fiber<void, never>;
  pendingApprovals: Map<
    ApprovalRequestId,
    { readonly decision: Deferred.Deferred<ProviderApprovalDecision> }
  >;
  turns: Array<{ id: TurnId; items: ReadonlyArray<unknown> }>;
  activeTurnId?: TurnId;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== ACP_RESUME_VERSION) {
    return undefined;
  }
  return typeof raw.sessionId === "string" && raw.sessionId.trim().length > 0
    ? { sessionId: raw.sessionId.trim() }
    : undefined;
}

function mapAcpToAdapterError(threadId: ThreadId, method: string, error: AcpError) {
  if (Schema.is(AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId, cause: error });
  }
  if (Schema.is(AcpRpcError)(error)) {
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

function extractTextChunk(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const update = isRecord(params.update) ? params.update : params;
  if (typeof update.sessionUpdate !== "string") {
    return undefined;
  }
  if (
    update.sessionUpdate !== "agent_message_chunk" &&
    update.sessionUpdate !== "assistant_message_chunk"
  ) {
    return undefined;
  }
  const content = update.content;
  return isRecord(content) && content.type === "text" && typeof content.text === "string"
    ? content.text
    : undefined;
}

function extractPermissionDetail(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.toolCall)) {
    return undefined;
  }
  if (typeof params.toolCall.title === "string" && params.toolCall.title.trim().length > 0) {
    return params.toolCall.title.trim();
  }
  return undefined;
}

function approvalOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    case "cancel":
    default:
      return "reject-once";
  }
}

function makeAcpAdapter(options?: AcpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const agentRegistry = yield* AcpAgentRegistry;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, AcpSessionContext>();

    const nowIso = Effect.sync(() => new Date().toISOString());
    const makeEventStamp = () =>
      Effect.gen(function* () {
        return {
          eventId: EventId.makeUnsafe(crypto.randomUUID()),
          createdAt: yield* nowIso,
        };
      });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event);

    const logNativeInbound = (
      threadId: ThreadId,
      input: {
        readonly kind: "notification" | "request" | "response" | "error";
        readonly method: string;
        readonly payload: unknown;
      },
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: input.kind,
              provider: PROVIDER,
              createdAt: observedAt,
              method: input.method,
              threadId,
              payload: input.payload,
            },
          },
          threadId,
        );
      });

    const requestWithNativeLogging = (
      threadId: ThreadId,
      conn: AcpJsonRpcConnection,
      method: string,
      params?: unknown,
    ) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(conn.request(method, params));
        if (Exit.isSuccess(result)) {
          yield* logNativeInbound(threadId, {
            kind: "response",
            method,
            payload: result.value,
          });
          return result.value;
        }
        const squashed = Cause.squash(result.cause);
        yield* logNativeInbound(threadId, {
          kind: "error",
          method,
          payload:
            squashed instanceof Error
              ? { message: squashed.message, name: squashed.name }
              : { message: String(squashed ?? "Unknown ACP error") },
        });
        return yield* Effect.failCause(result.cause);
      });

    const stopSessionInternal = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        disposeAcpChild(ctx.child);
        sessions.delete(ctx.threadId);
      });

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      if (ctx.stopped) {
        return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
      }
      return Effect.succeed(ctx);
    };

    const startSession: AcpAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const acpSelection = input.modelSelection;
        if (acpSelection?.provider !== "acp") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "ACP sessions require an ACP model selection with agentServerId.",
          });
        }
        const agentServers = yield* agentRegistry.getAgentServers.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        const agentServer = agentServers.find(
          (candidate) => candidate.id === acpSelection.agentServerId,
        );
        if (!agentServer || !agentServer.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Unknown or disabled ACP agent '${acpSelection.agentServerId}'.`,
          });
        }
        const cwd = input.cwd?.trim() ? nodePath.resolve(input.cwd.trim()) : undefined;
        const child = yield* spawnAcpChildProcess({
          command: agentServer.launch.command,
          args: [...agentServer.launch.args],
          ...(cwd ? { cwd } : {}),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        const conn = yield* attachAcpJsonRpcConnection(child).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Failed to attach ACP transport.",
                cause,
              }),
          ),
        );

        const ctx: AcpSessionContext = {
          threadId: input.threadId,
          session: {} as ProviderSession,
          child,
          conn,
          acpSessionId: "",
          pendingApprovals: new Map(),
          turns: [],
          stopped: false,
        };

        yield* conn.registerHandler("session/request_permission", (params) =>
          Effect.gen(function* () {
            yield* logNativeInbound(input.threadId, {
              kind: "request",
              method: "session/request_permission",
              payload: params,
            });
            const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            ctx.pendingApprovals.set(requestId, { decision });
            yield* offerRuntimeEvent({
              type: "request.opened",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              agentServerId: agentServer.id,
              threadId: input.threadId,
              turnId: ctx.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(requestId),
              payload: {
                requestType: "command_execution_approval",
                detail: extractPermissionDetail(params) ?? "ACP permission request",
                args: params,
              },
              raw: { source: "acp.jsonrpc", method: "session/request_permission", payload: params },
            });
            const resolved = yield* Deferred.await(decision);
            ctx.pendingApprovals.delete(requestId);
            yield* offerRuntimeEvent({
              type: "request.resolved",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              agentServerId: agentServer.id,
              threadId: input.threadId,
              turnId: ctx.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(requestId),
              payload: { requestType: "command_execution_approval", decision: resolved },
            });
            return { outcome: { outcome: "selected", optionId: approvalOutcome(resolved) } };
          }),
        );

        yield* requestWithNativeLogging(input.threadId, conn, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "t3-code", version: "0.0.0" },
        }).pipe(
          Effect.mapError((cause) => mapAcpToAdapterError(input.threadId, "initialize", cause)),
        );

        const resume = parseResume(input.resumeCursor);
        const created = resume
          ? yield* Effect.exit(
              requestWithNativeLogging(input.threadId, conn, "session/load", {
                sessionId: resume.sessionId,
                ...(cwd ? { cwd } : {}),
              }),
            ).pipe(
              Effect.flatMap((result) =>
                Exit.isSuccess(result)
                  ? Effect.succeed(result.value)
                  : requestWithNativeLogging(input.threadId, conn, "session/new", {
                      ...(cwd ? { cwd } : {}),
                      mcpServers: [],
                    }).pipe(
                      Effect.mapError((cause) =>
                        mapAcpToAdapterError(input.threadId, "session/new", cause),
                      ),
                    ),
              ),
            )
          : yield* requestWithNativeLogging(input.threadId, conn, "session/new", {
              ...(cwd ? { cwd } : {}),
              mcpServers: [],
            }).pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(input.threadId, "session/new", cause),
              ),
            );

        const sessionId =
          resume?.sessionId ??
          (isRecord(created) && typeof created.sessionId === "string"
            ? created.sessionId
            : undefined);
        if (!sessionId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/new",
            detail: "session/new missing sessionId",
          });
        }

        const session: ProviderSession = {
          provider: PROVIDER,
          agentServerId: agentServer.id,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(cwd ? { cwd } : {}),
          threadId: input.threadId,
          resumeCursor: { schemaVersion: ACP_RESUME_VERSION, sessionId },
          createdAt: yield* nowIso,
          updatedAt: yield* nowIso,
        };

        ctx.session = session;
        ctx.acpSessionId = sessionId;

        const notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(conn.notifications, (message: AcpInboundMessage) =>
            Effect.gen(function* () {
              if (message._tag !== "notification") {
                return;
              }
              yield* logNativeInbound(input.threadId, {
                kind: "notification",
                method: message.method,
                payload: message.params,
              });
              if (message.method !== "session/update") {
                return;
              }
              const text = extractTextChunk(message.params);
              if (!text) {
                return;
              }
              yield* offerRuntimeEvent({
                type: "content.delta",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                agentServerId: agentServer.id,
                threadId: input.threadId,
                turnId: ctx.activeTurnId,
                payload: { streamKind: "assistant_text", delta: text },
                raw: { source: "acp.jsonrpc", method: "session/update", payload: message.params },
              });
            }),
          ),
        ).pipe(Effect.forkChild);

        ctx.notificationFiber = notificationFiber;
        sessions.set(input.threadId, ctx);

        yield* offerRuntimeEvent({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          agentServerId: agentServer.id,
          threadId: input.threadId,
          payload: { message: `${agentServer.name} ACP session started` },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          agentServerId: agentServer.id,
          threadId: input.threadId,
          payload: { state: "ready", reason: "ACP session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          agentServerId: agentServer.id,
          threadId: input.threadId,
          payload: { providerThreadId: sessionId },
        });

        return session;
      });

    const sendTurn: AcpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (
          (!input.input || input.input.trim().length === 0) &&
          (!input.attachments || input.attachments.length === 0)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        ctx.activeTurnId = turnId;
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          agentServerId: ctx.session.agentServerId,
          threadId: input.threadId,
          turnId,
          payload: {},
        });
        const promptParts = input.input?.trim() ? [{ type: "text", text: input.input.trim() }] : [];
        const result = yield* requestWithNativeLogging(input.threadId, ctx.conn, "session/prompt", {
          sessionId: ctx.acpSessionId,
          prompt: promptParts,
        }).pipe(
          Effect.mapError((cause) => mapAcpToAdapterError(input.threadId, "session/prompt", cause)),
        );
        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          agentServerId: ctx.session.agentServerId,
          threadId: input.threadId,
          turnId,
          payload: {
            state: "completed",
            stopReason:
              isRecord(result) && typeof result.stopReason === "string" ? result.stopReason : null,
          },
        });
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    const interruptTurn: AcpAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* Effect.ignore(
          ctx.conn.notify("session/cancel", {
            sessionId: ctx.acpSessionId,
          }),
        );
      });

    const respondToRequest: AcpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: AcpAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_user_input",
          detail: "Generic ACP adapter does not support structured user input yet.",
        }),
      );

    const stopSession: AcpAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session }))),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const session = sessions.get(threadId);
          return session !== undefined && !session.stopped;
        }),
      readThread: (threadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          return { threadId, turns: ctx.turns };
        }),
      rollbackThread: (threadId, numTurns) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const nextLength = Math.max(0, ctx.turns.length - numTurns);
          ctx.turns.splice(nextLength);
          return { threadId, turns: ctx.turns };
        }),
      stopAll: () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }),
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies AcpAdapterShape;
  });
}

export const AcpAdapterLive = Layer.effect(AcpAdapter, makeAcpAdapter());

export function makeAcpAdapterLive(options?: AcpAdapterLiveOptions) {
  return Layer.effect(AcpAdapter, makeAcpAdapter(options));
}
