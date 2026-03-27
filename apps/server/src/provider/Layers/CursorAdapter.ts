/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP JSON-RPC.
 *
 * @module CursorAdapterLive
 */
import * as nodePath from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  ApprovalRequestId,
  EventId,
  type ProviderInteractionMode,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Queue,
  Random,
  Schema,
  Stream,
} from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  attachAcpJsonRpcConnection,
  disposeAcpChild,
  spawnAcpChildProcess,
  type AcpJsonRpcConnection,
} from "../acp/AcpJsonRpcConnection.ts";
import type { AcpInboundMessage } from "../acp/AcpTypes.ts";
import { AcpProcessExitedError, AcpRpcError, type AcpError } from "../acp/AcpErrors.ts";
import { CursorAdapter, type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { resolveCursorAcpModelId } from "./CursorProvider.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "cursor" as const;

const CURSOR_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

export interface CursorAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function extractModelConfigId(sessionResponse: unknown): string | undefined {
  if (!isRecord(sessionResponse)) return undefined;
  const configOptions = sessionResponse.configOptions;
  if (!Array.isArray(configOptions)) return undefined;
  for (const opt of configOptions) {
    if (isRecord(opt) && opt.category === "model" && typeof opt.id === "string") {
      return opt.id;
    }
  }
  return undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function mapAcpToAdapterError(
  threadId: ThreadId,
  method: string,
  error: AcpError,
): ProviderAdapterError {
  if (Schema.is(AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
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
    detail: toMessage(error, `${method} failed`),
    cause: error,
  });
}

function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
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

interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<AcpSessionMode>;
}

interface AcpToolCallState {
  readonly toolCallId: string;
  readonly itemType: ToolLifecycleItemType;
  readonly title?: string;
  readonly status?: "pending" | "inProgress" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
}

function normalizePlanStepStatus(raw: unknown): "pending" | "inProgress" | "completed" {
  switch (raw) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: "pending" | "inProgress" | "completed" | "failed",
): "pending" | "inProgress" | "completed" | "failed" | undefined {
  switch (raw) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

function runtimeItemStatusFromToolCallStatus(
  status: "pending" | "inProgress" | "completed" | "failed" | undefined,
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const directCommand = normalizeCommandValue(rawInput.command);
    if (directCommand) {
      return directCommand;
    }
    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  return extractCommandFromTitle(title);
}

function extractTextContentFromToolCallContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const chunks = content
    .map((entry) => {
      if (!isRecord(entry)) {
        return undefined;
      }
      if (entry.type !== "content") {
        return undefined;
      }
      const nestedContent = entry.content;
      if (!isRecord(nestedContent) || nestedContent.type !== "text") {
        return undefined;
      }
      return typeof nestedContent.text === "string" && nestedContent.text.trim().length > 0
        ? nestedContent.text.trim()
        : undefined;
    })
    .filter((entry): entry is string => entry !== undefined);
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function toolLifecycleItemTypeFromKind(kind: unknown): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function requestTypeFromToolKind(
  kind: unknown,
): "exec_command_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (kind) {
    case "execute":
      return "exec_command_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function parseToolCallState(
  raw: unknown,
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId.trim() : "";
  if (!toolCallId) {
    return undefined;
  }
  const title =
    typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title.trim() : undefined;
  const command = extractToolCallCommand(raw.rawInput, title);
  const textContent = extractTextContentFromToolCallContent(raw.content);
  const normalizedTitle =
    title && title.toLowerCase() !== "terminal" && title.toLowerCase() !== "tool call"
      ? title
      : undefined;
  const detail = command ?? normalizedTitle ?? textContent;
  const data: Record<string, unknown> = { toolCallId };
  if (typeof raw.kind === "string" && raw.kind.trim().length > 0) {
    data.kind = raw.kind.trim();
  }
  if (command) {
    data.command = command;
  }
  if (raw.rawInput !== undefined) {
    data.rawInput = raw.rawInput;
  }
  if (raw.rawOutput !== undefined) {
    data.rawOutput = raw.rawOutput;
  }
  if (raw.content !== undefined) {
    data.content = raw.content;
  }
  if (raw.locations !== undefined) {
    data.locations = raw.locations;
  }
  const status = normalizeToolCallStatus(raw.status, options?.fallbackStatus);
  return {
    toolCallId,
    itemType: toolLifecycleItemTypeFromKind(raw.kind),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data,
  } satisfies AcpToolCallState;
}

function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): AcpToolCallState {
  const nextKind = typeof next.data.kind === "string" ? next.data.kind : undefined;
  const title = next.title ?? previous?.title;
  const status = next.status ?? previous?.status;
  const command = next.command ?? previous?.command;
  const detail = next.detail ?? previous?.detail;
  return {
    toolCallId: next.toolCallId,
    itemType: nextKind !== undefined ? next.itemType : (previous?.itemType ?? next.itemType),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data: {
      ...previous?.data,
      ...next.data,
    },
  } satisfies AcpToolCallState;
}

function parsePermissionRequest(params: unknown): {
  requestType: "exec_command_approval" | "file_read_approval" | "file_change_approval" | "unknown";
  detail?: string;
  toolCall?: AcpToolCallState;
} {
  if (!isRecord(params)) {
    return { requestType: "unknown" };
  }
  const toolCall = parseToolCallState(params.toolCall, { fallbackStatus: "pending" });
  const requestType = requestTypeFromToolKind(
    isRecord(params.toolCall) ? params.toolCall.kind : undefined,
  );
  const detail =
    toolCall?.command ??
    toolCall?.title ??
    toolCall?.detail ??
    (typeof params.sessionId === "string" ? `Session ${params.sessionId}` : undefined);
  return {
    requestType,
    ...(detail ? { detail } : {}),
    ...(toolCall ? { toolCall } : {}),
  };
}

function parseSessionModeState(raw: unknown): AcpSessionModeState | undefined {
  if (!isRecord(raw)) return undefined;
  const modes = isRecord(raw.modes) ? raw.modes : raw;
  const currentModeId =
    typeof modes.currentModeId === "string" && modes.currentModeId.trim().length > 0
      ? modes.currentModeId.trim()
      : undefined;
  if (!currentModeId) {
    return undefined;
  }
  const rawModes = modes.availableModes;
  if (!Array.isArray(rawModes)) {
    return undefined;
  }
  const availableModes = rawModes
    .map((mode) => {
      if (!isRecord(mode)) return undefined;
      const id = typeof mode.id === "string" ? mode.id.trim() : "";
      const name = typeof mode.name === "string" ? mode.name.trim() : "";
      if (!id || !name) {
        return undefined;
      }
      const description =
        typeof mode.description === "string" && mode.description.trim().length > 0
          ? mode.description.trim()
          : undefined;
      return description !== undefined
        ? ({ id, name, description } satisfies AcpSessionMode)
        : ({ id, name } satisfies AcpSessionMode);
    })
    .filter((mode): mode is AcpSessionMode => mode !== undefined);
  if (availableModes.length === 0) {
    return undefined;
  }
  return {
    currentModeId,
    availableModes,
  };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function updateSessionModeState(
  modeState: AcpSessionModeState | undefined,
  nextModeId: string,
): AcpSessionModeState | undefined {
  if (!modeState) {
    return undefined;
  }
  const normalizedModeId = nextModeId.trim();
  if (!normalizedModeId) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalizedModeId)
    ? {
        ...modeState,
        currentModeId: normalizedModeId,
      }
    : modeState;
}

function isMethodNotFoundRpcError(error: AcpError): boolean {
  return (
    Schema.is(AcpRpcError)(error) &&
    (error.code === -32601 || error.message.toLowerCase().includes("method not found"))
  );
}

function parseSessionUpdate(params: unknown): {
  sessionUpdate?: string;
  text?: string;
  modeId?: string;
  plan?: {
    explanation?: string | null;
    plan: ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }>;
  };
  toolCall?: AcpToolCallState;
} {
  if (!isRecord(params)) return {};
  const upd = params.update;
  if (!isRecord(upd)) return {};
  const su = typeof upd.sessionUpdate === "string" ? upd.sessionUpdate : undefined;
  const modeId =
    typeof upd.modeId === "string"
      ? upd.modeId
      : typeof upd.currentModeId === "string"
        ? upd.currentModeId
        : undefined;
  if (su === "plan") {
    const entries = Array.isArray(upd.entries) ? upd.entries : undefined;
    const plan =
      entries
        ?.map((entry, index) => {
          if (!isRecord(entry)) {
            return undefined;
          }
          const step =
            typeof entry.content === "string" && entry.content.trim().length > 0
              ? entry.content.trim()
              : `Step ${index + 1}`;
          return {
            step,
            status: normalizePlanStepStatus(entry.status),
          } as const;
        })
        .filter(
          (
            entry,
          ): entry is {
            step: string;
            status: "pending" | "inProgress" | "completed";
          } => entry !== undefined,
        ) ?? [];
    if (plan.length > 0) {
      const explanation =
        typeof upd.explanation === "string"
          ? upd.explanation
          : upd.explanation === null
            ? null
            : undefined;
      return {
        sessionUpdate: su,
        ...(modeId !== undefined ? { modeId } : {}),
        plan: {
          ...(explanation !== undefined ? { explanation } : {}),
          plan,
        },
      };
    }
  }
  if (su === "tool_call" || su === "tool_call_update") {
    const toolCall = parseToolCallState(
      upd,
      su === "tool_call" ? { fallbackStatus: "pending" } : undefined,
    );
    if (toolCall) {
      return {
        sessionUpdate: su,
        ...(modeId !== undefined ? { modeId } : {}),
        toolCall,
      };
    }
  }
  const content = upd.content;
  if (!isRecord(content)) {
    return {
      ...(su !== undefined ? { sessionUpdate: su } : {}),
      ...(modeId !== undefined ? { modeId } : {}),
    };
  }
  const text = typeof content.text === "string" ? content.text : undefined;
  if (su !== undefined && text !== undefined) {
    return {
      sessionUpdate: su,
      text,
      ...(modeId !== undefined ? { modeId } : {}),
    };
  }
  if (su !== undefined) {
    return {
      sessionUpdate: su,
      ...(modeId !== undefined ? { modeId } : {}),
    };
  }
  if (text !== undefined) {
    return {
      text,
      ...(modeId !== undefined ? { modeId } : {}),
    };
  }
  return {};
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly requestType:
    | "exec_command_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface CursorSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly child: ChildProcessWithoutNullStreams;
  readonly conn: AcpJsonRpcConnection;
  acpSessionId: string;
  /** ACP configId for the model selector (discovered from session/new configOptions). */
  modelConfigId: string | undefined;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly toolCalls: Map<string, AcpToolCallState>;
  modeState: AcpSessionModeState | undefined;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

function makeCursorAdapter(options?: CursorAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettingsService = yield* ServerSettingsService;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const emitPlanUpdate = (
      ctx: CursorSessionContext,
      payload: {
        explanation?: string | null;
        plan: ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.cursor.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.plan.updated",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          payload,
          raw: {
            source,
            method,
            payload: rawPayload,
          },
        });
      });

    const emitToolCallEvent = (
      ctx: CursorSessionContext,
      toolCall: AcpToolCallState,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const runtimeStatus = runtimeItemStatusFromToolCallStatus(toolCall.status);
        const payload = {
          itemType: toolCall.itemType,
          ...(runtimeStatus ? { status: runtimeStatus } : {}),
          ...(toolCall.title ? { title: toolCall.title } : {}),
          ...(toolCall.detail ? { detail: toolCall.detail } : {}),
          ...(Object.keys(toolCall.data).length > 0 ? { data: toolCall.data } : {}),
        };
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type:
            toolCall.status === "completed" || toolCall.status === "failed"
              ? "item.completed"
              : "item.updated",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          itemId: RuntimeItemId.makeUnsafe(toolCall.toolCallId),
          payload,
          raw: {
            source: "acp.jsonrpc",
            method: "session/update",
            payload: rawPayload,
          },
        });
        if (toolCall.status === "completed" || toolCall.status === "failed") {
          ctx.toolCalls.delete(toolCall.toolCallId);
        }
      });

    const setSessionMode = (ctx: CursorSessionContext, modeId: string | undefined) =>
      Effect.gen(function* () {
        const normalizedModeId = modeId?.trim();
        if (!normalizedModeId) {
          return;
        }
        if (ctx.modeState?.currentModeId === normalizedModeId) {
          return;
        }
        const setModeParams = { sessionId: ctx.acpSessionId, modeId: normalizedModeId };
        const setModeExit = yield* Effect.exit(ctx.conn.request("session/set_mode", setModeParams));
        if (Exit.isSuccess(setModeExit)) {
          ctx.modeState = updateSessionModeState(ctx.modeState, normalizedModeId);
          return;
        }
        const error = Cause.squash(setModeExit.cause) as AcpError;
        if (!isMethodNotFoundRpcError(error)) {
          return yield* mapAcpToAdapterError(ctx.threadId, "session/set_mode", error);
        }
        yield* ctx.conn
          .request("session/mode/set", {
            sessionId: ctx.acpSessionId,
            mode: normalizedModeId,
          })
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(ctx.threadId, "session/mode/set", cause),
            ),
          );
        ctx.modeState = updateSessionModeState(ctx.modeState, normalizedModeId);
      });

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.cursor.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        disposeAcpChild(ctx.child);
        sessions.delete(ctx.threadId);
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const cwd = nodePath.resolve(input.cwd.trim());
        const spawnOptions = yield* serverSettingsService.getSettings.pipe(
          Effect.map((settings) => settings.providers.cursor),
          Effect.map((cursorSettings) => ({
            command: cursorSettings.binaryPath,
            args: [
              ...(cursorSettings.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
              "acp",
            ],
            cwd,
          })),
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: error.message,
                cause: error,
              }),
          ),
        );
        const cursorModelSelection =
          input.modelSelection?.provider === "cursor" ? input.modelSelection : undefined;
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const child = yield* spawnAcpChildProcess(spawnOptions).pipe(
          Effect.mapError(
            (e) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: e.message,
                cause: e,
              }),
          ),
        );

        const conn = yield* attachAcpJsonRpcConnection(child).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Failed to attach ACP JSON-RPC to child process.",
                cause,
              }),
          ),
        );

        const ctx: CursorSessionContext = {
          threadId: input.threadId,
          session: {} as ProviderSession,
          child,
          conn,
          acpSessionId: "",
          modelConfigId: undefined,
          notificationFiber: undefined,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          toolCalls: new Map(),
          modeState: undefined,
          lastPlanFingerprint: undefined,
          activeTurnId: undefined,
          stopped: false,
        };

        const registerHandlers = (ctx: CursorSessionContext) =>
          Effect.gen(function* () {
            yield* conn.registerHandler("session/request_permission", (params, _acpId) =>
              Effect.gen(function* () {
                yield* logNative(ctx.threadId, "session/request_permission", params, "acp.jsonrpc");
                const permissionRequest = parsePermissionRequest(params);
                if (permissionRequest.toolCall) {
                  const previousToolCall = ctx.toolCalls.get(permissionRequest.toolCall.toolCallId);
                  ctx.toolCalls.set(
                    permissionRequest.toolCall.toolCallId,
                    mergeToolCallState(previousToolCall, permissionRequest.toolCall),
                  );
                }
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                ctx.pendingApprovals.set(requestId, {
                  decision,
                  requestType: permissionRequest.requestType,
                });
                const stamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "request.opened",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: {
                    requestType: permissionRequest.requestType,
                    ...(permissionRequest.detail
                      ? { detail: permissionRequest.detail }
                      : { detail: JSON.stringify(params).slice(0, 2000) }),
                    args: params,
                  },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    payload: params,
                  },
                });
                const d = yield* Deferred.await(decision);
                ctx.pendingApprovals.delete(requestId);
                const stamp2 = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "request.resolved",
                  ...stamp2,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: {
                    requestType: permissionRequest.requestType,
                    decision: d,
                  },
                });
                return {
                  outcome: { outcome: "selected", optionId: acpPermissionOutcome(d) },
                };
              }),
            );

            yield* conn.registerHandler("cursor/ask_question", (params, _acpId) =>
              Effect.gen(function* () {
                yield* logNative(
                  ctx.threadId,
                  "cursor/ask_question",
                  params,
                  "acp.cursor.extension",
                );
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                ctx.pendingUserInputs.set(requestId, { answers });
                const questions = extractAskQuestions(params);
                const stamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "user-input.requested",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw: {
                    source: "acp.cursor.extension",
                    method: "cursor/ask_question",
                    payload: params,
                  },
                });
                const a = yield* Deferred.await(answers);
                ctx.pendingUserInputs.delete(requestId);
                const stamp2 = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "user-input.resolved",
                  ...stamp2,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: a },
                });
                return { answers: a };
              }),
            );

            yield* conn.registerHandler("cursor/create_plan", (params, _acpId) =>
              Effect.gen(function* () {
                yield* logNative(
                  ctx.threadId,
                  "cursor/create_plan",
                  params,
                  "acp.cursor.extension",
                );
                const planMarkdown = extractPlanMarkdown(params);
                const stamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "turn.proposed.completed",
                  ...stamp,
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  payload: { planMarkdown },
                  raw: {
                    source: "acp.cursor.extension",
                    method: "cursor/create_plan",
                    payload: params,
                  },
                });
                return { accepted: true };
              }),
            );

            yield* conn.registerHandler("cursor/update_todos", (params, _acpId) =>
              Effect.gen(function* () {
                yield* logNative(
                  ctx.threadId,
                  "cursor/update_todos",
                  params,
                  "acp.cursor.extension",
                );
                const plan = extractTodosAsPlan(params);
                yield* emitPlanUpdate(
                  ctx,
                  plan,
                  params,
                  "acp.cursor.extension",
                  "cursor/update_todos",
                );
                return {};
              }),
            );
          });

        yield* registerHandlers(ctx);

        const init = yield* conn
          .request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "t3-code", version: "0.0.0" },
          })
          .pipe(Effect.mapError((e) => mapAcpToAdapterError(input.threadId, "initialize", e)));

        yield* conn
          .request("authenticate", { methodId: "cursor_login" })
          .pipe(Effect.mapError((e) => mapAcpToAdapterError(input.threadId, "authenticate", e)));

        const resume = parseCursorResume(input.resumeCursor);
        let acpSessionId: string;
        let sessionSetupResult: unknown = undefined;
        if (resume) {
          const loadExit = yield* Effect.exit(
            conn.request("session/load", {
              sessionId: resume.sessionId,
              cwd,
              mcpServers: [],
            }),
          );
          if (Exit.isSuccess(loadExit)) {
            acpSessionId = resume.sessionId;
            sessionSetupResult = loadExit.value;
          } else {
            const created = yield* conn
              .request("session/new", { cwd, mcpServers: [] })
              .pipe(Effect.mapError((e) => mapAcpToAdapterError(input.threadId, "session/new", e)));
            const cr = created as { sessionId?: string };
            if (typeof cr.sessionId !== "string") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/new",
                detail: "session/new missing sessionId",
                cause: created,
              });
            }
            acpSessionId = cr.sessionId;
            sessionSetupResult = created;
          }
        } else {
          const created = yield* conn
            .request("session/new", { cwd, mcpServers: [] })
            .pipe(Effect.mapError((e) => mapAcpToAdapterError(input.threadId, "session/new", e)));
          const cr = created as { sessionId?: string };
          if (typeof cr.sessionId !== "string") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/new",
              detail: "session/new missing sessionId",
              cause: created,
            });
          }
          acpSessionId = cr.sessionId;
          sessionSetupResult = created;
        }

        const now = yield* nowIso;
        const resumeCursor = {
          schemaVersion: CURSOR_RESUME_VERSION,
          sessionId: acpSessionId,
        };

        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model: cursorModelSelection?.model,
          threadId: input.threadId,
          resumeCursor,
          createdAt: now,
          updatedAt: now,
        };

        ctx.session = session;
        ctx.acpSessionId = acpSessionId;
        ctx.modelConfigId = extractModelConfigId(sessionSetupResult);
        ctx.modeState = parseSessionModeState(sessionSetupResult);

        const handleNotification = (msg: AcpInboundMessage) =>
          Effect.gen(function* () {
            if (msg._tag !== "notification" || msg.method !== "session/update") return;
            yield* logNative(ctx.threadId, "session/update", msg.params, "acp.jsonrpc");
            const p = parseSessionUpdate(msg.params);
            if (p.modeId) {
              ctx.modeState = updateSessionModeState(ctx.modeState, p.modeId);
            }
            if (p.sessionUpdate === "plan" && p.plan) {
              yield* emitPlanUpdate(ctx, p.plan, msg.params, "acp.jsonrpc", "session/update");
            }
            if (
              (p.sessionUpdate === "tool_call" || p.sessionUpdate === "tool_call_update") &&
              p.toolCall
            ) {
              const previousToolCall = ctx.toolCalls.get(p.toolCall.toolCallId);
              const mergedToolCall = mergeToolCallState(previousToolCall, p.toolCall);
              ctx.toolCalls.set(mergedToolCall.toolCallId, mergedToolCall);
              yield* emitToolCallEvent(ctx, mergedToolCall, msg.params);
            }
            if (
              (p.sessionUpdate === "agent_message_chunk" ||
                p.sessionUpdate === "assistant_message_chunk") &&
              p.text
            ) {
              const stamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "content.delta",
                ...stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                payload: {
                  streamKind: "assistant_text",
                  delta: p.text,
                },
                raw: {
                  source: "acp.jsonrpc",
                  method: "session/update",
                  payload: msg.params,
                },
              });
            }
          });

        const nf = yield* Stream.runDrain(
          Stream.mapEffect(conn.notifications, handleNotification),
        ).pipe(Effect.forkChild);

        ctx.notificationFiber = nf;
        sessions.set(input.threadId, ctx);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          ...stamp,
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: init },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Cursor ACP session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: acpSessionId },
        });

        return session;
      });

    const setSessionModel = (ctx: CursorSessionContext, model: string) =>
      Effect.gen(function* () {
        const configId = ctx.modelConfigId ?? "model";
        yield* ctx.conn
          .request("session/set_config_option", {
            sessionId: ctx.acpSessionId,
            configId,
            value: model,
          })
          .pipe(Effect.ignore);
        ctx.session = { ...ctx.session, model, updatedAt: yield* nowIso };
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === "cursor" ? input.modelSelection : undefined;
        const model = resolveCursorAcpModelId(
          turnModelSelection?.model ?? ctx.session.model,
          turnModelSelection?.options,
        );

        yield* setSessionModel(ctx, model);
        ctx.activeTurnId = turnId;
        ctx.lastPlanFingerprint = undefined;
        ctx.toolCalls.clear();
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        const requestedModeId = resolveRequestedModeId({
          interactionMode: input.interactionMode,
          runtimeMode: ctx.session.runtimeMode,
          modeState: ctx.modeState,
        });
        yield* Effect.ignore(setSessionMode(ctx, requestedModeId));

        const stampStart = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...stampStart,
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model },
        });

        const promptParts: Array<Record<string, unknown>> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: toMessage(cause, "Failed to read attachment."),
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              image: {
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              },
            });
          }
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const result = yield* ctx.conn
          .request("session/prompt", {
            sessionId: ctx.acpSessionId,
            prompt: promptParts,
          })
          .pipe(Effect.mapError((e) => mapAcpToAdapterError(input.threadId, "session/prompt", e)));

        ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          model,
        };

        const pr = result as { stopReason?: string | null };
        const stampEnd = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...stampEnd,
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: "completed",
            stopReason: pr.stopReason ?? null,
          },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* Effect.ignore(ctx.conn.request("session/cancel", { sessionId: ctx.acpSessionId }));
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
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

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor/ask_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns,
        };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      });

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CursorAdapterShape;
  });
}

function extractAskQuestions(params: unknown): ReadonlyArray<UserInputQuestion> {
  if (!isRecord(params)) return [];
  const qs = params.questions ?? params.question;
  if (!Array.isArray(qs)) return [];
  const out: UserInputQuestion[] = [];
  for (const q of qs) {
    if (!isRecord(q)) continue;
    const id = typeof q.id === "string" ? q.id : "question";
    const header = typeof q.header === "string" ? q.header : "Question";
    const question = typeof q.question === "string" ? q.question : "";
    const rawOpts = q.options;
    const options: Array<{ label: string; description: string }> = [];
    if (Array.isArray(rawOpts)) {
      for (const o of rawOpts) {
        if (!isRecord(o)) continue;
        const label = typeof o.label === "string" ? o.label : "Option";
        const description = typeof o.description === "string" ? o.description : label;
        options.push({ label, description });
      }
    }
    if (options.length === 0) {
      options.push({ label: "OK", description: "Continue" });
    }
    out.push({ id, header, question, options });
  }
  return out.length > 0
    ? out
    : [{ id: "q1", header: "Input", question: "?", options: [{ label: "OK", description: "OK" }] }];
}

function extractPlanMarkdown(params: unknown): string {
  if (!isRecord(params)) return "";
  const pm =
    typeof params.plan === "string"
      ? params.plan
      : typeof params.planMarkdown === "string"
        ? params.planMarkdown
        : typeof params.markdown === "string"
          ? params.markdown
          : "";
  return pm || "# Plan\n\n(Cursor did not supply plan text.)";
}

function extractTodosAsPlan(params: unknown): {
  explanation?: string;
  plan: ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }>;
} {
  if (!isRecord(params)) {
    return { plan: [] };
  }
  const todos = params.todos ?? params.items;
  if (!Array.isArray(todos)) {
    return { plan: [] };
  }
  const plan = todos.map((t, i) => {
    if (!isRecord(t)) {
      return { step: `Step ${i + 1}`, status: "pending" as const };
    }
    const step =
      typeof t.content === "string"
        ? t.content
        : typeof t.title === "string"
          ? t.title
          : `Step ${i + 1}`;
    const st = t.status;
    const status = normalizePlanStepStatus(st);
    return { step, status };
  });
  return { plan };
}

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapter());

export function makeCursorAdapterLive(opts?: CursorAdapterLiveOptions) {
  return Layer.effect(CursorAdapter, makeCursorAdapter(opts));
}
