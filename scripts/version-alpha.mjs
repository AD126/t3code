import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../apps/server/package.json", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const versionArg = args.find((arg) => arg !== "--dry-run");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const currentVersion = packageJson.version;

const alphaVersionPattern = /^\d+\.\d+\.\d+-alpha\.\d+$/;
const alphaCounterPattern = /^(?<base>\d+\.\d+\.\d+)-alpha\.(?<counter>\d+)$/;

function nextAlphaVersion(version) {
  const alphaMatch = version.match(alphaCounterPattern);
  if (alphaMatch?.groups) {
    const counter = Number.parseInt(alphaMatch.groups.counter, 10);
    return `${alphaMatch.groups.base}-alpha.${counter + 1}`;
  }

  if (version.includes("-")) {
    throw new Error(
      `Cannot derive an alpha version from prerelease version "${version}". Pass an explicit version instead.`,
    );
  }

  return `${version}-alpha.0`;
}

const nextVersion = versionArg ?? nextAlphaVersion(currentVersion);

if (!alphaVersionPattern.test(nextVersion)) {
  throw new Error(
    `Expected an explicit alpha version like "0.1.0-alpha.0", received "${nextVersion}".`,
  );
}

if (dryRun) {
  console.log(nextVersion);
  process.exit(0);
}

packageJson.version = nextVersion;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Updated apps/server/package.json to ${nextVersion}`);
