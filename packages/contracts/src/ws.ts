import { z } from "zod";

export const WS_EVENT_CHANNELS = {
  providerEvent: "provider:event",
  agentOutput: "agent:output",
  agentExit: "agent:exit",
} as const;

export const WS_CLOSE_CODES = {
  replacedByNewClient: 4000,
  unauthorized: 4001,
} as const;

export const WS_CLOSE_REASONS = {
  replacedByNewClient: "replaced-by-new-client",
  unauthorized: "unauthorized",
} as const;

const wsRequestSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const wsResponseErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

const wsResponseSchema = z
  .object({
    type: z.literal("response"),
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: wsResponseErrorSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.ok && value.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response.error must be undefined when ok=true",
      });
    }

    if (value.ok && value.result === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response.result is required when ok=true",
      });
    }

    if (!value.ok && !value.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response.error is required when ok=false",
      });
    }

    if (!value.ok && value.result !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response.result must be undefined when ok=false",
      });
    }
  });

const wsEventSchema = z.object({
  type: z.literal("event"),
  channel: z.enum([
    WS_EVENT_CHANNELS.providerEvent,
    WS_EVENT_CHANNELS.agentOutput,
    WS_EVENT_CHANNELS.agentExit,
  ]),
  payload: z.unknown(),
});

const wsHelloSchema = z.object({
  type: z.literal("hello"),
  version: z.literal(1),
  launchCwd: z.string().min(1),
});

export const wsClientMessageSchema = wsRequestSchema;
export const wsServerMessageSchema = z.union([wsResponseSchema, wsEventSchema, wsHelloSchema]);

export type WsEventChannel = z.infer<typeof wsEventSchema>["channel"];
export type WsRequestMessage = z.infer<typeof wsRequestSchema>;
export type WsResponseMessage = z.infer<typeof wsResponseSchema>;
export type WsEventMessage = z.infer<typeof wsEventSchema>;
export type WsHelloMessage = z.infer<typeof wsHelloSchema>;
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
