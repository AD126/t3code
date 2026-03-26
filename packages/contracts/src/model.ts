import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";
import cursorCliModels from "./cursorCliModels.json" with { type: "json" };

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];

/** Cursor “reasoning” tier for GPT‑5.3 Codex–style families (encoded in model slug). */
export const CURSOR_REASONING_OPTIONS = ["low", "normal", "high", "xhigh"] as const;
export type CursorReasoningOption = (typeof CURSOR_REASONING_OPTIONS)[number];

export type ProviderReasoningEffort =
  | CodexReasoningEffort
  | ClaudeCodeEffort
  | CursorReasoningOption;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const CURSOR_CLAUDE_OPUS_TIER_OPTIONS = ["high", "max"] as const;
export type CursorClaudeOpusTier = (typeof CURSOR_CLAUDE_OPUS_TIER_OPTIONS)[number];

export const CursorModelOptions = Schema.Struct({
  reasoning: Schema.optional(Schema.Literals(CURSOR_REASONING_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Boolean),
  claudeOpusTier: Schema.optional(Schema.Literals(CURSOR_CLAUDE_OPUS_TIER_OPTIONS)),
});
export type CursorModelOptions = typeof CursorModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
  cursor: Schema.optional(CursorModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

export const ContextWindowOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type ContextWindowOption = typeof ContextWindowOption.Type;

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  supportsThinkingToggle: Schema.Boolean,
  contextWindowOptions: Schema.Array(ContextWindowOption),
  promptInjectedEffortLevels: Schema.Array(TrimmedNonEmptyString),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

export type ModelOption = {
  readonly slug: string;
  readonly name: string;
};

type CursorModelFamilyOption = {
  readonly slug: string;
  readonly name: string;
};

/**
 * High-level families shown in the Cursor provider submenu (traits refine the concrete slug).
 * Slug ids are aligned with `agent models` where possible; synthetic keys (`gpt-5.4-1m`, `claude-4.6-opus`,
 * `claude-4.6-sonnet`) are not standalone CLI models — see `packages/shared` resolvers.
 *
 * Note: `agent models` had no `premium`, `composer-1`, or Claude Haiku 4.5 ids at snapshot time
 * (`packages/contracts/src/cursorCliModels.json`).
 */
export const CURSOR_MODEL_FAMILY_OPTIONS = [
  { slug: "auto", name: "Auto" },
  { slug: "composer-2", name: "Composer 2" },
  { slug: "composer-1.5", name: "Composer 1.5" },
  { slug: "gpt-5.3-codex", name: "Codex 5.3" },
  { slug: "gpt-5.3-codex-spark-preview", name: "Codex 5.3 Spark" },
  { slug: "gpt-5.4-1m", name: "GPT 5.4" },
  { slug: "claude-4.6-opus", name: "Claude Opus 4.6" },
  { slug: "claude-4.6-sonnet", name: "Claude Sonnet 4.6" },
  { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
] as const satisfies readonly CursorModelFamilyOption[];

export type CursorModelFamily = (typeof CURSOR_MODEL_FAMILY_OPTIONS)[number]["slug"];

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
  ],
  claudeAgent: [
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  cursor: cursorCliModels.models.map((m) => ({
    slug: m.id,
    name: m.label,
  })) satisfies ReadonlyArray<ModelOption>,
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

export type ModelSlug = string & {};

/** Any built-in id returned by the Cursor CLI for `--model` (see `cursorCliModels.json`). */
export type CursorModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)["cursor"][number]["slug"];

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, ModelSlug> = {
  codex: "gpt-5.4",
  claudeAgent: "claude-sonnet-4-6",
  cursor: "claude-4.6-opus-high-thinking",
};

export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

/** Per-provider text generation model defaults. */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
  cursor: "composer-2-fast",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, string>> = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    opus: "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  cursor: {
    composer: "composer-1.5",
    "composer-1.5": "composer-1.5",
    /** Legacy picker id; CLI exposes `composer-1.5` / `composer-2` only. */
    "composer-1": "composer-1.5",
    "gpt-5.3-codex": "gpt-5.3-codex",
    "gpt-5.3-codex-spark": "gpt-5.3-codex-spark-preview",
    "gemini-3.1-pro": "gemini-3.1-pro",
    /** @deprecated Pre–CLI-slug aliases used by older T3 builds. */
    "opus-4.6-thinking": "claude-4.6-opus-high-thinking",
    "opus-4.6": "claude-4.6-opus-high",
    "sonnet-4.6-thinking": "claude-4.6-sonnet-medium-thinking",
    "sonnet-4.6": "claude-4.6-sonnet-medium",
    "opus-4.5-thinking": "claude-4.5-opus-high-thinking",
    "opus-4.5": "claude-4.5-opus-high",
    /** @deprecated Legacy default label; maps to the current Cursor CLI default. */
    default: "claude-4.6-opus-high-thinking",
    auto: "auto",
  },
};

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
};

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  claudeAgent: CLAUDE_CODE_EFFORT_OPTIONS,
  cursor: CURSOR_REASONING_OPTIONS,
} as const satisfies Record<ProviderKind, readonly ProviderReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  claudeAgent: "high",
  cursor: "normal",
} as const satisfies Record<ProviderKind, ProviderReasoningEffort>;
