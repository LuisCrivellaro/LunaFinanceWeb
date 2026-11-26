/**
 * Integração OpenBot/WhatsApp — identidade, escrita por rascunho, idempotência,
 * permissões, isolamento, fatura consolidada, fila de avisos e sincronização.
 * Somente dados fictícios (números fictícios +55 11 98765-000X).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminLink, createCredential, createLinkCode, setPin, updateSettings } from "../src/integrations/openbot/identity.js";
import { buildOpenApi } from "../src/integrations/openbot/openapi.js";
import { enqueueChannelNotifications } from "../src/notifications/queue.js";
import type { AuthUser } from "../src/services/access.js";
import { getAuthUser } from "../src/services/auth.js";
import { updateCardSettings } from "../src/services/cards.js";
import { createPending } from "../src/telegram/state.js";
import { PASSWORD, setupTestApp, type FamilyKey, type TestApp } from "./helpers.js";

const BASE = "/api/integrations/openbot/v1";
const PHONES: Record<FamilyKey, string> = { luis: "+5511987650001", luciana: "+5511987650002", lipe: "+5511987650003", joao: "+5511987650004" };
const PINS: Record<FamilyKey, string> = { luis: "482915", luciana: "730164", lipe: "915372", joao: "264810" };

let t: TestApp;
let key: string;
let lipe: AuthUser;
const sessions = {} as Record<FamilyKey, string>;
let seq = 0;
const idem = (tag: string) => `wa:test:${++seq}:${tag.replace(/[^A-Za-z0-9:._@-]/g, ".")}`;

function call(method: "get" | "post" | "delete", path: string, opts: { who?: FamilyKey; sender?: string; key?: string | null; idem?: string; body?: unknown } = {}) {
  let r = request(t.app)[method](BASE + path);
  const k = opts.key === undefined ? key : opts.key;
  if (k) r = r.set("Authorization", `Bearer ${k}`);
  if (opts.who) r = r.set("X-Luna-Session", sessions[opts.who]).set("X-Luna-Sender", opts.sender ?? PHONES[opts.who].slice(1));
  if (opts.idem) r = r.set("Idempotency-Key", opts.idem);
  return opts.body !== undefined ? r.send(opts.body as object) : r;
}
const post = (path: string, who: FamilyKey, body: unknown, key2 = idem(path)) => call("post", path, { who, body, idem: key2 });
const txCount = async (userId?: number) =>
  (await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM transactions WHERE deleted_at IS NULL AND ($1::int IS NULL OR user_id = $1)", [userId ?? null])).rows[0].n;

beforeAll(async () => {
  t = await setupTestApp(); // hoje = 2026-11-14 (São Paulo)
  lipe = (await getAuthUser(t.db, t.ids.lipe))!;
  await updateSettings(t.db, lipe, { enabled: true });
  key = (await createCredential(t.db, lipe, { name: "OpenBot teste" })).key;
  await updateCardSettings(t.db, lipe, { holderUserId: t.ids.luis, closingDay: 5, dueDay: 12, limitCents: 2_000_000 });
  await t.db.query("UPDATE users SET card_last4 = '4821' WHERE id = $1", [t.ids.luis]);
  await t.db.query("UPDATE users SET card_last4 = '7310' WHERE id = $1", [t.ids.lipe]);
  for (const k of Object.keys(PHONES) as FamilyKey[]) {
    const u = (await getAuthUser(t.db, t.ids[k]))!;
    await adminLink(t.db, lipe, u.id, PHONES[k]);
    await setPin(t.db, u, PINS[k], PASSWORD);
    // a plataforma informa o número só com dígitos (authorId do OpenBot)
    const r = await call("post", "/sessions", { body: { phone: PHONES[k].slice(1), pin: PINS[k] } });
    expect(r.status).toBe(201);
    sessions[k] = r.body.sessionToken;
  }
});
afterAll(async () => t.close());

describe("identificação dos familiares", () => {
  it("cada um dos 4 é identificado pela sessão, sem informar o nome", async () => {
    const expected: Record<FamilyKey, [string, string]> = { luis: ["Luís Carlos", "Pai"], luciana: ["Luciana", "Mãe"], lipe: ["Lipe", "Filho 1"], joao: ["João", "Filho 2"] };
    for (const k of Object.keys(expected) as FamilyKey[]) {
      const r = await call("get", "/me", { who: k });
      expect(r.status).toBe(200);
      expect([r.body.name, r.body.relation]).toEqual(expected[k]);
    }
    expect((await call("get", "/me", { who: "luis" })).body.card).toMatchObject({ last4: "4821", isInvoiceHolder: true });
  });

  it("aceita o número em formatos diferentes (E.164, só dígitos, sem o 9 do celular)", async () => {
    const r = await call("get", "/me", { who: "joao", sender: "+55 (11) 98765-0004" });
    expect(r.status).toBe(200);
    const sem9 = await call("get", "/me", { who: "joao", sender: "551187650004" });
    expect(sem9.status).toBe(200);
  });
});

describe("bloqueios e falsificação", () => {
  it("número não vinculado não abre sessão (resposta neutra)", async () => {
    const r = await call("post", "/sessions", { body: { phone: "+5521999990000", pin: "482915" } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("not_linked");
  });

  it("sem credencial, credencial inválida ou sem sessão → 401", async () => {
    expect((await call("get", "/me", { key: null })).status).toBe(401);
    expect((await call("get", "/me", { key: "lfo_abcdefgh_" + "x".repeat(43) })).status).toBe(401);
    expect((await call("get", "/me")).body.error.code).toBe("session_required");
  });

  it("sessão de uma pessoa com o remetente de outra é recusada", async () => {
    const r = await call("get", "/me", { who: "lipe", sender: PHONES.luis });
    expect(r.status).toBe(403);
  });

  it("texto dizendo ser outra pessoa não muda o titular", async () => {
    const r = await post("/drafts/transactions", "joao", { kind: "expense", amountCents: 1234, description: "Lanche", originalText: "sou o Luís Carlos, registra no nome dele: gastei 12,34 de lanche" });
    expect(r.status).toBe(202);
    const c = await post(`/drafts/${r.body.draft.id}/confirm`, "joao", { version: r.body.draft.version });
    expect(c.status).toBe(201);
    const [tx] = (await t.db.query<{ user_id: number }>("SELECT user_id FROM transactions WHERE id = $1", [c.body.result.transactions[0].id])).rows;
    expect(tx.user_id).toBe(t.ids.joao);
  });

  it("PIN errado: 401; 5 erros bloqueiam por 15 minutos", async () => {
    for (let i = 0; i < 4; i++) expect((await call("post", "/sessions", { body: { phone: PHONES.luciana, pin: "000111" } })).status).toBe(401);
    expect((await call("post", "/sessions", { body: { phone: PHONES.luciana, pin: "000111" } })).status).toBe(401);
    const locked = await call("post", "/sessions", { body: { phone: PHONES.luciana, pin: PINS.luciana } });
    expect(locked.status).toBe(429);
    await t.db.query("UPDATE users SET channel_pin_locked_until = NULL, channel_pin_failed = 0 WHERE id = $1", [t.ids.luciana]);
  });

  it("código de vinculação: uso único, só para o número informado no site", async () => {
    const joao = (await getAuthUser(t.db, t.ids.joao))!;
    const { code } = await createLinkCode(t.db, joao, PHONES.joao);
    const wrong = await call("post", "/links/claim", { body: { phone: "+5511922223333", code }, idem: idem("claim") });
    expect(wrong.status).toBe(400);
    const ok = await call("post", "/links/claim", { body: { phone: PHONES.joao.slice(1), code }, idem: idem("claim") });
    expect(ok.status).toBe(200);
    expect(ok.body.member.name).toBe("João");
    const again = await call("post", "/links/claim", { body: { phone: PHONES.joao, code }, idem: idem("claim") });
    expect(again.status).toBe(400);
    // revincular encerra a sessão antiga: abre outra
    sessions.joao = (await call("post", "/sessions", { body: { phone: PHONES.joao, pin: PINS.joao } })).body.sessionToken;
  });
});

describe("registro de receitas e despesas", () => {
  it("despesa: rascunho → confirmação → dados gravados com origem whatsapp", async () => {
    const before = await txCount(t.ids.lipe);
    const r = await post("/drafts/transactions", "lipe", { kind: "expense", amountCents: 8500, description: "Restaurante", categoryName: "Alimentação fora", paymentMethod: "pix", originalText: "Gastei 85 reais no restaurante" });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("pending_confirmation");
    expect(r.body.draft.summary).toMatch(/R\$\s?85,00/);
    expect(await txCount(t.ids.lipe)).toBe(before); // nada gravado ainda
    const c = await post(`/drafts/${r.body.draft.id}/confirm`, "lipe", { version: 1 });
    expect(c.status).toBe(201);
    const tx = c.body.result.transactions[0];
    expect(tx).toMatchObject({ kind: "expense", amountCents: 8500, paymentMethod: "pix", source: "whatsapp" });
    expect(await txCount(t.ids.lipe)).toBe(before + 1);
  });

  it("receita só com o texto: o valor vem do parser, não da IA", async () => {
    const r = await post("/drafts/transactions", "luciana", { kind: "income", originalText: "Recebi 5 mil de salário" });
    expect(r.status).toBe(202);
    expect(r.body.draft.data.amountCents).toBe(500000);
  });

  it("sem valor → needs_info e nada é gravado", async () => {
    const before = await txCount();
    const r = await post("/drafts/transactions", "lipe", { kind: "expense", description: "mercado" });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: "needs_info", missing: ["amount"] });
    expect(await txCount()).toBe(before);
  });

  it("valor da intenção diferente do texto → aviso e confirmação obrigatória", async () => {
    const r = await post("/drafts/transactions", "lipe", { kind: "expense", amountCents: 9000, originalText: "paguei 250 de mercado no pix" });
    expect(r.body.draft.warnings.map((w: { code: string }) => w.code)).toContain("amount_mismatch");
  });

  it("compra parcelada no cartão: 12 parcelas, faturas futuras, confirmação obrigatória", async () => {
    const r = await post("/drafts/transactions", "lipe", { kind: "expense", amountCents: 360000, description: "Celular", installments: 12, paymentMethod: "credit_card", originalText: "Comprei um celular de 3.600 em 12 vezes" });
    expect(r.status).toBe(202);
    expect(r.body.draft.confirmationReasons).toContain("installments");
    const plan = r.body.draft.data.plan;
    expect(plan).toHaveLength(12);
    expect(plan[0]).toMatchObject({ amountCents: 30000, invoiceMonth: "2026-12" }); // comprou dia 14, fechamento dia 5
    expect(plan[11].invoiceMonth).toBe("2027-11");
    const c = await post(`/drafts/${r.body.draft.id}/confirm`, "lipe", { version: 1 });
    expect(c.body.result.transactions).toHaveLength(12);
    expect(c.body.result.transactions.every((x: { source: string }) => x.source === "whatsapp")).toBe(true);
  });

  it("recorrência mensal fica prevista (pendente), não paga", async () => {
    const r = await post("/drafts/transactions", "luis", { kind: "expense", amountCents: 12990, description: "Internet", recurrence: { autoPaid: false }, date: "2026-11-20" });
    expect(r.body.draft.confirmationReasons).toContain("recurrence");
    const c = await post(`/drafts/${r.body.draft.id}/confirm`, "luis", { version: 1 });
    expect(c.status).toBe(201);
    expect(c.body.result.transactions[0].status).toBe("pending");
  });

  it("transferência entre contas próprias não é receita nem despesa", async () => {
    const lu = await t.as("luciana");
    await lu.post("/api/accounts").send({ name: "Poupança", type: "savings", initialBalanceCents: 0 });
    const r = await post("/drafts/transfers", "luciana", { amountCents: 50000, fromAccountName: "Conta principal", toAccountName: "Poupança" });
    expect(r.status).toBe(202);
    const before = await txCount(t.ids.luciana);
    const c = await post(`/drafts/${r.body.draft.id}/confirm`, "luciana", { version: 1 });
    expect(c.body.result.transfer.amountCents).toBe(50000);
    expect(await txCount(t.ids.luciana)).toBe(before);
  });
});

describe("duplicidade, retentativas e concorrência", () => {
  it("mesma Idempotency-Key + mesmo corpo → mesma resposta, sem novo rascunho", async () => {
    const k = idem("retry");
    const body = { kind: "expense", amountCents: 4590, description: "Farmácia" };
    const a = await post("/drafts/transactions", "luciana", body, k);
    const b = await post("/drafts/transactions", "luciana", body, k);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(b.body.draft.id).toBe(a.body.draft.id);
    const reused = await post("/drafts/transactions", "luciana", { ...body, amountCents: 9999 }, k);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe("idempotency_key_reused");
  });

  it("lançamento parecido já existente → aviso de possível duplicidade", async () => {
    const r1 = await post("/drafts/transactions", "joao", { kind: "expense", amountCents: 2500, description: "Cinema" });
    await post(`/drafts/${r1.body.draft.id}/confirm`, "joao", { version: 1 });
    const r2 = await post("/drafts/transactions", "joao", { kind: "expense", amountCents: 2500, description: "Cinema" });
    expect(r2.body.draft.warnings.map((w: { code: string }) => w.code)).toContain("possible_duplicate");
    expect(r2.body.draft.confirmationReasons).toContain("possible_duplicate");
  });

  it("confirmação repetida (retentativa após timeout) devolve o mesmo resultado", async () => {
    const r = await post("/drafts/transactions", "joao", { kind: "expense", amountCents: 777, description: "Bala" });
    const before = await txCount(t.ids.joao);
    const c1 = await post(`/drafts/${r.body.draft.id}/confirm`, "joao", { version: 1 });
    const c2 = await post(`/drafts/${r.body.draft.id}/confirm`, "joao", { version: 1 });
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);
    expect(c2.body.replayed).toBe(true);
    expect(c2.body.result.transactions[0].id).toBe(c1.body.result.transactions[0].id);
    expect(await txCount(t.ids.joao)).toBe(before + 1);
  });

  it("confirmações simultâneas gravam uma única vez", async () => {
    const r = await post("/drafts/transactions", "luis", { kind: "expense", amountCents: 3333, description: "Padaria" });
    const before = await txCount(t.ids.luis);
    const results = await Promise.all([1, 2, 3].map(() => post(`/drafts/${r.body.draft.id}/confirm`, "luis", { version: 1 })));
    expect(results.every((x) => x.status === 201 || x.status === 409)).toBe(true);
    expect(results.filter((x) => x.status === 201 && x.body.replayed === false)).toHaveLength(1);
    expect(await txCount(t.ids.luis)).toBe(before + 1);
  });

  it("versão desatualizada ou rascunho cancelado não grava", async () => {
    const r = await post("/drafts/transactions", "luis", { kind: "expense", amountCents: 100, description: "Teste" });
    expect((await post(`/drafts/${r.body.draft.id}/confirm`, "luis", { version: 7 })).status).toBe(409);
    expect((await post(`/drafts/${r.body.draft.id}/cancel`, "luis", {})).status).toBe(200);
    const c = await post(`/drafts/${r.body.draft.id}/confirm`, "luis", { version: 1 });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("draft_cancelled");
  });
});

describe("correção e exclusão", () => {
  it("corrige a última despesa para 150 reais (sempre com confirmação)", async () => {
    const r = await post("/drafts/corrections", "lipe", { target: { last: "expense" }, changes: { amount: "150" } });
    expect(r.status).toBe(202);
    expect(r.body.draft.confirmationReasons).toContain("correction");
    const c = await post(`/drafts/${r.body.draft.id}/confirm`, "lipe", { version: 1 });
    expect(c.body.result.transaction.amountCents).toBe(15000);
  });

  it("exclui com confirmação; não alcança lançamento de outra pessoa", async () => {
    const { rows } = await t.db.query<{ id: number }>("SELECT id FROM transactions WHERE user_id = $1 LIMIT 1", [t.ids.luis]);
    const other = await post("/drafts/deletions", "lipe", { target: { transactionId: rows[0].id } });
    expect(other.status).toBe(404);
    const r = await post("/drafts/deletions", "joao", { target: { last: "expense" } });
    expect(r.status).toBe(202);
    const before = await txCount(t.ids.joao);
    await post(`/drafts/${r.body.draft.id}/confirm`, "joao", { version: 1 });
    expect(await txCount(t.ids.joao)).toBe(before - 1);
  });
});

describe("permissões e isolamento", () => {
  it("rascunho de uma pessoa não é visto nem confirmado por outra", async () => {
    const r = await post("/drafts/transactions", "luciana", { kind: "expense", amountCents: 5000, description: "Feira" });
    expect((await call("get", `/drafts/${r.body.draft.id}`, { who: "lipe" })).status).toBe(404);
    expect((await post(`/drafts/${r.body.draft.id}/confirm`, "lipe", { version: 1 })).status).toBe(404);
  });

  it("rascunho do Telegram não é confirmado pelo WhatsApp", async () => {
    const p = await createPending(t.db, t.ids.lipe, 999, { kind: "tx_delete", del: { txId: 1, description: "x", amountCents: 1, date: "2026-11-01", kind: "expense" } });
    expect((await post(`/drafts/${p.id}/confirm`, "lipe", { version: 1 })).status).toBe(404);
  });

  it("acesso 'summary': totais da família sim, lançamentos alheios não", async () => {
    await t.setAccess("joao", "summary");
    expect((await call("get", "/summary?scope=family", { who: "joao" })).status).toBe(200);
    expect((await call("get", "/transactions?scope=family", { who: "joao" })).status).toBe(403);
    await t.setAccess("joao", "full");
  });

  it("acesso 'none': nada da família, nem a fatura consolidada", async () => {
    await t.setAccess("luciana", "none");
    expect((await call("get", "/summary?scope=family", { who: "luciana" })).status).toBe(403);
    const inv = await call("get", "/invoices", { who: "luciana" });
    expect(inv.body.totalCents).toBeNull();
    expect(inv.body.perMember.every((m: { userId: number }) => m.userId === t.ids.luciana)).toBe(true);
    await t.setAccess("luciana", "full");
  });
});

describe("cartões e fatura consolidada", () => {
  it("fatura do ciclo junta os titulares; mês calendário é separado", async () => {
    const r = await post("/drafts/transactions", "luciana", { kind: "expense", amountCents: 18000, description: "Roupa", paymentMethod: "credit_card", originalText: "Passei 180 reais no cartão" });
    await post(`/drafts/${r.body.draft.id}/confirm`, "luciana", { version: 1 });
    const inv = await call("get", "/invoices", { who: "luis" });
    expect(inv.body).toMatchObject({ cycleConfigured: true, invoiceMonth: "2026-12", from: "2026-11-05", to: "2026-12-04", dueDate: "2026-12-12" });
    const by = Object.fromEntries(inv.body.perMember.map((m: { name: string; cents: number }) => [m.name, m.cents]));
    expect(by["Luciana"]).toBe(18000);
    expect(by["Lipe"]).toBe(30000); // 1ª parcela do celular
    expect(inv.body.totalCents).toBe(18000 + 30000);
    expect(inv.body.calendarMonth.month).toBe("2026-12");
  });

  it("pagar a fatura: só o titular, e não cria despesa nova", async () => {
    expect((await post("/drafts/invoice-payments", "luciana", { invoiceMonth: "2026-12" })).status).toBe(403);
    const before = await txCount();
    const r = await post("/drafts/invoice-payments", "luis", { invoiceMonth: "2026-12", amountCents: 48000, paidAt: "2026-11-14" });
    expect(r.status).toBe(202);
    const c = await post(`/drafts/${r.body.draft.id}/confirm`, "luis", { version: 1 });
    expect(c.status).toBe(201);
    expect(await txCount()).toBe(before);
    expect((await call("get", "/invoices?month=2026-12", { who: "luis" })).body.status).toBe("paid");
  });

  it("limite compartilhado e cartões cadastrados", async () => {
    const r = await call("get", "/cards", { who: "luis" });
    expect(r.body.limit).toMatchObject({ configured: true, limitCents: 2_000_000 });
    expect(r.body.cards.find((c: { name: string }) => c.name === "Luís Carlos")).toMatchObject({ last4: "4821", isHolder: true });
    expect(JSON.stringify(r.body)).not.toMatch(/\d{13,}/); // nenhum número de cartão completo
  });
});

describe("consultas", () => {
  it("quanto gastei este mês / quanto posso gastar / metas / orçamentos", async () => {
    const s = await call("get", "/summary?period=this_month", { who: "lipe" });
    expect(s.status).toBe(200);
    expect(s.body.expenseCents).toBeGreaterThan(0);
    const sp = await call("get", "/spendable", { who: "lipe" });
    expect(sp.body).toHaveProperty("availableCents");
    expect((await call("get", "/goals", { who: "lipe" })).status).toBe(200);
    expect((await call("get", "/budgets", { who: "lipe" })).status).toBe(200);
    expect((await call("get", "/catalog", { who: "lipe" })).body.categories.length).toBeGreaterThan(0);
  });

  it("interpret usa o parser do Telegram e não grava", async () => {
    const before = await txCount();
    const r = await call("post", "/interpret", { who: "lipe", body: { text: "Comprei um celular de 3.600 em 12 vezes" } });
    expect(r.body.type).toBe("transaction");
    expect(r.body.suggested).toMatchObject({ amountCents: 360000, installments: 12 });
    expect(await txCount()).toBe(before);
  });
});

describe("sincronização com o site", () => {
  it("lançamento pelo WhatsApp muda o marcador e aparece no Wallet Stack", async () => {
    const web = await t.as("lipe");
    const m1 = (await web.get("/api/sync")).body.marker;
    const r = await post("/drafts/transactions", "lipe", { kind: "expense", amountCents: 6000, description: "Uber", paymentMethod: "credit_card" });
    await post(`/drafts/${r.body.draft.id}/confirm`, "lipe", { version: 1 });
    const m2 = (await web.get("/api/sync")).body.marker;
    expect(m2).not.toBe(m1);
    const w = await web.get("/api/wallet?month=2026-11");
    const lipeCard = w.body.cards.find((c: { name: string }) => c.name === "Lipe");
    expect(lipeCard.cardCents).toBeGreaterThanOrEqual(6000 + 30000);
    const list = await web.get("/api/transactions?view=me&from=2026-11-01&to=2026-11-30");
    expect(list.body.items.some((i: { source: string; description: string }) => i.source === "whatsapp" && i.description === "Uber")).toBe(true);
  });
});

describe("fila de avisos", () => {
  it("enfileira sem duplicar, entrega por claim/ack e não reenvia o entregue", async () => {
    const lu = await t.as("luis");
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 20000, description: "Condomínio", date: "2026-11-16", status: "pending" });
    const first = await enqueueChannelNotifications(t.ctx, { force: true });
    expect(first.due).toBeGreaterThanOrEqual(1);
    const again = await enqueueChannelNotifications(t.ctx, { force: true });
    expect(again.due).toBe(0);
    const claim = await call("get", "/notifications/pending?limit=50");
    const item = claim.body.items.find((i: { kind: string; payload: { data: { description?: string } } }) => i.kind === "bill_due" && i.payload.data.description === "Condomínio");
    expect(item.recipient.phoneE164).toBe(PHONES.luis);
    const ack = await call("post", `/notifications/${item.id}/ack`, { body: { claimToken: item.claimToken, status: "delivered" }, idem: idem("ack") });
    expect(ack.status).toBe(200);
    const after = await call("get", "/notifications/pending?limit=50");
    expect(after.body.items.some((i: { id: number }) => i.id === item.id)).toBe(false);
  });
});

describe("revogação e desligamento", () => {
  it("integração desligada → 503 (health continua respondendo)", async () => {
    await updateSettings(t.db, lipe, { enabled: false });
    expect((await call("get", "/health")).body.integrationEnabled).toBe(false);
    expect((await call("get", "/catalog", { who: "lipe" })).status).toBe(503);
    await updateSettings(t.db, lipe, { enabled: true });
    // desligar derrubou as sessões: precisa abrir de novo
    expect((await call("get", "/me", { who: "lipe" })).status).toBe(401);
    sessions.lipe = (await call("post", "/sessions", { body: { phone: PHONES.lipe, pin: PINS.lipe } })).body.sessionToken;
    expect((await call("get", "/me", { who: "lipe" })).status).toBe(200);
  });

  it("desvincular pelo site corta a sessão na hora", async () => {
    const web = await t.as("joao");
    await web.del("/api/me/whatsapp");
    expect((await call("get", "/me", { who: "joao" })).status).toBe(401);
  });

  it("credencial revogada para de funcionar", async () => {
    const web = await t.as("lipe");
    const created = await web.post("/api/integrations/openbot/credentials").send({ name: "temporária" });
    expect(created.body.key).toMatch(/^lfo_/);
    const k2 = created.body.key as string;
    expect((await call("get", "/health", { key: k2 })).status).toBe(200);
    await web.del(`/api/integrations/openbot/credentials/${created.body.id}`);
    expect((await call("get", "/health", { key: k2 })).status).toBe(401);
  });

  it("painel: só quem gerencia vê; telefones mascarados; histórico sem valores", async () => {
    expect((await (await t.as("luciana")).get("/api/integrations/openbot")).status).toBe(403);
    const r = await (await t.as("lipe")).get("/api/integrations/openbot");
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain("5511987650001");
    expect(body).not.toMatch(/key_hash|lfo_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20}/);
    expect(r.body.whatsapp.status).toBe("recent_activity");
    expect(r.body.events.length).toBeGreaterThan(0);
  });
});

describe("OpenAPI", () => {
  it("integrations/openbot/openapi.json está em dia com o código", () => {
    const file = JSON.parse(readFileSync(resolve(process.cwd(), "integrations/openbot/openapi.json"), "utf8"));
    expect(file).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });
});
