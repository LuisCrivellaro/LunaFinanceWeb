import type { NextFunction, Request, Response, RequestHandler } from "express";
import type { AppContext } from "./context.js";
import { HttpError, tooMany, unauthorized, forbidden } from "./lib/errors.js";
import type { AuthUser } from "./services/access.js";
import { SESSION_COOKIE, userFromSession } from "./services/auth.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

/** Envolve handlers async para que erros cheguem ao middleware de erro. */
export const h =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).then(
      (out) => {
        if (!res.headersSent) res.json(out ?? { ok: true });
      },
      next,
    );
  };

export function authenticate(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return next();
    userFromSession(ctx.db, token).then((s) => {
      if (s) {
        req.user = s.user;
        req.sessionId = s.sessionId;
      }
      next();
    }, next);
  };
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  next();
};

/**
 * Proteção CSRF: requisições que alteram dados precisam do cabeçalho
 * `X-Luna-Client`. Navegadores não enviam cabeçalhos customizados entre
 * origens sem CORS (que não habilitamos), e o cookie já é SameSite=Lax.
 */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-luna-client") !== "web") return next(forbidden("Requisição bloqueada."));
  next();
};

/** Limitador simples em memória (janela deslizante) — suficiente para uma instância. */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }): RequestHandler {
  const hits = new Map<string, number[]>();
  return (req, _res, next) => {
    const key = opts.key ? opts.key(req) : req.ip ?? "anon";
    const nowMs = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => nowMs - t < opts.windowMs);
    list.push(nowMs);
    hits.set(key, list);
    if (hits.size > 10000) hits.clear();
    if (list.length > opts.max) return next(tooMany());
    next();
  };
}

export function errorHandler(ctx: AppContext) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const anyErr = err as { type?: string; status?: number; code?: string; message?: string };
    if (anyErr?.type === "entity.parse.failed" || anyErr?.type === "entity.too.large") {
      res.status(anyErr.status ?? 400).json({ error: { code: "bad_request", message: "Corpo da requisição inválido." } });
      return;
    }
    // violação de unicidade / FK no Postgres
    if (anyErr?.code === "23505") {
      res.status(409).json({ error: { code: "conflict", message: "Registro duplicado." } });
      return;
    }
    if (anyErr?.code === "23514" || anyErr?.code === "23503" || anyErr?.code === "22P02") {
      res.status(400).json({ error: { code: "bad_request", message: "Dados inválidos." } });
      return;
    }
    ctx.log.error("erro não tratado", { path: req.path, method: req.method, err: anyErr?.message });
    res.status(500).json({ error: { code: "internal", message: "Erro interno. Tente novamente." } });
  };
}

export function clientIp(req: Request) {
  return req.ip ?? undefined;
}

export function idParam(req: Request, name = "id"): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Identificador inválido.", "bad_request");
  return n;
}
