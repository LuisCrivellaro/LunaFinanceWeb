import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "./context.js";
import { authenticate, csrfGuard, errorHandler, rateLimit } from "./http.js";
import { safeEqual } from "./lib/crypto.js";
import { apiRouter } from "./routes/api.js";
import { handleUpdate } from "./telegram/bot.js";
import { runScheduledJobs } from "./notifications/jobs.js";

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable("x-powered-by");
  if (ctx.config.trustProxy) app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
        },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  app.get("/healthz", async (_req, res) => {
    try {
      await ctx.db.query("SELECT 1");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // ---------- Webhook do Telegram (antes do parser de cookies/CSRF) ----------
  app.post(
    "/telegram/webhook",
    rateLimit({ windowMs: 60000, max: 300 }),
    express.json({ limit: "256kb" }),
    async (req, res) => {
      const secret = req.get("x-telegram-bot-api-secret-token") ?? "";
      if (!ctx.config.telegram.enabled || !safeEqual(secret, ctx.config.telegram.webhookSecret)) {
        ctx.log.warn("telegram.webhook_rejeitado", { ip: req.ip });
        res.status(401).json({ ok: false });
        return;
      }
      try {
        await handleUpdate(ctx, req.body);
      } catch (err) {
        ctx.log.error("telegram.webhook_erro", { err: (err as Error).message });
      }
      // sempre 200 após autenticar: o Telegram não deve reenviar em loop
      res.json({ ok: true });
    },
  );

  // ---------- Cron externo (opcional) ----------
  app.post("/api/cron/run", rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    const auth = req.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!ctx.config.cronSecret || !safeEqual(token, ctx.config.cronSecret)) {
      res.status(401).json({ ok: false });
      return;
    }
    try {
      res.json({ ok: true, result: await runScheduledJobs(ctx) });
    } catch (err) {
      ctx.log.error("cron.erro", { err: (err as Error).message });
      res.status(500).json({ ok: false });
    }
  });

  // ---------- API do site ----------
  app.use("/api", express.json({ limit: "200kb" }), cookieParser(), authenticate(ctx), csrfGuard, (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", apiRouter(ctx));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Rota não encontrada." } });
  });

  // ---------- Frontend estático (build do Vite) ----------
  const here = dirname(fileURLToPath(import.meta.url));
  // build: dist/server/src/app.js → dist/web ; em dev o Vite serve o frontend
  const candidates = [resolve(here, "../../web"), resolve(process.cwd(), "dist/web")];
  const webDir = candidates.find((d) => existsSync(resolve(d, "index.html")) && existsSync(resolve(d, "assets")));
  if (webDir) {
    app.use(express.static(webDir, { index: false, maxAge: "1h", setHeaders: (res, path) => {
      if (path.includes("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } }));
    app.get(/^\/(?!api\/|telegram\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(resolve(webDir, "index.html"));
    });
  }

  app.use(errorHandler(ctx));
  return app;
}
