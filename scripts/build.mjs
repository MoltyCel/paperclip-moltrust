import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const common = { bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "info" };
await build({
  ...common,
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.js",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await build({ ...common, entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js" });
