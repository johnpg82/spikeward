import { mkdirSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// The Worker's assets binding needs the directory to exist even before the app is built.
mkdirSync("./dist", { recursive: true });

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { SPIKEWARD_SECRET: "test-secret-for-spikeward-tests" } },
    }),
  ],
});
