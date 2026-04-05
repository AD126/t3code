import { DEFAULT_RUNTIME_MODE, type ProjectId, type ThreadId } from "@t3tools/contracts";

import { type DraftThreadEnvMode, useComposerDraftStore } from "./composerDraftStore";

interface ActivateProjectDraftThreadInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly createdAt?: string;
  readonly envMode?: DraftThreadEnvMode;
  readonly navigate?: (threadId: ThreadId) => Promise<void>;
}

export async function activateProjectDraftThread(
  input: ActivateProjectDraftThreadInput,
): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const envMode = input.envMode ?? (input.worktreePath ? "worktree" : "local");
  const { applyStickyState, setProjectDraftThreadId } = useComposerDraftStore.getState();

  setProjectDraftThreadId(input.projectId, input.threadId, {
    createdAt,
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    envMode,
    runtimeMode: DEFAULT_RUNTIME_MODE,
  });
  applyStickyState(input.threadId);

  if (input.navigate) {
    await input.navigate(input.threadId);
  }
}
