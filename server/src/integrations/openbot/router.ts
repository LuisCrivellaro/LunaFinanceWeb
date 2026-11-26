/**
 * API de integração do OpenBot — /api/integrations/openbot/v1
 *
 * Separada da API do site: sem cookies, sem CSRF de navegador, com credencial
 * própria (Bearer), sessão por pessoa (X-Luna-Session + X-Luna-Sender),
 * Idempotency-Key obrigatório em todo POST, limites de requisição e histórico
 * de operações. Não existe rota de SQL, de administração nem de configuração:
 * nada que chegue por mensagem consegue mudar regras ou permissões.
 */
import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { AppContext } from "../../context.js";
import { rateLimit } from "../../http.js";
import { sha256 } from "../../lib/crypto.js";
import { badRequest, HttpError } from "../../lib/errors.js";
import { ackNotification, claimNotifications } from "../../notifications/queue.js";
import { normalizePhone } from "../phone.js";
import {
  claimLink, closeSession, credentialFromKey, getSettings, openSession, resolveSession, type Credential, type MemberSession, type Scope,
} from "./identity.js";
import {
  cancelDraft, confirmDraft, draftCorrection, draftDeletion, draftInvoicePayment, draftTransaction, draftTransfer, getDraft,
} from "./operations.js";
import * as Q from "./queries.js";
import { buildOpenApi } from "./openapi.js";

export const API_VERSION = "1.0.0";

interface Locals {
  cred?: Credential;
  member?: MemberSession;
  op?: string;
  errorCode?: string;
  started: number;
}
const L = (res: Response) => res.locals as Locals;

type Handler = (req: Request, res: Response) => Promise<{ status?: number; body: unknown }>;

export function openbotRouter(ctx: AppContext) {
  const { db } = ctx;
  const r = Router();

  r.use(express.json({ limit: "64kb" }));
  r.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    L(res).started = Date.now();
    // histórico: só operação, resultado e código — nunca valores, textos ou telefones
    res.on("finish", () => {
      const l = L(res);
      if (!l.op) return;
      const status = res.statusCode;
      const outcome = status < 400 ? "ok" : status === 401 || status === 403 ? "denied" : "error";
      db.query(
        "INSERT INTO integration_events (credential_id, user_id, operation, outcome, status, error_code, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [l.cred?.id ?? null, l.member?.user.id ?? null, l.op, outcome, status, l.errorCode ?? null, Date.now() - l.started],
      ).catch((err) => ctx.log.warn("openbot.evento_falhou", { err: (err as Error).message.slice(0, 120) }));
    });
    next();
  });

  // especificação pública (não contém segredos)
  r.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApi());
  });

  // limite global por credencial (ou IP, antes da autenticação)
  r.use(rateLimit({ windowMs: 60000, max: 240, key: (req) => `ob:${sha256(req.get("authorization") ?? req.ip ?? "anon").slice(0, 16)}` }));

  const authenticate = async (req: Request, res: Response, scope: Scope | null) => {
    const auth = req.get("authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const cred = key ? await credentialFromKey(db, key) : null;
    if (!cred) throw new HttpError(401, "Credencial da integração inválida ou revogada.", "invalid_credentials");
    L(res).cred = cred;
    if (scope && !cred.scopes.includes(scope)) throw new HttpError(403, `Esta credencial não tem a permissão "${scope}".`, "insufficient_scope");
    return cred;
  };
  const ensureEnabled = async () => {
    if (!(await getSettings(db)).enabled) throw new HttpError(503, "A integração com o OpenBot está desligada no Luna.", "integration_disabled");
  };

  /**
   * Monta uma rota: autenticação, escopo, integração ligada, sessão da pessoa
   * (quando exigida) e idempotência para POST.
   */
  function op(name: string, opts: { scope: Scope | null; member?: boolean; idempotent?: boolean; allowDisabled?: boolean }, fn: Handler) {
    return async (req: Request, res: Response, next: NextFunction) => {
      L(res).op = name;
      try {
        const cred = await authenticate(req, res, opts.scope);
        if (!opts.allowDisabled) await ensureEnabled();
        if (opts.member) L(res).member = await resolveSession(db, cred, req.get("x-luna-session"), req.get("x-luna-sender"));
        if (opts.idempotent) return await idempotent(req, res, cred, name, fn);
        const out = await fn(req, res);
        res.status(out.status ?? 200).json(out.body);
      } catch (err) {
        next(err);
      }
    };
  }

  async function idempotent(req: Request, res: Response, cred: Credential, name: string, fn: Handler) {
    const key = req.get("idempotency-key") ?? "";
    if (!/^[A-Za-z0-9:._@-]{8,200}$/.test(key)) {
      throw badRequest("Envie o cabeçalho Idempotency-Key (8–200 caracteres; use o id da mensagem do WhatsApp + a operação).", { field: "Idempotency-Key" });
    }
    const userId = L(res).member?.user.id ?? 0;
    const hash = sha256(`${name}|${userId}|${req.originalUrl}|${JSON.stringify(req.body ?? {})}`);
    const ins = await db.query("INSERT INTO integration_requests (credential_id, idem_key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING idem_key", [cred.id, key, hash]);
    if (!ins.rows[0]) {
      const { rows } = await db.query<{ request_hash: string; state: string; status: number | null; response: unknown }>(
        "SELECT request_hash, state, status, response FROM integration_requests WHERE credential_id = $1 AND idem_key = $2",
        [cred.id, key],
      );
      const ex = rows[0];
      if (!ex || ex.request_hash !== hash) throw new HttpError(422, "Esta Idempotency-Key já foi usada com outro conteúdo.", "idempotency_key_reused");
      if (ex.state === "processing") {
        res.setHeader("Retry-After", "2");
        throw new HttpError(409, "Esta operação ainda está em andamento. Tente de novo em instantes com a mesma chave.", "request_in_progress");
      }
      res.setHeader("Idempotent-Replay", "true");
      res.status(ex.status ?? 200).json(typeof ex.response === "string" ? JSON.parse(ex.response) : ex.response);
      return;
    }
    const store = (status: number, body: unknown) =>
      db.query("UPDATE integration_requests SET state = 'done', status = $3, response = $4 WHERE credential_id = $1 AND idem_key = $2", [cred.id, key, status, JSON.stringify(body)]);
    try {
      const out = await fn(req, res);
      await store(out.status ?? 200, out.body);
      res.status(out.status ?? 200).json(out.body);
    } catch (err) {
      // erro de validação/regra é definitivo: a retentativa recebe a mesma resposta
      if (err instanceof HttpError && err.status < 500 && err.status !== 429 && err.code !== "request_in_progress") {
        await store(err.status, { error: { code: err.code, message: err.message, details: err.details } });
      } else {
        // falha transitória: libera a chave para a retentativa executar de novo
        await db.query("DELETE FROM integration_requests WHERE credential_id = $1 AND idem_key = $2", [cred.id, key]);
      }
      throw err;
    }
  }

  const member = (res: Response) => L(res).member!;
  const settings = () => getSettings(db);
  const ref = (req: Request) => req.get("idempotency-key") ?? null;

  // ---------------- sem pessoa (só credencial) ----------------
  r.get("/health", op("health", { scope: null, allowDisabled: true }, async () => {
    const s = await settings();
    await db.query("SELECT 1");
    return { body: { ok: true, version: API_VERSION, integrationEnabled: s.enabled, pinRequired: s.pinRequired, autoConfirm: s.autoConfirm, time: new Date().toISOString(), timezone: "America/Sao_Paulo" } };
  }));

  const phoneLimiter = (prefix: string, max: number) =>
    rateLimit({ windowMs: 15 * 60000, max, key: (req) => `${prefix}:${normalizePhone(req.body?.phone ?? "") ?? req.ip}` });

  r.post("/links/claim", phoneLimiter("obl", 10), op("links.claim", { scope: "link", idempotent: true }, async (req) => {
    const out = await claimLink(db, req.body?.phone, req.body?.code);
    return { body: { linked: true, member: { userId: out.userId, name: out.name }, pinSet: out.pinSet, next: out.pinSet ? "Abra a sessão com POST /sessions (número + PIN)." : "A pessoa precisa definir o PIN no site antes de usar." } };
  }));

  r.post("/sessions", phoneLimiter("obs", 10), op("sessions.open", { scope: "read" }, async (req, res) => {
    const out = await openSession(db, L(res).cred!, req.body?.phone, req.body?.pin);
    return { status: 201, body: { sessionToken: out.sessionToken, expiresAt: out.expiresAt, member: await Q.me(db, out.user) } };
  }));

  r.delete("/sessions/current", op("sessions.close", { scope: "read", member: true, allowDisabled: true }, async (_req, res) => {
    await closeSession(db, member(res));
    return { body: { closed: true } };
  }));

  // ---------------- consultas da pessoa ----------------
  const read = (name: string, fn: (req: Request, res: Response) => Promise<unknown>) =>
    op(name, { scope: "read", member: true }, async (req, res) => ({ body: await fn(req, res) }));

  r.get("/me", read("me", async (_req, res) => Q.me(db, member(res).user)));
  r.get("/catalog", read("catalog", async (_req, res) => Q.catalog(db, member(res).user)));
  r.get("/balance", read("balance", async (req, res) => Q.balance(db, member(res).user, req.query)));
  r.get("/summary", read("summary", async (req, res) => Q.summary(db, member(res).user, req.query)));
  r.get("/transactions", read("transactions.list", async (req, res) => Q.transactions(db, member(res).user, req.query)));
  r.get("/spendable", read("spendable", async (_req, res) => Q.spendable(db, member(res).user)));
  r.get("/cards", read("cards", async (_req, res) => Q.cards(db, member(res).user)));
  r.get("/invoices", read("invoices", async (req, res) => Q.invoice(db, member(res).user, req.query)));
  r.get("/budgets", read("budgets", async (req, res) => Q.budgets(db, member(res).user, req.query)));
  r.get("/goals", read("goals", async (_req, res) => Q.goals(db, member(res).user)));
  r.get("/bills", read("bills", async (req, res) => Q.bills(db, member(res).user, req.query)));
  r.get("/reports", read("reports", async (req, res) => Q.reports(db, member(res).user, req.query)));
  r.post("/interpret", op("interpret", { scope: "read", member: true }, async (req, res) => ({ body: await Q.interpretText(db, member(res).user, req.body) })));

  // ---------------- escrita (sempre por rascunho) ----------------
  const write = (name: string, fn: (req: Request, res: Response) => Promise<{ status: string }>) =>
    op(name, { scope: "write", member: true, idempotent: true }, async (req, res) => {
      const out = await fn(req, res);
      return { status: out.status === "committed" ? 201 : out.status === "needs_info" ? 422 : 202, body: out };
    });

  r.post("/drafts/transactions", write("drafts.transaction", async (req, res) => draftTransaction(db, member(res).user, req.body, await settings(), ref(req))));
  r.post("/drafts/transfers", write("drafts.transfer", async (req, res) => draftTransfer(db, member(res).user, req.body, await settings(), ref(req))));
  r.post("/drafts/corrections", write("drafts.correction", async (req, res) => draftCorrection(db, member(res).user, req.body, await settings(), ref(req))));
  r.post("/drafts/deletions", write("drafts.deletion", async (req, res) => draftDeletion(db, member(res).user, req.body, await settings(), ref(req))));
  r.post("/drafts/invoice-payments", write("drafts.invoice_payment", async (req, res) => draftInvoicePayment(db, member(res).user, req.body, await settings(), ref(req))));

  r.get("/drafts/:id", read("drafts.get", async (req, res) => getDraft(db, member(res).user, String(req.params.id))));
  r.post("/drafts/:id/confirm", op("drafts.confirm", { scope: "write", member: true, idempotent: true }, async (req, res) => {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) throw badRequest("Informe a versão do rascunho (version).", { field: "version" });
    const out = await confirmDraft(db, member(res).user, String(req.params.id), version);
    return { status: 201, body: out };
  }));
  r.post("/drafts/:id/cancel", op("drafts.cancel", { scope: "write", member: true, idempotent: true }, async (req, res) => ({
    body: await cancelDraft(db, member(res).user, String(req.params.id)),
  })));

  // ---------------- fila de avisos (entrega pelo OpenBot) ----------------
  r.get("/notifications/pending", op("notifications.claim", { scope: "notifications" }, async (req) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    return { body: { items: await claimNotifications(db, limit) } };
  }));
  r.post("/notifications/:id/ack", op("notifications.ack", { scope: "notifications", idempotent: true }, async (req) => {
    const status = req.body?.status;
    if (status !== "delivered" && status !== "failed") throw badRequest("status deve ser delivered ou failed.", { field: "status" });
    const ok = await ackNotification(db, Number(req.params.id), String(req.body?.claimToken ?? ""), status, req.body?.error ? String(req.body.error) : undefined);
    if (!ok) throw new HttpError(409, "Aviso não reservado por esta entrega (claimToken inválido ou já confirmado).", "not_claimed");
    return { body: { ok: true } };
  }));

  r.use((_req, res) => {
    L(res).errorCode = "not_found";
    res.status(404).json({ error: { code: "not_found", message: "Rota não encontrada na API de integração." } });
  });

  // erros no mesmo formato da API do site, guardando o código no histórico
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  r.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      L(res).errorCode = err.code;
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { type?: string; status?: number; code?: string; message?: string };
    if (e?.type === "entity.parse.failed" || e?.type === "entity.too.large") {
      L(res).errorCode = "bad_request";
      res.status(e.status ?? 400).json({ error: { code: "bad_request", message: "Corpo da requisição inválido." } });
      return;
    }
    if (e?.code === "23505") {
      L(res).errorCode = "conflict";
      res.status(409).json({ error: { code: "conflict", message: "Registro duplicado." } });
      return;
    }
    L(res).errorCode = "internal";
    ctx.log.error("openbot.erro", { op: L(res).op, err: e?.message?.slice(0, 200) });
    res.status(500).json({ error: { code: "internal", message: "Erro interno. Nada foi gravado; tente de novo com a mesma Idempotency-Key." } });
  });

  return r;
}
