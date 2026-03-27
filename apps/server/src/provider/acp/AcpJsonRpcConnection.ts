import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import {
  AcpError,
  AcpParseError,
  AcpProcessExitedError,
  AcpRpcError,
  AcpSpawnError,
} from "./AcpErrors.ts";
import {
  decodeAcpInboundFromJsonLine,
  type AcpInboundMessage,
  type AcpServerRequestHandler,
  type AcpSpawnInput,
} from "./AcpTypes.ts";

const JSON_RPC_VERSION = "2.0";

function parseInboundLine(line: string): Effect.Effect<AcpInboundMessage | null, AcpParseError> {
  const trimmed = line.trim();
  if (!trimmed) {
    return Effect.succeed(null);
  }
  const lineSnippet = trimmed.slice(0, 500);
  return decodeAcpInboundFromJsonLine(trimmed).pipe(
    Effect.mapError((cause) => new AcpParseError({ line: lineSnippet, cause })),
  );
}

export interface AcpJsonRpcConnection {
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, AcpError>;
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, AcpError>;
  readonly registerHandler: (
    method: string,
    handler: AcpServerRequestHandler,
  ) => Effect.Effect<void>;
  readonly notifications: Stream.Stream<AcpInboundMessage, never>;
}

export function spawnAcpChildProcess(
  input: AcpSpawnInput,
): Effect.Effect<ChildProcessWithoutNullStreams, AcpSpawnError, never> {
  const shell = process.platform === "win32";
  return Effect.try({
    try: () => {
      const c = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdio: ["pipe", "pipe", "inherit"],
        shell,
      });
      if (!c.stdin || !c.stdout) {
        throw new Error("Child process missing stdio pipes.");
      }
      return c as unknown as ChildProcessWithoutNullStreams;
    },
    catch: (cause) => new AcpSpawnError({ command: input.command, args: input.args, shell, cause }),
  });
}

export function disposeAcpChild(child: ChildProcessWithoutNullStreams) {
  try {
    child.stdin?.end();
  } catch {
    /* ignore */
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

/**
 * Attach JSON-RPC framing to an existing child process (caller owns spawn/kill).
 */
export const attachAcpJsonRpcConnection = (
  child: ChildProcessWithoutNullStreams,
): Effect.Effect<AcpJsonRpcConnection, never, never> =>
  Effect.gen(function* () {
    const writeLock = yield* Semaphore.make(1);
    const pending = yield* Ref.make(
      new Map<number | string, Deferred.Deferred<unknown, AcpError>>(),
    );
    const handlers = yield* Ref.make(new Map<string, AcpServerRequestHandler>());
    const nextId = yield* Ref.make(1);
    const notificationQueue = yield* Queue.unbounded<AcpInboundMessage>();

    const failAllPending = (error: AcpError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((map) =>
          Effect.forEach([...map.values()], (def) => Deferred.fail(def, error), {
            discard: true,
          }),
        ),
        Effect.tap(() => Ref.set(pending, new Map())),
      );

    const writeRawLine = (payload: Record<string, unknown>) =>
      Effect.try({
        try: () => {
          child.stdin.write(`${JSON.stringify(payload)}\n`);
        },
        catch: (cause) =>
          new AcpSpawnError({
            cause,
          }),
      });

    const writeSerialized = (payload: Record<string, unknown>) =>
      writeLock.withPermits(1)(writeRawLine(payload));

    const sendRequest = (method: string, params?: unknown) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown, AcpError>();
        yield* writeLock.withPermits(1)(
          Effect.gen(function* () {
            const id = yield* Ref.get(nextId);
            yield* Ref.set(nextId, id + 1);
            yield* Ref.update(pending, (map) => new Map(map).set(id, deferred));
            yield* writeRawLine({
              jsonrpc: JSON_RPC_VERSION,
              id,
              method,
              ...(params !== undefined ? { params } : {}),
            });
          }),
        );
        return yield* Deferred.await(deferred);
      });

    const sendNotify = (method: string, params?: unknown) =>
      writeSerialized({
        jsonrpc: JSON_RPC_VERSION,
        method,
        ...(params !== undefined ? { params } : {}),
      }).pipe(Effect.asVoid);

    const respondResult = (id: number | string, result: unknown) =>
      writeSerialized({ jsonrpc: JSON_RPC_VERSION, id, result });

    const respondError = (id: number | string, message: string, code = -32601) =>
      writeSerialized({
        jsonrpc: JSON_RPC_VERSION,
        id,
        error: { code, message },
      });

    const handleOneLine = (line: string): Effect.Effect<void, AcpError> =>
      Effect.gen(function* () {
        const parseExit = yield* parseInboundLine(line).pipe(Effect.exit);
        if (Exit.isFailure(parseExit)) {
          return;
        }
        if (parseExit.value === null) {
          return;
        }
        const msg = parseExit.value;

        if (msg._tag === "response") {
          const map = yield* Ref.get(pending);
          const def = map.get(msg.id);
          if (!def) return;
          const next = new Map(map);
          next.delete(msg.id);
          yield* Ref.set(pending, next);
          if (msg.error) {
            yield* Deferred.fail(
              def,
              new AcpRpcError({
                code: msg.error.code,
                ...(msg.error.data !== undefined ? { data: msg.error.data } : {}),
              }),
            );
          } else {
            yield* Deferred.succeed(def, msg.result);
          }
          return;
        }

        if (msg._tag === "notification") {
          yield* Queue.offer(notificationQueue, msg);
          return;
        }

        const handlerMap = yield* Ref.get(handlers);
        const handler = handlerMap.get(msg.method);
        if (!handler) {
          yield* respondError(msg.id, `Method not found: ${msg.method}`);
          return;
        }

        const exit = yield* Effect.exit(handler(msg.params, msg.id));
        if (Exit.isSuccess(exit)) {
          yield* respondResult(msg.id, exit.value);
        } else {
          const left = Cause.squash(exit.cause);
          yield* respondError(msg.id, Schema.is(AcpError)(left) ? left.message : String(left));
        }
      });

    yield* Effect.sync(() => {
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const err = new AcpProcessExitedError({ code, signal });
        void Effect.runPromise(
          failAllPending(err).pipe(Effect.tap(() => Queue.shutdown(notificationQueue))),
        ).catch(() => {
          /* ignore shutdown races */
        });
      });
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    yield* Effect.sync(() => {
      rl.on("line", (ln: string) => {
        void Effect.runPromise(handleOneLine(ln)).catch(() => {
          /* parse/handler errors are non-fatal for the transport */
        });
      });
    });

    const registerHandler = (method: string, handler: AcpServerRequestHandler) =>
      Ref.update(handlers, (map) => new Map(map).set(method, handler));

    return {
      request: sendRequest,
      notify: sendNotify,
      registerHandler,
      notifications: Stream.fromQueue(notificationQueue),
    } satisfies AcpJsonRpcConnection;
  });

/**
 * Spawns an ACP agent process and exposes NDJSON JSON-RPC over stdio.
 * Run under `Effect.scoped` so the child is disposed when the scope ends.
 */
export const makeAcpJsonRpcConnection = (
  input: AcpSpawnInput,
): Effect.Effect<AcpJsonRpcConnection, AcpSpawnError, Scope.Scope> =>
  Effect.acquireRelease(spawnAcpChildProcess(input), (child) =>
    Effect.sync(() => disposeAcpChild(child)),
  ).pipe(Effect.flatMap(attachAcpJsonRpcConnection));
