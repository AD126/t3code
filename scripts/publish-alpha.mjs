import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageDir = fileURLToPath(new URL("../apps/server", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../apps/server/package.json", import.meta.url));
const rootPackageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const rootPackageJson = JSON.parse(readFileSync(rootPackageJsonPath, "utf8"));
const version = packageJson.version;
const isDryRun = process.argv.includes("--dry-run");

if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)) {
  throw new Error(
    `Refusing alpha publish because apps/server/package.json is "${version}". Use bun run version:alpha first.`,
  );
}

const build = spawnSync("bun", ["run", "build", "--filter=t3"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

function readWorkspaceCatalog(rootManifest) {
  const workspaces = rootManifest?.workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
    return {};
  }

  const catalog = workspaces.catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return {};
  }

  return catalog;
}

function resolveCatalogDependencies(dependencies, catalog, dependencySourceLabel) {
  return Object.fromEntries(
    Object.entries(dependencies ?? {}).map(([dependencyName, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [dependencyName, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      const lookupKey = catalogKey.length > 0 ? catalogKey : dependencyName;
      const resolvedSpec = catalog[lookupKey];
      if (typeof resolvedSpec !== "string" || resolvedSpec.length === 0) {
        throw new Error(
          `Unable to resolve '${spec}' for ${dependencySourceLabel} dependency '${dependencyName}'.`,
        );
      }

      return [dependencyName, resolvedSpec];
    }),
  );
}

const publishDir = mkdtempSync(path.join(os.tmpdir(), "t3-alpha-publish-"));
cpSync(path.join(packageDir, "dist"), path.join(publishDir, "dist"), { recursive: true });
mkdirSync(path.join(publishDir, "bin"), { recursive: true });
writeFileSync(
  path.join(publishDir, "bin", "t3"),
  '#!/usr/bin/env node\nimport "../dist/index.mjs";\n',
);
chmodSync(path.join(publishDir, "bin", "t3"), 0o755);

const publishManifest = {
  name: packageJson.name,
  version: packageJson.version,
  type: packageJson.type,
  bin: {
    t3: "bin/t3",
  },
  main: packageJson.main,
  files: ["dist", "bin"],
  dependencies: resolveCatalogDependencies(
    packageJson.dependencies,
    readWorkspaceCatalog(rootPackageJson),
    "apps/server",
  ),
};

writeFileSync(path.join(publishDir, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`);

const publishArgs = ["publish", "--tag", "alpha"];
if (isDryRun) {
  publishArgs.push("--dry-run");
}

const publish = spawnSync("npm", publishArgs, {
  cwd: publishDir,
  stdio: "inherit",
});

rmSync(publishDir, { recursive: true, force: true });
process.exit(publish.status ?? 1);
