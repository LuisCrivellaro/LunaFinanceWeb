import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { manualChunks: { charts: ["recharts"], vendor: ["react", "react-dom", "react-router", "@tanstack/react-query"] } } },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000", "/telegram": "http://localhost:3000" },
  },
});
