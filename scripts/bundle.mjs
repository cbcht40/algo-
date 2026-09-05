// Bundle the copier into a single self-contained JS file so the packaged Electron
// app can run it with Electron's built-in Node — no system node, npm or tsx needed
// on the user's machine. The dashboard HTML is copied next to the bundle (loaded
// at runtime via import.meta.url).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("build", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "build/copier.mjs",
  // ws's optional native speedups — keep external; ws falls back to pure JS.
  external: ["bufferutil", "utf-8-validate"],
  // Provide require()/__dirname in the ESM bundle for deps that expect CJS.
  banner: {
    js: [
      "import { createRequire as ___createRequire } from 'node:module';",
      "import { fileURLToPath as ___fileURLToPath } from 'node:url';",
      "import { dirname as ___dirname } from 'node:path';",
      "const require = ___createRequire(import.meta.url);",
      "const __filename = ___fileURLToPath(import.meta.url);",
      "const __dirname = ___dirname(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});

copyFileSync("src/dashboard.html", "build/dashboard.html");
copyFileSync("src/dashboard-mirror.html", "build/dashboard-mirror.html");
copyFileSync("src/onboarding.html", "build/onboarding.html");
// Librairie de graphique servie par le dashboard (/vendor/lightweight-charts.js), hors ligne.
copyFileSync("node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js", "build/lightweight-charts.js");
console.log("✓ bundled → build/copier.mjs (+ dashboard.html, dashboard-mirror.html, onboarding.html, lightweight-charts.js)");
