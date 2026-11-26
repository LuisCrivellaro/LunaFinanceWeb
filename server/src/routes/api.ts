import { Router, type Response } from "express";
import type { AppContext } from "../context.js";
import { clientIp, h, idParam, rateLimit, requireUser } from "../http.js";
import { currentMonth, isIsoDate, monthRange, today } from "../lib/clock.js";
import { badRequest } from "../lib/errors.js";
import { parseViewRequest } from "../services/access.js";
import { createAccount, listAccounts, updateAccount } from "../services/accounts.js";
import {
  SESSION_COOKIE, changePassword, consumeAccessLink, destroySession, inspectAccessLink, login,
} from "../services/auth.js";
import { createCategory, listCategories, updateCategory } from "../services/categories.js";
import { contribute, createGoal, deleteContribution, deleteGoal, listContributions, listGoals, updateGoal } from "../services/goals.js";
import { dashboard, exportCsv, report } from "../services/insights.js";
import {
  createMember, getProfile, issueResetLink, listMembers, listMembersForManagement, updateMemberAccess, updateProfile,
} from "../services/members.js";
import {
  createTransaction, deleteTransaction, listBills, listRecurrences, listTransactions, markPaid, updateRecurrence, updateTransaction,
} from "../services/transactions.js";
import { createLinkCode, unlinkTelegram } from "../telegram/linking.js";
import { createTransfer, deleteTransfer, listTransfers } from "../services/transfers.js";
import { wallet } from "../services/wallet.js";
import { archiveBudget, budgetStatus, createBudget } from "../services/budgets.js";
import { getCardSettings, invoiceSummary, limitStatus, listCards, updateCardSettings } from "../services/cards.js";
import { assertCanManageFamily } from "../services/access.js";
import {
  adminLink, createCredential, createLinkCode as createWhatsAppLinkCode, getSettings as getIntegrationSettings, listCredentials, myWhatsApp, resetPin, revokeCredential,
  revokeSessions, setPin, unlink as unlinkWhatsApp, updateSettings as updateIntegrationSettings,
} from "../integrations/openbot/identity.js";
import { integrationOverview, selfTest } from "../integrations/openbot/overview.js";

export function apiRouter(ctx: AppContext) {
  const r = Router();
  const { db, config } = ctx;

  const setSessionCookie = (res: Response, token: string, expires: Date) =>
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "lax",
      expires,
      path: "/",
    });

  // ---------------- Autenticação (público) ----------------
  const loginLimiter = rateLimit({ windowMs: 15 * 60000, max: config.loginRateMax });

  r.post("/auth/login", loginLimiter, h(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") throw badRequest("Informe e-mail e senha.");
    const out = await login(db, email, password, { ip: clientIp(req), userAgent: req.get("user-agent") }, config.sessionDays);
    setSessionCookie(res, out.token, out.expiresAt);
    return { ok: true };
  }));

  r.post("/auth/logout", h(async (req, res) => {
    if (req.sessionId) await destroySession(db, req.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }));

  r.post("/auth/access-link/inspect", loginLimiter, h(async (req) => inspectAccessLink(db, String(req.body?.token ?? ""))));

  r.post("/auth/access-link/consume", loginLimiter, h(async (req, res) => {
    const out = await consumeAccessLink(db, String(req.body?.token ?? ""), req.body?.password, { ip: clientIp(req), userAgent: req.get("user-agent") }, config.sessionDays);
    setSessionCookie(res, out.token, out.expiresAt);
    return { ok: true };
  }));

  // ---------------- Daqui para baixo: exige login ----------------
  r.use(requireUser);

  r.get("/me", h(async (req) => getProfile(db, req.user!)));
  r.patch("/me", h(async (req) => {
    await updateProfile(db, req.user!, req.body ?? {});
    return getProfile(db, req.user!);
  }));
  r.post("/me/password", h(async (req) => {
    await changePassword(db, req.user!, req.body?.currentPassword, req.body?.newPassword, req.sessionId!, clientIp(req));
    return { ok: true };
  }));

  r.get("/members", h(async () => listMembers(db)));

  // gestão de membros (o backend recusa quem não pode)
  r.get("/family/members", h(async (req) => listMembersForManagement(db, req.user!)));
  r.post("/family/members", h(async (req) => createMember(db, req.user!, req.body ?? {}, config.appUrl)));
  r.patch("/family/members/:id", h(async (req) => {
    await updateMemberAccess(db, req.user!, idParam(req), req.body ?? {});
    return { ok: true };
  }));
  r.post("/family/members/:id/access-link", h(async (req) => issueResetLink(db, req.user!, idParam(req), config.appUrl)));

  // ---------------- Contas / carteiras ----------------
  r.get("/accounts", h(async (req) => {
    const view = parseViewRequest(req.query.view);
    const ids = view === "me" ? [req.user!.id] : view === "family" ? (await listMembers(db)).map((m) => m.id) : [view];
    return listAccounts(db, req.user!, ids, req.query.archived === "1");
  }));
  r.post("/accounts", h(async (req) => createAccount(db, req.user!, req.body)));
  r.patch("/accounts/:id", h(async (req) => {
    await updateAccount(db, req.user!, idParam(req), req.body);
    return { ok: true };
  }));

  // ---------------- Transferências entre contas próprias ----------------
  r.get("/transfers", h(async (req) => listTransfers(db, req.user!)));
  r.post("/transfers", h(async (req) => createTransfer(db, req.user!, req.body)));
  r.delete("/transfers/:id", h(async (req) => {
    await deleteTransfer(db, req.user!, idParam(req));
    return { ok: true };
  }));

  // ---------------- Categorias ----------------
  r.get("/categories", h(async (req) => listCategories(db, req.query.archived === "1")));
  r.post("/categories", h(async (req) => createCategory(db, req.user!, req.body)));
  r.patch("/categories/:id", h(async (req) => {
    await updateCategory(db, req.user!, idParam(req), req.body);
    return { ok: true };
  }));

  // ---------------- Movimentações ----------------
  r.get("/transactions", h(async (req) => listTransactions(db, req.user!, parseViewRequest(req.query.view), req.query)));
  r.post("/transactions", h(async (req) => createTransaction(db, req.user!, req.body, "web", clientIp(req))));
  r.patch("/transactions/:id", h(async (req) => updateTransaction(db, req.user!, idParam(req), req.body, "web", clientIp(req))));
  r.post("/transactions/:id/pay", h(async (req) => {
    const date = req.body?.date;
    if (date !== undefined && !isIsoDate(date)) throw badRequest("Data inválida.");
    return markPaid(db, req.user!, idParam(req), date);
  }));
  r.delete("/transactions/:id", h(async (req) =>
    deleteTransaction(db, req.user!, idParam(req), req.query.scope === "group" ? "group" : "one", "web", clientIp(req))));

  r.get("/bills", h(async (req) => listBills(db, req.user!, parseViewRequest(req.query.view))));
  r.get("/recurrences", h(async (req) => listRecurrences(db, req.user!, parseViewRequest(req.query.view))));
  r.patch("/recurrences/:id", h(async (req) => {
    await updateRecurrence(db, req.user!, idParam(req), req.body);
    return { ok: true };
  }));

  // ---------------- Metas ----------------
  r.get("/goals", h(async (req) => listGoals(db, req.user!, { includeArchived: req.query.archived === "1" })));
  r.post("/goals", h(async (req) => createGoal(db, req.user!, req.body)));
  r.patch("/goals/:id", h(async (req) => updateGoal(db, req.user!, idParam(req), req.body)));
  r.delete("/goals/:id", h(async (req) => {
    await deleteGoal(db, req.user!, idParam(req));
    return { ok: true };
  }));
  r.get("/goals/:id/contributions", h(async (req) => listContributions(db, req.user!, idParam(req))));
  r.post("/goals/:id/contributions", h(async (req) => contribute(db, req.user!, idParam(req), req.body)));
  r.delete("/goals/:id/contributions/:cid", h(async (req) => {
    await deleteContribution(db, req.user!, idParam(req), idParam(req, "cid"));
    return { ok: true };
  }));

  // ---------------- Painel e relatórios ----------------
  r.get("/dashboard", h(async (req) => dashboard(db, req.user!, parseViewRequest(req.query.view), req.query.month as string | undefined)));
  r.get("/wallet", h(async (req) => wallet(db, req.user!, req.query.month as string | undefined)));
  r.get("/reports", h(async (req) =>
    report(db, req.user!, parseViewRequest(req.query.view), {
      year: req.query.year as string | undefined,
      month: req.query.month as string | undefined,
    })));
  r.get("/reports/export.csv", h(async (req, res) => {
    const def = monthRange(currentMonth());
    const from = isIsoDate(req.query.from) ? req.query.from : def.start;
    const to = isIsoDate(req.query.to) ? req.query.to : def.end;
    if (from > to) throw badRequest("Período inválido.");
    const csv = await exportCsv(db, req.user!, parseViewRequest(req.query.view), from, to);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="luna-finance_${from}_${to}.csv"`);
    res.send(csv);
  }));

  // ---------------- Telegram (vinculação) ----------------
  r.post("/telegram/link-code", rateLimit({ windowMs: 10 * 60000, max: 10, key: (req) => `lc:${req.user?.id}` }), h(async (req) =>
    createLinkCode(db, req.user!, config.telegram.botUsername)));
  r.delete("/telegram/link", h(async (req) => {
    await unlinkTelegram(db, req.user!.id, "web");
    return { ok: true };
  }));
  r.get("/telegram/status", h(async () => ({ configured: config.telegram.enabled, botUsername: config.telegram.botUsername || null })));

  // ---------------- Cartões e fatura da família ----------------
  r.get("/cards", h(async (req) => ({
    settings: await getCardSettings(db),
    ...(await listCards(db, req.user!)),
    invoice: await invoiceSummary(db, req.user!, req.query.month as string | undefined),
    limit: await limitStatus(db, req.user!),
  })));
  r.patch("/cards/settings", h(async (req) => updateCardSettings(db, req.user!, req.body ?? {})));

  // ---------------- Orçamentos ----------------
  r.get("/budgets", h(async (req) => budgetStatus(db, req.user!, req.query.month as string | undefined)));
  r.post("/budgets", h(async (req) => createBudget(db, req.user!, req.body)));
  r.delete("/budgets/:id", h(async (req) => {
    await archiveBudget(db, req.user!, idParam(req));
    return { ok: true };
  }));

  // ---------------- Sincronização: marcador de mudanças ----------------
  // O site consulta a cada poucos segundos; quando muda (ex.: lançamento pelo
  // WhatsApp), invalida as consultas do TanStack Query. Não traz dados.
  r.get("/sync", h(async () => {
    const { rows } = await db.query<{ v: string | null }>("SELECT max(id)::text AS v FROM audit_log");
    return { marker: rows[0].v ?? "0" };
  }));

  // ---------------- WhatsApp da própria pessoa ----------------
  r.get("/me/whatsapp", h(async (req) => ({ ...(await myWhatsApp(db, req.user!)), integrationEnabled: (await getIntegrationSettings(db)).enabled })));
  r.post("/me/whatsapp/link-code", rateLimit({ windowMs: 10 * 60000, max: 10, key: (req) => `wlc:${req.user?.id}` }), h(async (req) => createWhatsAppLinkCode(db, req.user!, req.body?.phone)));
  r.put("/me/whatsapp/pin", rateLimit({ windowMs: 10 * 60000, max: 10, key: (req) => `wpin:${req.user?.id}` }), h(async (req) => {
    await setPin(db, req.user!, req.body?.pin, req.body?.password);
    return { ok: true };
  }));
  r.delete("/me/whatsapp", h(async (req) => {
    await unlinkWhatsApp(db, req.user!, req.user!.id);
    return { ok: true };
  }));
  r.delete("/me/whatsapp/sessions", h(async (req) => ({ revoked: await revokeSessions(db, req.user!, req.user!.id) })));

  // ---------------- Integração OpenBot (quem gerencia a família) ----------------
  r.get("/integrations/openbot", h(async (req) => {
    assertCanManageFamily(req.user!);
    return integrationOverview(db);
  }));
  r.patch("/integrations/openbot/settings", h(async (req) => updateIntegrationSettings(db, req.user!, req.body ?? {})));
  r.post("/integrations/openbot/credentials", h(async (req) => createCredential(db, req.user!, req.body ?? {})));
  r.get("/integrations/openbot/credentials", h(async (req) => {
    assertCanManageFamily(req.user!);
    return listCredentials(db);
  }));
  r.delete("/integrations/openbot/credentials/:id", h(async (req) => {
    await revokeCredential(db, req.user!, idParam(req));
    return { ok: true };
  }));
  r.post("/integrations/openbot/members/:id/link", h(async (req) => adminLink(db, req.user!, idParam(req), req.body?.phone)));
  r.delete("/integrations/openbot/members/:id/link", h(async (req) => {
    await unlinkWhatsApp(db, req.user!, idParam(req));
    return { ok: true };
  }));
  r.delete("/integrations/openbot/members/:id/sessions", h(async (req) => ({ revoked: await revokeSessions(db, req.user!, idParam(req)) })));
  r.delete("/integrations/openbot/members/:id/pin", h(async (req) => {
    await resetPin(db, req.user!, idParam(req));
    return { ok: true };
  }));
  r.post("/integrations/openbot/test", h(async (req) => {
    assertCanManageFamily(req.user!);
    return selfTest(db);
  }));

  r.get("/health/me", h(async () => ({ today: today() })));
  return r;
}
