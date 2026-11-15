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
        const required = new Set<string>();
        const visited = new Set<string>();
        const available = new Set(assets);
        const includeAsset = (file: string) => {
          if (available.has("/" + file)) required.add("/" + file);
        };
        const includeChunk = (file: string) => {
          if (visited.has(file)) return;
          visited.add(file);
          const chunk = bundle[file];
          if (!chunk || chunk.type !== "chunk") throw new Error("Missing offline chunk: " + file);
          includeAsset(file);
          const metadata = (chunk as typeof chunk & {
            viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> };
          }).viteMetadata;
          for (const css of metadata?.importedCss ?? []) includeAsset(css);
          for (const asset of metadata?.importedAssets ?? []) includeAsset(asset);
          for (const dependency of chunk.imports) includeChunk(dependency);
        };
        const named = new Set(["MedicineMarketPage", "CommercePages", "FinancePages"]);
        let entries = 0;
        for (const [file, chunk] of Object.entries(bundle)) {
          if (chunk.type !== "chunk") continue;
          if (chunk.isEntry) {
            entries++;
            includeChunk(file);
          } else if (named.delete(chunk.name)) {
            includeChunk(file);
          }
        }
        if (!entries || named.size) throw new Error("Missing offline app entry or route: " + [...named].join(", "));
        const manifest = { required: [...required], optional: assets.filter(path => !required.has(path)) };
        // Keep the old manifest for installed workers until they update.
        this.emitFile({ type: "asset", fileName: "offline-assets.json", source: JSON.stringify(assets) });
        this.emitFile({ type: "asset", fileName: "offline-core-assets.json", source: JSON.stringify(manifest) });
      },
    },
  ],
  build: { outDir: "../../dist/public", emptyOutDir: true },
  server: { fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
