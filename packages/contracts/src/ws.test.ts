import { describe, expect, it } from "vitest";

import {
  WS_CLOSE_CODES,
  WS_CLOSE_REASONS,
  WS_EVENT_CHANNELS,
  wsClientMessageSchema,
  wsServerMessageSchema,
} from "./ws";

describe("wsClientMessageSchema", () => {
  it("accepts request messages", () => {
    const parsed = wsClientMessageSchema.parse({
      type: "request",
      id: "req-1",
      method: "providers.startSession",
      params: { provider: "codex" },
    });

    expect(parsed.method).toBe("providers.startSession");
  });

  it("rejects empty request ids", () => {
    expect(() =>
      wsClientMessageSchema.parse({
        type: "request",
        id: "",
        method: "providers.startSession",
      }),
    ).toThrow();
  });

  it("rejects empty request methods", () => {
    expect(() =>
      wsClientMessageSchema.parse({
        type: "request",
        id: "req-1",
        method: "",
      }),
    ).toThrow();
  });
});

describe("wsServerMessageSchema", () => {
  it("accepts successful response messages", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "response",
      id: "req-1",
      ok: true,
      result: { sessionId: "sess-1" },
    });

    expect(parsed.type).toBe("response");
  });

  it("requires errors for failed responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: false,
      }),
    ).toThrow();
  });

  it("requires result for successful responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: true,
      }),
    ).toThrow();
  });

  it("rejects errors for successful responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: true,
        result: { status: "ok" },
        error: {
          code: "unexpected",
          message: "should-not-be-present",
        },
      }),
    ).toThrow();
  });

  it("rejects result payloads for failed responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: false,
        result: { status: "unexpected" },
        error: {
          code: "request_failed",
          message: "expected-failure",
        },
      }),
    ).toThrow();
  });

  it("accepts typed event channels", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "event",
      channel: WS_EVENT_CHANNELS.providerEvent,
      payload: { id: "evt-1" },
    });

    expect(parsed.type).toBe("event");
  });

  it("rejects unknown event channels", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "event",
        channel: "provider:unknown",
        payload: {},
      }),
    ).toThrow();
  });

  it("accepts hello server messages", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "hello",
      version: 1,
      launchCwd: "/workspace",
    });

    expect(parsed.type).toBe("hello");
  });

  it("rejects hello messages with unsupported versions", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "hello",
        version: 2,
        launchCwd: "/workspace",
      }),
    ).toThrow();
  });
});

describe("ws close metadata", () => {
  it("exposes stable unauthorized close semantics", () => {
    expect(WS_CLOSE_CODES.unauthorized).toBe(4001);
    expect(WS_CLOSE_REASONS.unauthorized).toBe("unauthorized");
  });

  it("exposes stable replacement close semantics", () => {
    expect(WS_CLOSE_CODES.replacedByNewClient).toBe(4000);
    expect(WS_CLOSE_REASONS.replacedByNewClient).toBe("replaced-by-new-client");
  });

  it("keeps close codes and reasons unique", () => {
    expect(
      new Set([WS_CLOSE_CODES.unauthorized, WS_CLOSE_CODES.replacedByNewClient]).size,
    ).toBe(2);
    expect(
      new Set([WS_CLOSE_REASONS.unauthorized, WS_CLOSE_REASONS.replacedByNewClient]).size,
    ).toBe(2);
  });
});
