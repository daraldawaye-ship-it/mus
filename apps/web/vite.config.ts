import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      name: "offline-static-list",
      generateBundle(_options, bundle) {
        const assets = Object.keys(bundle)
          // Owner reference galleries are fetched and cached when opened.
          // Keep operational pages in the offline bundle without preloading every demo.
          .filter(name => /^assets\/.*\.(js|css|woff2?)$/.test(name) &&
            !/^assets\/DesignLibrary[^/]*\.(?:js|css)$/.test(name))
          .map(name => "/" + name);
        this.emitFile({ type: "asset", fileName: "offline-assets.json", source: JSON.stringify(assets) });
      },
    },
  ],
  build: { outDir: "../../dist/public", emptyOutDir: true },
  server: { fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
