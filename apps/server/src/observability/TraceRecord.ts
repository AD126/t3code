import { Cause, Exit, Option, Schema, Tracer } from "effect";

import { compactTraceAttributes } from "./Attributes.ts";

export interface EffectTraceRecord {
  readonly type: "effect-span";
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<{
    readonly name: string;
    readonly timeUnixNano: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
  readonly links: ReadonlyArray<{
    readonly traceId: string;
    readonly spanId: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
  readonly exit:
    | {
        readonly _tag: "Success";
      }
    | {
        readonly _tag: "Interrupted";
        readonly cause: string;
      }
    | {
        readonly _tag: "Failure";
        readonly cause: string;
      };
}

export interface OtlpTraceRecord {
  readonly type: "otlp-span";
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly kind: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scope: Readonly<{
    readonly name?: string;
    readonly version?: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
  readonly events: ReadonlyArray<{
    readonly name: string;
    readonly timeUnixNano: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
  readonly links: ReadonlyArray<{
    readonly traceId: string;
    readonly spanId: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
  readonly status?:
    | {
        readonly code?: string;
        readonly message?: string;
      }
    | undefined;
}

export type TraceRecord = EffectTraceRecord | OtlpTraceRecord;

const OtlpNumberishSchema = Schema.Union([Schema.String, Schema.Number]);
type OtlpUnknownRecord = Readonly<Record<string, unknown>>;

const OtlpSpanSchema = Schema.Struct({
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
  parentSpanId: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(OtlpNumberishSchema),
  startTimeUnixNano: Schema.optionalKey(OtlpNumberishSchema),
  endTimeUnixNano: Schema.optionalKey(OtlpNumberishSchema),
  attributes: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  events: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  links: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  status: Schema.optionalKey(Schema.Unknown),
  flags: Schema.optionalKey(OtlpNumberishSchema),
});
type OtlpSpan = typeof OtlpSpanSchema.Type;

const OtlpInstrumentationScopeSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  attributes: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const OtlpScopeSpansSchema = Schema.Struct({
  scope: Schema.optionalKey(OtlpInstrumentationScopeSchema),
  spans: Schema.Array(OtlpSpanSchema),
});

const OtlpResourceSchema = Schema.Struct({
  attributes: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const OtlpResourceSpansSchema = Schema.Struct({
  resource: Schema.optionalKey(OtlpResourceSchema),
  scopeSpans: Schema.Array(OtlpScopeSpansSchema),
});

export const OtlpTracePayloadSchema = Schema.Struct({
  resourceSpans: Schema.Array(OtlpResourceSpansSchema),
});
export type OtlpTracePayload = typeof OtlpTracePayloadSchema.Type;

interface OtlpKeyValue {
  readonly key: string;
  readonly value: unknown;
}

interface SerializableSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly status: Tracer.SpanStatus;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly links: ReadonlyArray<Tracer.SpanLink>;
  readonly events: ReadonlyArray<
    readonly [name: string, startTime: bigint, attributes: Record<string, unknown>]
  >;
}

function formatTraceExit(exit: Exit.Exit<unknown, unknown>): EffectTraceRecord["exit"] {
  if (Exit.isSuccess(exit)) {
    return { _tag: "Success" };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      _tag: "Interrupted",
      cause: Cause.pretty(exit.cause),
    };
  }
  return {
    _tag: "Failure",
    cause: Cause.pretty(exit.cause),
  };
}

export function spanToTraceRecord(span: SerializableSpan): EffectTraceRecord {
  const status = span.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>;
  const parentSpanId = Option.getOrUndefined(span.parent)?.spanId;

  return {
    type: "effect-span",
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    sampled: span.sampled,
    kind: span.kind,
    startTimeUnixNano: String(status.startTime),
    endTimeUnixNano: String(status.endTime),
    durationMs: Number(status.endTime - status.startTime) / 1_000_000,
    attributes: compactTraceAttributes(Object.fromEntries(span.attributes)),
    events: span.events.map(([name, startTime, attributes]) => ({
      name,
      timeUnixNano: String(startTime),
      attributes: compactTraceAttributes(attributes),
    })),
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: compactTraceAttributes(link.attributes),
    })),
    exit: formatTraceExit(status.exit),
  };
}

const SPAN_KIND_MAP: Record<number, OtlpTraceRecord["kind"]> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

export function decodeOtlpTraceRecords(payload: OtlpTracePayload): ReadonlyArray<OtlpTraceRecord> {
  const records: Array<OtlpTraceRecord> = [];

  for (const resourceSpan of payload.resourceSpans) {
    const resourceAttributes = decodeAttributes(resourceSpan.resource?.attributes ?? []);

    for (const scopeSpan of resourceSpan.scopeSpans) {
      const scope = scopeSpan.scope;
      const scopeAttributes = decodeAttributes(scope?.attributes ?? []);

      for (const span of scopeSpan.spans) {
        const traceId = asNonEmptyString(span.traceId);
        const spanId = asNonEmptyString(span.spanId);
        if (!traceId || !spanId) {
          continue;
        }

        records.push(
          otlpSpanToTraceRecord({
            resourceAttributes,
            scopeAttributes,
            scopeName: asNonEmptyString(scope?.name),
            scopeVersion: asNonEmptyString(scope?.version),
            span,
          }),
        );
      }
    }
  }

  return records;
}

function otlpSpanToTraceRecord(input: {
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scopeAttributes: Readonly<Record<string, unknown>>;
  readonly scopeName: string | undefined;
  readonly scopeVersion: string | undefined;
  readonly span: OtlpSpan;
}): OtlpTraceRecord {
  const startTimeUnixNano = asString(input.span.startTimeUnixNano) ?? "0";
  const endTimeUnixNano = asString(input.span.endTimeUnixNano) ?? startTimeUnixNano;

  return {
    type: "otlp-span",
    name: asNonEmptyString(input.span.name) ?? "unknown",
    traceId: asNonEmptyString(input.span.traceId) ?? "",
    spanId: asNonEmptyString(input.span.spanId) ?? "",
    ...(asNonEmptyString(input.span.parentSpanId)
      ? { parentSpanId: asNonEmptyString(input.span.parentSpanId)! }
      : {}),
    sampled: isSampled(input.span.flags),
    kind: normalizeSpanKind(input.span.kind),
    startTimeUnixNano,
    endTimeUnixNano,
    durationMs: Number(parseBigInt(endTimeUnixNano) - parseBigInt(startTimeUnixNano)) / 1_000_000,
    attributes: decodeAttributes(input.span.attributes ?? []),
    resourceAttributes: input.resourceAttributes,
    scope: {
      ...(input.scopeName ? { name: input.scopeName } : {}),
      ...(input.scopeVersion ? { version: input.scopeVersion } : {}),
      attributes: input.scopeAttributes,
    },
    events: decodeEvents(input.span.events ?? []),
    links: decodeLinks(input.span.links ?? []),
    status: decodeStatus(input.span.status),
  };
}

function decodeStatus(input: unknown): OtlpTraceRecord["status"] {
  if (!isRecord(input)) {
    return undefined;
  }

  const code = asNonEmptyString(input.code) ?? asString(input.code);
  const message = asNonEmptyString(input.message);
  if (!code && !message) {
    return undefined;
  }

  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function decodeEvents(input: ReadonlyArray<unknown>): OtlpTraceRecord["events"] {
  return input.flatMap((current) => {
    if (!isRecord(current)) {
      return [];
    }

    return [
      {
        name: asNonEmptyString(current.name) ?? "event",
        timeUnixNano: asString(current.timeUnixNano) ?? "0",
        attributes: decodeAttributes(asArray(current.attributes)),
      },
    ];
  });
}

function decodeLinks(input: ReadonlyArray<unknown>): OtlpTraceRecord["links"] {
  return input.flatMap((current) => {
    if (!isRecord(current)) {
      return [];
    }

    const traceId = asNonEmptyString(current.traceId);
    const spanId = asNonEmptyString(current.spanId);
    if (!traceId || !spanId) {
      return [];
    }

    return [
      {
        traceId,
        spanId,
        attributes: decodeAttributes(asArray(current.attributes)),
      },
    ];
  });
}

function decodeAttributes(input: ReadonlyArray<unknown>): Readonly<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};

  for (const attribute of input) {
    if (!isKeyValue(attribute)) {
      continue;
    }

    const key = asNonEmptyString(attribute.key);
    if (!key) {
      continue;
    }
    entries[key] = decodeValue(attribute.value);
  }

  return compactTraceAttributes(entries);
}

function decodeValue(input: unknown): unknown {
  if (!isRecord(input)) {
    return input ?? null;
  }
  if ("stringValue" in input) {
    return input.stringValue;
  }
  if ("boolValue" in input) {
    return input.boolValue;
  }
  if ("intValue" in input) {
    return normalizeInteger(input.intValue);
  }
  if ("doubleValue" in input) {
    return input.doubleValue;
  }
  if ("bytesValue" in input) {
    return input.bytesValue;
  }
  if (isRecord(input.arrayValue)) {
    return asArray(input.arrayValue.values).map((entry) => decodeValue(entry));
  }
  if (isRecord(input.kvlistValue)) {
    return decodeAttributes(asArray(input.kvlistValue.values));
  }
  return null;
}

function normalizeInteger(input: unknown): number | string {
  if (typeof input === "number") {
    return input;
  }
  if (typeof input !== "string") {
    return String(input ?? "");
  }

  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : input;
}

function normalizeSpanKind(input: unknown): OtlpTraceRecord["kind"] {
  if (typeof input === "string" && input.trim().length > 0) {
    return input.trim().toLowerCase();
  }
  if (typeof input === "number") {
    return SPAN_KIND_MAP[input] ?? "internal";
  }
  return "internal";
}

function isSampled(input: unknown): boolean {
  if (typeof input === "number") {
    return (input & 0x01) === 0x01;
  }
  if (typeof input === "string") {
    const parsed = Number(input);
    return Number.isNaN(parsed) ? true : (parsed & 0x01) === 0x01;
  }
  return true;
}

function parseBigInt(input: string): bigint {
  try {
    return BigInt(input);
  } catch {
    return 0n;
  }
}

function asString(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "number") {
    return String(input);
  }
  return undefined;
}

function asNonEmptyString(input: unknown): string | undefined {
  const value = asString(input)?.trim();
  return value ? value : undefined;
}

function asArray(input: unknown): ReadonlyArray<unknown> {
  return Array.isArray(input) ? input : [];
}

function isRecord(input: unknown): input is OtlpUnknownRecord {
  return typeof input === "object" && input !== null;
}

function isKeyValue(input: unknown): input is OtlpKeyValue {
  return isRecord(input) && typeof input.key === "string" && "value" in input;
}
