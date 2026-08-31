import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.tsx",
      name: "TeamAICamblePlugin",
      formats: ["iife"],
      fileName: () => "frontend.js",
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        assetFileNames: (asset) => (asset.name?.endsWith(".css") ? "frontend.css" : "assets/[name]-[hash][extname]"),
      },
    },
  },
});
