import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["./src/index.ts","./src/workers/file_serve_worker.ts"],
  format: ["cjs", "esm"],
  dts: true,
  shims: true,
  skipNodeModulesBundle: true,
  clean: true,
  bundle: true,
  outDir: "dist",
});
