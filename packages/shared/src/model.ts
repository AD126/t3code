import {
  CURSOR_MODEL_FAMILY_OPTIONS,
  CURSOR_REASONING_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type ClaudeCodeEffort,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type CursorClaudeOpusTier,
  type CursorModelFamily,
  type CursorModelOptions,
  type CursorModelSlug,
  type CursorReasoningOption,
  type ModelCapabilities,
  type ModelSlug,
  type ModelSelection,
  type ProviderKind,
  type ProviderReasoningEffort,
} from "@t3tools/contracts";

const MODEL_SLUG_SET_BY_PROVIDER: Record<ProviderKind, ReadonlySet<ModelSlug>> = {
  claudeAgent: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeAgent.map((option) => option.slug)),
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  cursor: new Set(MODEL_OPTIONS_BY_PROVIDER.cursor.map((option) => option.slug)),
};

type CursorModelCapability = {
  readonly supportsReasoning: boolean;
  readonly supportsFast: boolean;
  readonly supportsThinking: boolean;
  readonly supportsClaudeOpusTier: boolean;
  readonly defaultReasoning: CursorReasoningOption;
  readonly defaultThinking: boolean;
  readonly defaultClaudeOpusTier: CursorClaudeOpusTier;
};

const CURSOR_MODEL_CAPABILITY_BY_FAMILY: Record<CursorModelFamily, CursorModelCapability> = {
  auto: {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    supportsClaudeOpusTier: false,
    defaultReasoning: "normal",
    defaultThinking: false,
    defaultClaudeOpusTier: "high",
  },
  "composer-2": {
    supportsReasoning: false,
    supportsFast: true,
    supportsThinking: false,
    supportsClaudeOpusTier: false,
    defaultReasoning: "normal",
    defaultThinking: false,
    defaultClaudeOpusTier: "high",
  },
  "composer-1.5": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    supportsClaudeOpusTier: false,
    defaultReasoning: "normal",
    defaultThinking: false,
    defaultClaudeOpusTier: "high",
  },
  "gpt-5.3-codex": {
    supportsReasoning: true,
    supportsFast: true,
    supportsThinking: false,
    supportsClaudeOpusTier: false,
    defaultReasoning: "normal",
    defaultThinking: false,
    defaultClaudeOpusTier: "high",
  },
  "gpt-5.3-codex-spark-preview": {
    supportsReasoning: true,
    supportsFast: false,
    supportsThinking: false,
    supportsClaudeOpusTier: false,
    defaultReasoning: "normal",
    defaultThinking: false,
    defaultClaudeOpusTier: "high",
  },
  "gpt-5.4-1m": {
    supportsReasoning: true,
    supportsFast: true,
    supportsThinking: false,
    supportsClaudeOpusTier: false,
    defaultReasoning: "normal",
    defaultThinking: false,
    defaultClaudeOpusTier: "high",
  },
  "claude-4.6-opus": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: true,
    supportsClaudeOpusTier: true,
    defaultReasoning: "normal",
    defaultThinking: true,
    defaultClaudeOpusTier: "high",
  },
  "claude-4.6-sonnet": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: true,
    supportsClaudeOpusTier: false,
    defaultReasoning: "normal",
    defaultThinking: false,
    defaultClaudeOpusTier: "high",
  },
  "gemini-3.1-pro": {
    supportsReasoning: false,
    supportsFast: false,
    supportsThinking: false,
    supportsClaudeOpusTier: false,
    defaultReasoning: "normal",
    defaultThinking: false,
    defaultClaudeOpusTier: "high",
  },
};

const CURSOR_MODEL_FAMILY_SET = new Set<CursorModelFamily>(
  CURSOR_MODEL_FAMILY_OPTIONS.map((option) => option.slug),
);

export interface CursorModelSelection {
  readonly family: CursorModelFamily;
  readonly reasoning: CursorReasoningOption;
  readonly fast: boolean;
  readonly thinking: boolean;
  readonly claudeOpusTier: CursorClaudeOpusTier;
}

export function getCursorModelFamilyOptions() {
  return CURSOR_MODEL_FAMILY_OPTIONS;
}

export function getCursorModelCapabilities(family: CursorModelFamily) {
  return CURSOR_MODEL_CAPABILITY_BY_FAMILY[family];
}

/** Fast toggles are absent for some GPT‑5.4 1M + reasoning combinations in the live CLI model list. */
export function cursorFamilySupportsFastWithReasoning(
  family: CursorModelFamily,
  reasoning: CursorReasoningOption,
): boolean {
  if (!getCursorModelCapabilities(family).supportsFast) return false;
  if (family === "gpt-5.4-1m" && reasoning === "low") return false;
  return true;
}

function fallbackCursorModelFamily(): CursorModelFamily {
  return parseCursorModelSelection(DEFAULT_MODEL_BY_PROVIDER.cursor).family;
}

function resolveCursorModelFamily(model: string | null | undefined): CursorModelFamily {
  const normalized = normalizeModelSlug(model, "cursor");
  if (!normalized) {
    return fallbackCursorModelFamily();
  }

  if (normalized === "auto") {
    return "auto";
  }

  if (normalized === "composer-2" || normalized === "composer-2-fast") {
    return "composer-2";
  }

  if (normalized === "composer-1.5") {
    return "composer-1.5";
  }

  if (normalized.startsWith("gpt-5.3-codex-spark-preview")) {
    return "gpt-5.3-codex-spark-preview";
  }

  if (normalized.startsWith("gpt-5.3-codex")) {
    return "gpt-5.3-codex";
  }

  if (
    normalized === "gpt-5.4-low" ||
    normalized === "gpt-5.4-medium" ||
    normalized === "gpt-5.4-medium-fast" ||
    normalized === "gpt-5.4-high" ||
    normalized === "gpt-5.4-high-fast" ||
    normalized === "gpt-5.4-xhigh" ||
    normalized === "gpt-5.4-xhigh-fast"
  ) {
    return "gpt-5.4-1m";
  }

  if (normalized.startsWith("claude-4.6-opus-")) {
    return "claude-4.6-opus";
  }

  if (normalized.startsWith("claude-4.6-sonnet-")) {
    return "claude-4.6-sonnet";
  }

  if (normalized === "gemini-3.1-pro") {
    return "gemini-3.1-pro";
  }

  return CURSOR_MODEL_FAMILY_SET.has(normalized as CursorModelFamily)
    ? (normalized as CursorModelFamily)
    : fallbackCursorModelFamily();
}

function resolveCursorReasoningFromSlug(model: CursorModelSlug): CursorReasoningOption {
  if (model.includes("-xhigh")) return "xhigh";
  if (model.includes("-high")) return "high";
  if (model.includes("-low")) return "low";
  return "normal";
}

function parseClaudeOpusFromSlug(slug: string): {
  readonly tier: CursorClaudeOpusTier;
  readonly thinking: boolean;
} {
  return {
    tier: slug.includes("opus-max") ? "max" : "high",
    thinking: slug.endsWith("-thinking"),
  };
}

function mergePersistedCursorOptionsOntoSelection(
  sel: CursorModelSelection,
  cursorOpts: CursorModelOptions | null | undefined,
): CursorModelSelection {
  if (!cursorOpts) return sel;
  let next: CursorModelSelection = sel;
  if (
    typeof cursorOpts.reasoning === "string" &&
    (CURSOR_REASONING_OPTIONS as readonly string[]).includes(cursorOpts.reasoning)
  ) {
    next = { ...next, reasoning: cursorOpts.reasoning };
  }
  if (cursorOpts.fastMode === true) {
    next = { ...next, fast: true };
  }
  if (cursorOpts.fastMode === false) {
    next = { ...next, fast: false };
  }
  if (cursorOpts.thinking === true) {
    next = { ...next, thinking: true };
  }
  if (cursorOpts.thinking === false) {
    next = { ...next, thinking: false };
  }
  if (cursorOpts.claudeOpusTier === "max" || cursorOpts.claudeOpusTier === "high") {
    next = { ...next, claudeOpusTier: cursorOpts.claudeOpusTier };
  }
  return next;
}

function parseCursorModelSelectionFromSlugOnly(
  model: string | null | undefined,
): CursorModelSelection {
  const family = resolveCursorModelFamily(model);
  const capability = CURSOR_MODEL_CAPABILITY_BY_FAMILY[family];
  const normalized = resolveModelSlugForProvider("cursor", model) as CursorModelSlug;

  const base: Pick<CursorModelSelection, "reasoning" | "fast" | "thinking" | "claudeOpusTier"> = {
    reasoning: capability.defaultReasoning,
    fast: false,
    thinking: capability.defaultThinking,
    claudeOpusTier: capability.defaultClaudeOpusTier,
  };

  if (capability.supportsReasoning) {
    return {
      family,
      ...base,
      reasoning: resolveCursorReasoningFromSlug(normalized),
      fast: normalized.endsWith("-fast"),
      thinking: false,
      claudeOpusTier: "high",
    };
  }

  if (family === "claude-4.6-opus") {
    const parsed = parseClaudeOpusFromSlug(normalized);
    return {
      family,
      ...base,
      reasoning: capability.defaultReasoning,
      fast: false,
      claudeOpusTier: parsed.tier,
      thinking: parsed.thinking,
    };
  }

  if (family === "composer-2") {
    return {
      family,
      ...base,
      fast: normalized === "composer-2-fast",
      thinking: false,
      claudeOpusTier: "high",
    };
  }

  if (capability.supportsThinking) {
    return {
      family,
      ...base,
      reasoning: capability.defaultReasoning,
      fast: false,
      thinking: normalized.includes("-thinking"),
      claudeOpusTier: "high",
    };
  }

  return { family, ...base };
}

export function parseCursorModelSelection(
  model: string | null | undefined,
  cursorOpts?: CursorModelOptions | null,
): CursorModelSelection {
  return mergePersistedCursorOptionsOntoSelection(
    parseCursorModelSelectionFromSlugOnly(model),
    cursorOpts,
  );
}

/** Minimal `cursor` modelOptions for API dispatch (non-default traits only). */
export function normalizeCursorModelOptions(
  model: string | null | undefined,
  persisted: CursorModelOptions | null | undefined,
): CursorModelOptions | undefined {
  const sel = parseCursorModelSelection(model, persisted);
  const cap = getCursorModelCapabilities(sel.family);
  const defaultReasoning = DEFAULT_REASONING_EFFORT_BY_PROVIDER.cursor as CursorReasoningOption;
  const next: {
    reasoning?: CursorReasoningOption;
    fastMode?: boolean;
    thinking?: boolean;
    claudeOpusTier?: CursorClaudeOpusTier;
  } = {};
  if (cap.supportsReasoning && sel.reasoning !== defaultReasoning) {
    next.reasoning = sel.reasoning;
  }
  if (cap.supportsFast && sel.fast) {
    next.fastMode = true;
  }
  if (cap.supportsThinking && sel.thinking === false) {
    next.thinking = false;
  }
  if (cap.supportsClaudeOpusTier && sel.claudeOpusTier === "max") {
    next.claudeOpusTier = "max";
  }
  return Object.keys(next).length > 0 ? (next as CursorModelOptions) : undefined;
}

/** Persisted options for a trait selection (null = all defaults / omit from draft). */
export function cursorSelectionToPersistedModelOptions(
  sel: CursorModelSelection,
): CursorModelOptions | null {
  const cap = getCursorModelCapabilities(sel.family);
  const defaultReasoning = DEFAULT_REASONING_EFFORT_BY_PROVIDER.cursor as CursorReasoningOption;
  const next: {
    reasoning?: CursorReasoningOption;
    fastMode?: boolean;
    thinking?: boolean;
    claudeOpusTier?: CursorClaudeOpusTier;
  } = {};
  if (cap.supportsReasoning && sel.reasoning !== defaultReasoning) {
    next.reasoning = sel.reasoning;
  }
  if (cap.supportsFast && sel.fast) {
    next.fastMode = true;
  }
  if (cap.supportsThinking && sel.thinking === false) {
    next.thinking = false;
  }
  if (cap.supportsClaudeOpusTier && sel.claudeOpusTier === "max") {
    next.claudeOpusTier = "max";
  }
  return Object.keys(next).length > 0 ? (next as CursorModelOptions) : null;
}

/**
 * Resolves the concrete Cursor CLI `--model` id from the logical family key (or custom slug) plus
 * optional persisted `modelOptions.cursor` traits.
 */
export function resolveCursorDispatchModel(
  model: string | null | undefined,
  cursorOpts: CursorModelOptions | null | undefined,
): string {
  const normalized = normalizeModelSlug(model, "cursor") ?? DEFAULT_MODEL_BY_PROVIDER.cursor;
  const hasPersistedTraits = Boolean(cursorOpts && Object.keys(cursorOpts).length > 0);
  if (hasPersistedTraits && isCursorModelFamilySlug(normalized)) {
    const sel = parseCursorModelSelection(normalized, cursorOpts);
    return resolveCursorModelFromSelection(sel);
  }
  return resolveModelSlugForProvider("cursor", normalized);
}

export function resolveCursorModelFromSelection(input: {
  readonly family: CursorModelFamily;
  readonly reasoning?: CursorReasoningOption | null;
  readonly fast?: boolean | null;
  readonly thinking?: boolean | null;
  readonly claudeOpusTier?: CursorClaudeOpusTier | null;
}): CursorModelSlug {
  const family = resolveCursorModelFamily(input.family);
  const capability = CURSOR_MODEL_CAPABILITY_BY_FAMILY[family];

  if (family === "composer-2") {
    const slug = input.fast === true ? "composer-2-fast" : "composer-2";
    return resolveModelSlugForProvider("cursor", slug) as CursorModelSlug;
  }

  if (family === "gpt-5.4-1m") {
    const reasoning = CURSOR_REASONING_OPTIONS.includes(input.reasoning ?? "normal")
      ? (input.reasoning ?? "normal")
      : capability.defaultReasoning;
    const tier = reasoning === "normal" ? "medium" : reasoning;
    const base = `gpt-5.4-${tier}`;
    if (input.fast === true) {
      const fastSlug = `${base}-fast`;
      const candidate = MODEL_SLUG_SET_BY_PROVIDER.cursor.has(fastSlug) ? fastSlug : base;
      return resolveModelSlugForProvider("cursor", candidate) as CursorModelSlug;
    }
    return resolveModelSlugForProvider("cursor", base) as CursorModelSlug;
  }

  if (family === "gpt-5.3-codex-spark-preview") {
    const reasoning = CURSOR_REASONING_OPTIONS.includes(input.reasoning ?? "normal")
      ? (input.reasoning ?? "normal")
      : capability.defaultReasoning;
    const suffix = reasoning === "normal" ? "" : `-${reasoning}`;
    const candidate = `gpt-5.3-codex-spark-preview${suffix}`;
    return resolveModelSlugForProvider("cursor", candidate) as CursorModelSlug;
  }

  if (capability.supportsReasoning) {
    const reasoning = CURSOR_REASONING_OPTIONS.includes(input.reasoning ?? "normal")
      ? (input.reasoning ?? "normal")
      : capability.defaultReasoning;
    const reasoningSuffix = reasoning === "normal" ? "" : `-${reasoning}`;
    const fastSuffix = input.fast === true ? "-fast" : "";
    const candidate = `${family}${reasoningSuffix}${fastSuffix}`;
    return resolveModelSlugForProvider("cursor", candidate) as CursorModelSlug;
  }

  if (family === "claude-4.6-opus") {
    const tier = input.claudeOpusTier === "max" ? "max" : "high";
    const thinking =
      input.thinking === false
        ? false
        : input.thinking === true
          ? true
          : capability.defaultThinking;
    const base = `claude-4.6-opus-${tier}`;
    const candidate = thinking ? `${base}-thinking` : base;
    return resolveModelSlugForProvider("cursor", candidate) as CursorModelSlug;
  }

  if (family === "claude-4.6-sonnet") {
    const thinking =
      input.thinking === false
        ? false
        : input.thinking === true
          ? true
          : capability.defaultThinking;
    const candidate = thinking ? "claude-4.6-sonnet-medium-thinking" : "claude-4.6-sonnet-medium";
    return resolveModelSlugForProvider("cursor", candidate) as CursorModelSlug;
  }

  return resolveModelSlugForProvider("cursor", family) as CursorModelSlug;
}

const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";
const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5";

export interface SelectableModelOption {
  slug: string;
  name: string;
}

// ── Effort helpers ────────────────────────────────────────────────────

/** Check whether a capabilities object includes a given effort value. */
export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((l) => l.value === value);
}

/** Return the default effort value for a capabilities object, or null if none. */
export function getDefaultEffort(caps: ModelCapabilities): string | null {
  return caps.reasoningEffortLevels.find((l) => l.isDefault)?.value ?? null;
}

/**
 * Resolve a raw effort option against capabilities.
 *
 * Returns the effective effort value — the explicit value if supported and not
 * prompt-injected, otherwise the model's default. Returns `undefined` only
 * when the model has no effort levels at all.
 *
 * Prompt-injected efforts (e.g. "ultrathink") are excluded because they are
 * applied via prompt text, not the effort API parameter.
 */
export function resolveEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultEffort(caps);
  const trimmed = typeof raw === "string" ? raw.trim() : null;
  if (
    trimmed &&
    !caps.promptInjectedEffortLevels.includes(trimmed) &&
    hasEffortLevel(caps, trimmed)
  ) {
    return trimmed;
  }
  return defaultValue ?? undefined;
}

// ── Context window helpers ───────────────────────────────────────────

/** Check whether a capabilities object includes a given context window value. */
export function hasContextWindowOption(caps: ModelCapabilities, value: string): boolean {
  return caps.contextWindowOptions.some((o) => o.value === value);
}

/** Return the default context window value, or `null` if none is defined. */
export function getDefaultContextWindow(caps: ModelCapabilities): string | null {
  return caps.contextWindowOptions.find((o) => o.isDefault)?.value ?? null;
}

/**
 * Resolve a raw `contextWindow` option against capabilities.
 *
 * Returns the effective context window value — the explicit value if supported,
 * otherwise the model's default. Returns `undefined` only when the model has
 * no context window options at all.
 *
 * Unlike effort levels (where the API has matching defaults), the context
 * window requires an explicit API suffix (e.g. `[1m]`), so we always preserve
 * the resolved value to avoid ambiguity between "user chose the default" and
 * "not specified".
 */
export function resolveContextWindow(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultContextWindow(caps);
  if (!raw) return defaultValue ?? undefined;
  return hasContextWindowOption(caps, raw) ? raw : (defaultValue ?? undefined);
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, string>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

export function resolveModelSlug(model: string | null | undefined, provider: ProviderKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return normalized;
}

export function getDefaultModel(provider: ProviderKind = "codex"): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

export function supportsClaudeAdaptiveReasoning(model: string | null | undefined): boolean {
  const slug = normalizeModelSlug(model, "claudeAgent");
  return slug === CLAUDE_OPUS_4_6_MODEL || slug === CLAUDE_SONNET_4_6_MODEL;
}

export function supportsClaudeMaxEffort(model: string | null | undefined): boolean {
  const slug = normalizeModelSlug(model, "claudeAgent");
  return slug === CLAUDE_OPUS_4_6_MODEL;
}

export function supportsClaudeFastMode(model: string | null | undefined): boolean {
  const slug = normalizeModelSlug(model, "claudeAgent");
  return slug === CLAUDE_OPUS_4_6_MODEL;
}

export function supportsClaudeUltrathinkKeyword(model: string | null | undefined): boolean {
  const slug = normalizeModelSlug(model, "claudeAgent");
  return slug === CLAUDE_OPUS_4_6_MODEL || slug === CLAUDE_SONNET_4_6_MODEL;
}

export function supportsClaudeThinkingToggle(model: string | null | undefined): boolean {
  const slug = normalizeModelSlug(model, "claudeAgent");
  return slug === CLAUDE_HAIKU_4_5_MODEL;
}

export function inferProviderForModel(
  model: string | null | undefined,
  fallback: ProviderKind = "codex",
): ProviderKind {
  const normalizedClaude = normalizeModelSlug(model, "claudeAgent");
  if (normalizedClaude && MODEL_SLUG_SET_BY_PROVIDER.claudeAgent.has(normalizedClaude)) {
    return "claudeAgent";
  }

  const normalizedCodex = normalizeModelSlug(model, "codex");
  if (normalizedCodex && MODEL_SLUG_SET_BY_PROVIDER.codex.has(normalizedCodex)) {
    return "codex";
  }

  const normalizedCursor = normalizeModelSlug(model, "cursor");
  if (normalizedCursor && MODEL_SLUG_SET_BY_PROVIDER.cursor.has(normalizedCursor)) {
    return "cursor";
  }

  if (typeof model === "string" && CURSOR_MODEL_FAMILY_SET.has(model.trim() as CursorModelFamily)) {
    return "cursor";
  }

  return typeof model === "string" && model.trim().startsWith("claude-") ? "claudeAgent" : fallback;
}

export function getReasoningEffortOptions(provider: "codex"): ReadonlyArray<CodexReasoningEffort>;
export function getReasoningEffortOptions(
  provider: "claudeAgent",
  model?: string | null | undefined,
): ReadonlyArray<ClaudeCodeEffort>;
export function getReasoningEffortOptions(
  provider?: ProviderKind,
  model?: string | null | undefined,
): ReadonlyArray<ProviderReasoningEffort>;
export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
  model?: string | null | undefined,
): ReadonlyArray<ProviderReasoningEffort> {
  if (provider === "claudeAgent") {
    if (supportsClaudeMaxEffort(model)) {
      return ["low", "medium", "high", "max", "ultrathink"];
    }
    if (supportsClaudeAdaptiveReasoning(model)) {
      return ["low", "medium", "high", "ultrathink"];
    }
    return [];
  }
  if (provider === "cursor") {
    return [];
  }
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: "claudeAgent"): ClaudeCodeEffort;
export function getDefaultReasoningEffort(provider: "cursor"): CursorReasoningOption;
export function getDefaultReasoningEffort(provider?: ProviderKind): ProviderReasoningEffort;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): ProviderReasoningEffort {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export function resolveReasoningEffortForProvider(
  provider: "codex",
  effort: string | null | undefined,
): CodexReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: "claudeAgent",
  effort: string | null | undefined,
): ClaudeCodeEffort | null;
export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ProviderReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ProviderReasoningEffort | null {
  if (typeof effort !== "string") {
    return null;
  }

  const trimmed = effort.trim();
  if (!trimmed) {
    return null;
  }

  const options = REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider] as ReadonlyArray<string>;
  return options.includes(trimmed) ? (trimmed as ProviderReasoningEffort) : null;
}

export function isCursorModelFamilySlug(slug: string): boolean {
  return CURSOR_MODEL_FAMILY_SET.has(slug as CursorModelFamily);
}

export function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink"> | null {
  if (!effort) {
    return null;
  }
  return effort === "ultrathink" ? null : effort;
}

export function normalizeCodexModelOptions(
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const defaultReasoningEffort = getDefaultReasoningEffort("codex");
  const reasoningEffort =
    resolveReasoningEffortForProvider("codex", modelOptions?.reasoningEffort) ??
    defaultReasoningEffort;
  const fastModeEnabled = modelOptions?.fastMode === true;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort !== defaultReasoningEffort ? { reasoningEffort } : {}),
    ...(fastModeEnabled ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptions(
  model: string | null | undefined,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const reasoningOptions = getReasoningEffortOptions("claudeAgent", model);
  const defaultReasoningEffort = getDefaultReasoningEffort("claudeAgent");
  const resolvedEffort = resolveReasoningEffortForProvider("claudeAgent", modelOptions?.effort);
  const effort =
    resolvedEffort &&
    resolvedEffort !== "ultrathink" &&
    reasoningOptions.includes(resolvedEffort) &&
    resolvedEffort !== defaultReasoningEffort
      ? resolvedEffort
      : undefined;
  const thinking =
    supportsClaudeThinkingToggle(model) && modelOptions?.thinking === false ? false : undefined;
  const fastMode =
    supportsClaudeFastMode(model) && modelOptions?.fastMode === true ? true : undefined;
  const nextOptions: ClaudeModelOptions = {
    ...(thinking === false ? { thinking: false } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

/**
 * Resolve the actual API model identifier from a model selection.
 *
 * Provider-aware: each provider can map `contextWindow` (or other options)
 * to whatever the API requires — a model-id suffix, a separate parameter, etc.
 * The canonical slug stored in the selection stays unchanged so the
 * capabilities system keeps working.
 *
 * Expects `contextWindow` to already be resolved (via `resolveContextWindow`)
 * to the effective value, not stripped to `undefined` for defaults.
 */
export function resolveApiModelId(modelSelection: ModelSelection): string {
  switch (modelSelection.provider) {
    case "claudeAgent": {
      switch (modelSelection.options?.contextWindow) {
        case "1m":
          return `${modelSelection.model}[1m]`;
        default:
          return modelSelection.model;
      }
    }
    default: {
      return modelSelection.model;
    }
  }
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeCodeEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
