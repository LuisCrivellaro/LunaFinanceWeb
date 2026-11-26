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

  r.get("/health/me", h(async () => ({ today: today() })));
  return r;
}
