import { defineConfig } from "vite";

export default defineConfig({
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
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
