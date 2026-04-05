import * as FS from "node:fs";
import * as Path from "node:path";

type ExistsSyncFn = (path: string) => boolean;
type StatSyncFn = (path: string) => Pick<FS.Stats, "isDirectory">;

interface ResolveLaunchProjectPathInput {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly existsSync?: ExistsSyncFn;
  readonly statSync?: StatSyncFn;
}

export function resolveLaunchProjectPath(input: ResolveLaunchProjectPathInput): string | null {
  const existsSync = input.existsSync ?? FS.existsSync;
  const statSync = input.statSync ?? FS.statSync;

  for (const rawArg of input.args) {
    if (!rawArg || rawArg.startsWith("-")) {
      continue;
    }

    const resolvedPath = Path.resolve(input.cwd, rawArg);
    if (!existsSync(resolvedPath)) {
      continue;
    }

    try {
      if (!statSync(resolvedPath).isDirectory()) {
        continue;
      }
      return resolvedPath;
    } catch {
      continue;
    }
  }

  return null;
}
