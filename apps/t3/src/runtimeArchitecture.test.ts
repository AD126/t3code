import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_SOURCE_FILES = ["cli.ts", "runtimeApiServer.ts"] as const;

describe("runtime architecture boundaries", () => {
  it("keeps runtime API server wired through runtime-core services", () => {
    const sourcePath = path.resolve(import.meta.dirname, "runtimeApiServer.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).toContain("from \"@acme/runtime-core\"");
    expect(source).toContain("ProcessManager");
    expect(source).toContain("ProviderManager");
    expect(source).toContain("TodoStore");
  });

  for (const fileName of RUNTIME_SOURCE_FILES) {
    it(`avoids direct desktop service imports in ${fileName}`, () => {
      const sourcePath = path.resolve(import.meta.dirname, fileName);
      const source = fs.readFileSync(sourcePath, "utf8");

      expect(source).not.toContain("../../desktop/src/");
    });
  }

  it("does not rely on a legacy desktop workspace package", () => {
    const legacyDesktopPackagePath = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "desktop",
      "package.json",
    );

    expect(fs.existsSync(legacyDesktopPackagePath)).toBe(false);
  });

  it("keeps runtime-core bundled into published t3 runtime output", () => {
    const tsupConfigPath = path.resolve(import.meta.dirname, "..", "tsup.config.ts");
    const tsupConfigSource = fs.readFileSync(tsupConfigPath, "utf8");

    expect(tsupConfigSource).toContain("\"@acme/runtime-core\"");
    expect(tsupConfigSource).toContain("noExternal");
  });
});
