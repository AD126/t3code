import { ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "./composerDraftStore";
import { activateProjectDraftThread } from "./projectDraftThreadActivation";

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("activateProjectDraftThread", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const threadId = ThreadId.makeUnsafe("thread-a");
  const replacementThreadId = ThreadId.makeUnsafe("thread-b");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("creates a local draft thread mapping for the requested project", async () => {
    await activateProjectDraftThread({
      projectId,
      threadId,
      createdAt: "2026-04-05T12:00:00.000Z",
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toEqual({
      threadId,
      projectId,
      createdAt: "2026-04-05T12:00:00.000Z",
      branch: null,
      worktreePath: null,
      envMode: "local",
      runtimeMode: "full-access",
      interactionMode: "default",
    });
  });

  it("replaces an existing project draft mapping and cleans up the orphaned draft", async () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      createdAt: "2026-04-05T12:00:00.000Z",
    });
    store.setPrompt(threadId, "stale draft");

    await activateProjectDraftThread({
      projectId,
      threadId: replacementThreadId,
      createdAt: "2026-04-05T13:00:00.000Z",
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      replacementThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("navigates after the draft thread is activated", async () => {
    const navigate = vi.fn(async () => undefined);

    await activateProjectDraftThread({
      projectId,
      threadId,
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith(threadId);
  });
});
