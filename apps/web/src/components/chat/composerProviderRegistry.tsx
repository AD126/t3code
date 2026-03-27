import {
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import { isClaudeUltrathinkPrompt, resolveEffort } from "@t3tools/shared/model";
import type { ReactNode } from "react";
import {
  getProviderModelCapabilities,
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
} from "../../providerModels";
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type ProviderRegistryEntry = {
  getState: (input: ComposerProviderStateInput) => ComposerProviderState;
  renderTraitsMenuContent: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
  renderTraitsPicker: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
};

function getProviderStateFromCapabilities(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const { provider, model, models, prompt, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const providerOptions = modelOptions?.[provider];

  // Resolve effort
  const rawEffort = providerOptions
    ? "effort" in providerOptions
      ? providerOptions.effort
      : "reasoningEffort" in providerOptions
        ? providerOptions.reasoningEffort
        : "reasoning" in providerOptions
          ? providerOptions.reasoning
          : null
    : null;

  const promptEffort = resolveEffort(caps, rawEffort) ?? null;

  // Normalize options for dispatch
  const normalizedOptions = {
    codex: normalizeCodexModelOptionsWithCapabilities(caps, providerOptions),
    cursor: normalizeCursorModelOptionsWithCapabilities(caps, providerOptions),
    claudeAgent: normalizeClaudeModelOptionsWithCapabilities(caps, providerOptions),
    acp: undefined,
  }[provider];

  // Ultrathink styling (driven by capabilities data, not provider identity)
  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
    ...(ultrathinkActive ? { composerFrameClassName: "ultrathink-frame" } : {}),
    ...(ultrathinkActive
      ? { composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]" }
      : {}),
    ...(ultrathinkActive ? { modelPickerIconClassName: "ultrathink-chroma" } : {}),
  };
}

const composerProviderRegistry: Record<ProviderKind, ProviderRegistryEntry> = {
  codex: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "codex",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsMenuContent
          provider="codex"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "codex",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsPicker
          provider="codex"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
  },
  claudeAgent: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "claudeAgent",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsMenuContent
          provider="claudeAgent"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "claudeAgent",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsPicker
          provider="claudeAgent"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
  },
  cursor: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "cursor",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsMenuContent
          provider="cursor"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      shouldRenderTraitsControls({
        provider: "cursor",
        models,
        model,
        modelOptions,
        prompt,
      }) ? (
        <TraitsPicker
          provider="cursor"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
  },
  acp: {
    getState: (input) => ({
      provider: input.provider,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    }),
    renderTraitsMenuContent: () => null,
    renderTraitsPicker: () => null,
  },
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  return composerProviderRegistry[input.provider].getState(input);
}

export function renderProviderTraitsMenuContent(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsMenuContent({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
  });
}

export function renderProviderTraitsPicker(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsPicker({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
  });
}
