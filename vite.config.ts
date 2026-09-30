import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Builds the admin app into ./dist, which the Worker serves as static assets.
export default defineConfig({
  root: "app",
  plugins: [preact()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
