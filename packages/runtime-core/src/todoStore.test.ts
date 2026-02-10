import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TodoStore } from "./todoStore";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

async function createStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "runtime-core-todos-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "todos.json");
  const store = new TodoStore(filePath);
  await store.init();
  return { store, filePath };
}

describe("TodoStore", () => {
  it("initializes an empty todo file", async () => {
    const { store, filePath } = await createStore();

    expect(await store.list()).toEqual([]);

    const raw = await readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual([]);
  });

  it("adds, toggles, removes, and persists todos", async () => {
    const { store, filePath } = await createStore();

    const afterAdd = await store.add({ title: "ship runtime core" });
    expect(afterAdd).toHaveLength(1);
    const added = afterAdd[0];
    expect(added?.title).toBe("ship runtime core");
    expect(added?.completed).toBe(false);

    if (!added) {
      throw new Error("Expected todo to be created.");
    }

    const afterToggle = await store.toggle(added.id);
    expect(afterToggle[0]?.completed).toBe(true);

    const reloaded = new TodoStore(filePath);
    await reloaded.init();
    expect((await reloaded.list())[0]?.completed).toBe(true);

    const afterRemove = await reloaded.remove(added.id);
    expect(afterRemove).toEqual([]);
  });
});
