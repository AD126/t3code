import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: ["@acme/contracts", "@acme/runtime-core"],
  outDir: "dist",
});
