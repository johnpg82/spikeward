import type { Env } from "./env";
import { api } from "./api/routes";
import { migrate } from "./db";
import { runTick } from "./loop/tick";

export default {
  // The app's static files are served by Workers assets; only /api/* reaches this handler.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  // Every minute: poll, detect, judge, enforce, reconcile.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await migrate(env);
        await runTick(env, new Date(controller.scheduledTime));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
