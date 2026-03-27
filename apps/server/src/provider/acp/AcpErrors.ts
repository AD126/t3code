import { Schema } from "effect";

export class AcpSpawnError extends Schema.TaggedErrorClass<AcpSpawnError>()("AcpSpawnError", {
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  shell: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect),
}) {
  override get message() {
    return `Failed to spawn ACP process: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

export class AcpParseError extends Schema.TaggedErrorClass<AcpParseError>()("AcpParseError", {
  line: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message() {
    return `Failed to parse ACP message: ${this.line}`;
  }
}
export class AcpRpcError extends Schema.TaggedErrorClass<AcpRpcError>()("AcpRpcError", {
  code: Schema.Number,
  errorMessage: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
}) {
  override get message() {
    return `Failed to send ACP RPC message (code: ${this.code}, message: ${this.errorMessage}, data: ${JSON.stringify(this.data)})`;
  }
}

export class AcpProcessExitedError extends Schema.TaggedErrorClass<AcpProcessExitedError>()(
  "AcpProcessExitedError",
  {
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
  },
) {
  override get message() {
    return `ACP process exited with code ${this.code} and signal ${this.signal}`;
  }
}

export const AcpError = Schema.Union([
  AcpSpawnError,
  AcpParseError,
  AcpRpcError,
  AcpProcessExitedError,
]);

export type AcpError = typeof AcpError.Type;
