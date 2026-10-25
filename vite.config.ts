import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/** Emits sw.js with the list of built files to precache and a version that changes with them. */
function serviceWorker(): Plugin {
  return {
    name: "minigolf-service-worker",
    apply: "build",
    generateBundle(_, bundle) {
      const built = Object.keys(bundle).filter((f) => f !== "index.html" && !f.endsWith(".map"));
      const icons = readdirSync("public/icons").map((f) => `icons/${f}`);
      const assets = [...built, ...icons, "manifest.webmanifest"].sort().map((f) => `/${f}`);
      const hash = createHash("sha256");
      for (const [name, chunk] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(name);
        hash.update(chunk.type === "chunk" ? chunk.code : chunk.source);
      }
      const source = readFileSync("src/sw.js", "utf8")
        .replace("__VERSION__", hash.digest("hex").slice(0, 12))
        .replace(`["__ASSETS__"]`, JSON.stringify(assets));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  build: {
    target: "es2022",
  },
  server: {
    // The room API runs in `wrangler dev`; see the README.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
});
