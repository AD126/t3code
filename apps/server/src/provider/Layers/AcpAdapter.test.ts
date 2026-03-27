import { assert, beforeEach, describe, it, vi } from "vitest";

import { type AcpAgentServer, ThreadId } from "@t3tools/contracts";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";

import type { AcpInboundMessage } from "../acp/AcpTypes.ts";
import { AcpAdapter } from "../Services/AcpAdapter.ts";
import { AcpAgentRegistry } from "../Services/AcpAgentRegistry.ts";

const transportState: {
  requestCalls: Array<{ method: string; params: unknown }>;
  notifyCalls: Array<{ method: string; params: unknown }>;
  notificationQueue: Queue.Queue<AcpInboundMessage> | null;
} = {
  requestCalls: [],
  notifyCalls: [],
  notificationQueue: null,
};

vi.mock("../acp/AcpJsonRpcConnection.ts", async () => {
  const { Effect, Queue, Stream } = await import("effect");

  return {
    spawnAcpChildProcess: vi.fn(() =>
      Effect.succeed({
        stdin: { end: vi.fn() },
        stdout: {},
        kill: vi.fn(),
      }),
    ),
    attachAcpJsonRpcConnection: vi.fn(() =>
      Effect.gen(function* () {
        const notificationQueue = yield* Queue.unbounded<AcpInboundMessage>();
        transportState.notificationQueue = notificationQueue;

        return {
          request: (method: string, params?: unknown) =>
            Effect.gen(function* () {
              transportState.requestCalls.push({ method, params });
              switch (method) {
                case "initialize":
                  return { protocolVersion: 1 };
                case "session/new":
                  return { sessionId: "session-1" };
                case "session/prompt":
                  yield* Queue.offer(notificationQueue, {
                    _tag: "notification",
                    method: "session/update",
                    params: {
                      sessionId: "session-1",
                      update: {
                        sessionUpdate: "assistant_message_chunk",
                        content: { type: "text", text: "hi" },
                      },
                    },
                  });
                  return { stopReason: "end_turn" };
                case "session/cancel":
                  return {};
                default:
                  return {};
              }
            }),
          notify: (method: string, params?: unknown) =>
            Effect.sync(() => {
              transportState.notifyCalls.push({ method, params });
            }),
          registerHandler: () => Effect.void,
          notifications: Stream.fromQueue(notificationQueue),
        };
      }),
    ),
    disposeAcpChild: vi.fn(() => undefined),
  };
});

import { makeAcpAdapterLive } from "./AcpAdapter.ts";

describe("AcpAdapterLive", () => {
  beforeEach(() => {
    transportState.requestCalls = [];
    transportState.notifyCalls = [];
    transportState.notificationQueue = null;
  });

  it("writes native ACP observability records for inbound notifications and responses", async () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        kind?: string;
        method?: string;
      };
    }> = [];
    const threadId = ThreadId.makeUnsafe("thread-acp-native");
    const agentServer: AcpAgentServer = {
      id: "agent-1",
      name: "Agent 1",
      enabled: true,
      source: "manual",
      distributionType: "manual",
      launch: { command: "npx", args: ["-y", "agent-1"] },
    };

    const adapterLayer = makeAcpAdapterLive({
      nativeEventLogger: {
        filePath: "memory://acp-native-events",
        write: (event, loggedThreadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          assert.equal(loggedThreadId, threadId);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(AcpAgentRegistry, {
          getAgentServers: Effect.succeed([agentServer]),
          listStatuses: Effect.succeed([]),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AcpAdapter;
        const session = yield* adapter.startSession({
          threadId,
          provider: "acp",
          modelSelection: { provider: "acp", agentServerId: "agent-1", model: "default" },
          runtimeMode: "full-access",
        });
        const deltaEventFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "content.delta"),
          Stream.runHead,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });
        yield* adapter.interruptTurn(session.threadId);
        const deltaEvent = yield* Fiber.join(deltaEventFiber);
        return { turn, deltaEvent };
      }).pipe(Effect.provide(adapterLayer)),
    );

    assert.equal(result.deltaEvent._tag, "Some");
    if (result.deltaEvent._tag === "Some") {
      assert.equal(result.deltaEvent.value.type, "content.delta");
      if (result.deltaEvent.value.type === "content.delta") {
        assert.equal(result.deltaEvent.value.payload.delta, "hi");
      }
    }
    assert.equal(
      transportState.requestCalls.map((call) => call.method).join(","),
      "initialize,session/new,session/prompt",
    );
    assert.deepEqual(transportState.notifyCalls, [
      {
        method: "session/cancel",
        params: { sessionId: "session-1" },
      },
    ]);
    assert.equal(nativeEvents.length > 0, true);
    assert.equal(
      nativeEvents.some(
        (record) =>
          record.event?.provider === "acp" &&
          record.event?.kind === "notification" &&
          record.event?.method === "session/update",
      ),
      true,
    );
    assert.equal(
      nativeEvents.some(
        (record) =>
          record.event?.provider === "acp" &&
          record.event?.kind === "response" &&
          record.event?.method === "session/prompt",
      ),
      true,
    );
  });
});
