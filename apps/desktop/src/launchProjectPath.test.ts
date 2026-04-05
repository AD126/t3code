import { describe, expect, it, vi } from "vitest";

import { resolveLaunchProjectPath } from "./launchProjectPath";

describe("resolveLaunchProjectPath", () => {
  it("resolves the first existing directory argument relative to cwd", () => {
    const existsSync = vi.fn((filePath: string) => filePath === "/repo/project");
    const statSync = vi.fn((filePath: string) => ({
      isDirectory: () => filePath === "/repo/project",
    }));

    expect(
      resolveLaunchProjectPath({
        args: ["--flag", "."],
        cwd: "/repo/project",
        existsSync,
        statSync,
      }),
    ).toBe("/repo/project");
  });

  it("ignores non-directory arguments and missing paths", () => {
    const existsSync = vi.fn((filePath: string) => filePath === "/repo/README.md");
    const statSync = vi.fn(() => ({
      isDirectory: () => false,
    }));

    expect(
      resolveLaunchProjectPath({
        args: ["README.md", "missing-dir"],
        cwd: "/repo",
        existsSync,
        statSync,
      }),
    ).toBeNull();
  });

  it("ignores dash-prefixed Chromium or launcher flags", () => {
    const existsSync = vi.fn(() => false);
    const statSync = vi.fn();

    expect(
      resolveLaunchProjectPath({
        args: ["-psn_0_12345", "--inspect"],
        cwd: "/repo",
        existsSync,
        statSync,
      }),
    ).toBeNull();
    expect(statSync).not.toHaveBeenCalled();
  });
});
