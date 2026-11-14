/**
 * Bot v3 — transferências, gestão de lançamentos já registrados, contexto,
 * consultas analíticas, limites, falhas de IA/Telegram/banco e migração 3.
 * Somente dados fictícios em banco PGlite em memória.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/context.js";
import { createDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { migrations } from "../src/db/migrations.js";
import { setNow } from "../src/lib/clock.js";
import { createTelegramApi, TelegramError } from "../src/telegram/api.js";
import { createAssistant, type MessagesClient } from "../src/telegram/assistant.js";
import type { TgUpdate } from "../src/telegram/bot.js";
import { aiLimiter, messageLimiter } from "../src/telegram/throttle.js";
import { WEBHOOK_SECRET, setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let updateId = 50_000;
const TG = { luciana: 7001, joao: 7004 };
const NOW = "2026-11-14T15:00:00Z"; // sábado, 12h em São Paulo
let acc: { principal: number; nubank: number; poupanca: number };

beforeAll(async () => {
  t = await setupTestApp({ now: NOW });
  const lu = await t.as("luciana");
  acc = {
    principal: (await t.db.query<{ id: number }>("SELECT id FROM accounts WHERE owner_id = $1", [t.ids.luciana])).rows[0].id,
    nubank: (await lu.post("/api/accounts").send({ name: "Nubank", type: "checking", initialBalanceCents: 100000 })).body.id,
    poupanca: (await lu.post("/api/accounts").send({ name: "Poupança", type: "savings", initialBalanceCents: 0 })).body.id,
  };
  for (const [key, tg] of [["luciana", TG.luciana], ["joao", TG.joao]] as const) {
    const code = (await (await t.as(key)).post("/api/telegram/link-code")).body.code;
    await send(msg(tg, `/vincular ${code}`));
  }
});
afterAll(async () => {
  setNow(null);
  await t.close();
});
beforeEach(() => {
  t.tg.clear();
  setNow(NOW);
  messageLimiter.reset();
  aiLimiter.reset();
});

function send(update: Omit<TgUpdate, "update_id"> & { update_id?: number }) {
  return request(t.app).post("/telegram/webhook").set("x-telegram-bot-api-secret-token", WEBHOOK_SECRET).send({ update_id: update.update_id ?? updateId++, ...update });
}
const msg = (from: number, text: string) => ({ message: { message_id: 1, from: { id: from }, chat: { id: from, type: "private" }, date: 0, text } });
const cb = (from: number, data: string) => ({ callback_query: { id: `c${updateId}`, from: { id: from }, data, message: { message_id: 9, chat: { id: from, type: "private" }, date: 0 } } });
const lastText = () => [...t.tg.sent].reverse().find((s) => s.text && s.method !== "answerCallbackQuery")?.text ?? "";
const answers = () => t.tg.sent.filter((s) => s.method === "answerCallbackQuery").map((s) => s.text ?? "").join(" | ");
function buttons() {
  const m = [...t.tg.sent].reverse().find((s) => s.opts?.reply_markup && "inline_keyboard" in s.opts.reply_markup);
  return m ? (m.opts!.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard.flat() : [];
}
const button = (label: string) => {
  const b = buttons().find((x) => x.text.includes(label));
  if (!b) throw new Error(`botão "${label}" ausente: ${buttons().map((x) => x.text).join(", ")}`);
  return b.callback_data!;
};
async function balances() {
  const r = await (await t.as("luciana")).get("/api/accounts");
  return Object.fromEntries(r.body.map((a: { id: number; balanceCents: number }) => [a.id, a.balanceCents]));
}
async function addTx(key: "luciana" | "joao", body: Record<string, unknown>) {
  return (await (await t.as(key)).post("/api/transactions").send({ date: "2026-11-14", kind: "expense", ...body })).body[0].id as number;
}

// ============================================================================
describe("transferências entre contas", () => {
  it("“transferi 500 do Nubank para a poupança” → cartão → confirma → saldos mudam, totais do mês não", async () => {
    const before = await balances();
    const dashBefore = (await (await t.as("luciana")).get("/api/dashboard")).body.totals;
    await send(msg(TG.luciana, "transferi 500 do Nubank para a poupança"));
    expect(lastText()).toMatch(/Transferência: R\$ 500,00[\s\S]*De: Nubank[\s\S]*Para: Poupança/);
    expect(lastText()).toMatch(/Não conta como receita nem despesa/);
    await send(cb(TG.luciana, button("Confirmar")));
    expect(lastText()).toMatch(/Transferência registrada/);
    const after = await balances();
    expect(after[acc.nubank]).toBe(before[acc.nubank] - 50000);
    expect(after[acc.poupanca]).toBe(before[acc.poupanca] + 50000);
    const dashAfter = (await (await t.as("luciana")).get("/api/dashboard")).body;
    expect(dashAfter.totals).toEqual(dashBefore); // receitas/despesas inalteradas
    const list = await (await t.as("luciana")).get("/api/transfers");
    expect(list.body[0]).toMatchObject({ fromAccountName: "Nubank", toAccountName: "Poupança", amountCents: 50000, source: "telegram" });
    // excluir pelo site desfaz o efeito nos saldos
    await (await t.as("luciana")).del(`/api/transfers/${list.body[0].id}`);
    expect(await balances()).toEqual(before);
  });

  it("conta faltando: pede para escolher e só confirma com as duas definidas", async () => {
    await send(msg(TG.luciana, "passei 200 pra poupança"));
    expect(lastText()).toMatch(/De qual conta para qual conta/);
    const id = buttons()[0].callback_data!.split(":")[1];
    await send(cb(TG.luciana, `c:${id}:1`));
    expect(answers()).toMatch(/Escolha as contas/);
    await send(cb(TG.luciana, button("De: Nubank")));
    expect(lastText()).toMatch(/De: Nubank[\s\S]*Para: Poupança[\s\S]*Deseja confirmar/);
    await send(cb(TG.luciana, button("Confirmar")));
    expect(lastText()).toMatch(/Transferência registrada/);
  });

  it("não aceita conta de outra pessoa nem origem = destino", async () => {
    const joaoAcc = (await t.db.query<{ id: number }>("SELECT id FROM accounts WHERE owner_id = $1", [t.ids.joao])).rows[0].id;
    const r1 = await (await t.as("luciana")).post("/api/transfers").send({ fromAccountId: acc.nubank, toAccountId: joaoAcc, amountCents: 100 });
    expect(r1.status).toBe(400);
    const r2 = await (await t.as("luciana")).post("/api/transfers").send({ fromAccountId: acc.nubank, toAccountId: acc.nubank, amountCents: 100 });
    expect(r2.status).toBe(400);
    const r3 = await (await t.as("joao")).del(`/api/transfers/${(await (await t.as("luciana")).get("/api/transfers")).body[0].id}`);
    expect(r3.status).toBe(403);
  });

  it("quem tem só uma conta recebe orientação; “transferi 100 pro João” pergunta o tipo", async () => {
    await send(msg(TG.joao, "transferi 100 entre minhas contas"));
    expect(lastText()).toMatch(/pelo menos duas contas/);
    await send(msg(TG.luciana, "transferi 100 pro João"));
    expect(lastText()).toMatch(/despesa ou uma receita/);
    expect(buttons().map((b) => b.text)).toContain("🔁 Transferência entre minhas contas");
    await send(cb(TG.luciana, button("Cancelar")));
  });
});

describe("editar e excluir lançamentos já registrados", () => {
  it("/despesas → ✏️ → valor → confirmação mostra antes/depois → aplica no banco e no site", async () => {
    const id = await addTx("luciana", { amountCents: 4500, description: "Almoço", categoryId: await t.categoryId("Alimentação fora") });
    await send(msg(TG.luciana, "/despesas"));
    await send(cb(TG.luciana, button("✏️ Almoço")));
    expect(lastText()).toMatch(/Almoço[\s\S]*R\$ 45,00[\s\S]*O que deseja fazer/);
    await send(cb(TG.luciana, button("Valor")));
    await send(msg(TG.luciana, "50,00"));
    expect(lastText()).toMatch(/Alterar lançamento[\s\S]*R\$ 45,00 → <b>R\$ 50,00<\/b>/);
    expect((await t.db.query("SELECT amount_cents FROM transactions WHERE id = $1", [id])).rows[0].amount_cents).toBe(4500);
    const c = button("Confirmar");
    await Promise.all([send(cb(TG.luciana, c)), send(cb(TG.luciana, c))]);
    expect((await t.db.query("SELECT amount_cents FROM transactions WHERE id = $1", [id])).rows[0].amount_cents).toBe(5000);
    const web = await (await t.as("luciana")).get("/api/transactions?q=Almoço");
    expect(web.body.items[0].amountCents).toBe(5000);
    const audits = await t.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'transaction.update' AND entity_id = $1 AND source = 'telegram'", [String(id)]);
    expect(audits.rows[0].n).toBe(1); // clique duplo aplicou uma única vez
  });

  it("categoria e data", async () => {
    const id = await addTx("luciana", { amountCents: 3000, description: "Táxi" });
    await send(cb(TG.luciana, `m:${id}`));
    await send(cb(TG.luciana, button("Categoria")));
    await send(cb(TG.luciana, button("Transporte")));
    await send(cb(TG.luciana, button("Confirmar")));
    await send(cb(TG.luciana, `mf:${id}:date`));
    await send(msg(TG.luciana, "ontem"));
    await send(cb(TG.luciana, button("Confirmar")));
    const { rows } = await t.db.query("SELECT t.date, c.name FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id = $1", [id]);
    expect(rows[0]).toEqual({ date: "2026-11-13", name: "Transporte" });
  });

  it("“apaga a última despesa” pede confirmação e exclui; cancelar não exclui", async () => {
    const keep = await addTx("luciana", { amountCents: 1100, description: "Pão" });
    await send(msg(TG.luciana, "apaga a última despesa"));
    expect(lastText()).toMatch(/Excluir despesa\?[\s\S]*Pão/);
    await send(cb(TG.luciana, button("Cancelar")));
    expect((await t.db.query("SELECT deleted_at FROM transactions WHERE id = $1", [keep])).rows[0].deleted_at).toBeNull();
    await send(msg(TG.luciana, "apaga a última despesa"));
    await send(cb(TG.luciana, button("Excluir")));
    expect(lastText()).toMatch(/Excluído/);
    expect((await t.db.query("SELECT deleted_at FROM transactions WHERE id = $1", [keep])).rows[0].deleted_at).not.toBeNull();
    // editar algo já excluído não é possível
    t.tg.clear();
    await send(cb(TG.luciana, `m:${keep}`));
    expect(lastText()).toMatch(/não está disponível/);
  });

  it("segurança: João não gerencia lançamentos da Luciana por nenhum botão", async () => {
    const id = await addTx("luciana", { amountCents: 7700, description: "Farmácia" });
    for (const data of [`m:${id}`, `mf:${id}:amount`, `md:${id}`, `mc:${id}:${await t.categoryId("Lazer")}`]) {
      t.tg.clear();
      await send(cb(TG.joao, data));
      expect(lastText()).toMatch(/não está disponível \(ou não é seu\)/);
    }
    // rascunho de exclusão da Luciana não pode ser confirmado pelo João
    await send(cb(TG.luciana, `md:${id}`));
    const c = button("Excluir");
    await send(cb(TG.joao, c));
    expect(answers()).toMatch(/não está mais disponível/);
    const { rows } = await t.db.query("SELECT amount_cents, deleted_at FROM transactions WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ amount_cents: 7700, deleted_at: null });
    const pend = await t.db.query("SELECT count(*)::int AS n FROM telegram_pending_actions WHERE user_id = $1 AND kind IN ('tx_update','tx_delete') AND payload::text LIKE $2", [t.ids.joao, `%"txId":${id}%`]);
    expect(pend.rows[0].n).toBe(0);
  });

  it("valor inválido na edição não altera nada", async () => {
    const id = await addTx("luciana", { amountCents: 2000, description: "Revista" });
    await send(cb(TG.luciana, `mf:${id}:amount`));
    await send(msg(TG.luciana, "muito caro"));
    expect(lastText()).toMatch(/Valor inválido\. Nada foi alterado/);
    expect((await t.db.query("SELECT amount_cents FROM transactions WHERE id = $1", [id])).rows[0].amount_cents).toBe(2000);
  });
});

describe("consultas analíticas e linguagem natural", () => {
  it("“Quanto posso gastar até o final do mês?” usa saldo − pendentes + previstas", async () => {
    await addTx("luciana", { amountCents: 30000, description: "Condomínio", date: "2026-11-25", status: "pending" });
    await addTx("luciana", { kind: "income", amountCents: 10000, description: "Reembolso", date: "2026-11-28", status: "pending" });
    const bal = Object.values(await balances()).reduce((a: number, b) => a + (b as number), 0);
    const { rows } = await t.db.query<{ e: number; i: number }>(
      `SELECT COALESCE(sum(amount_cents) FILTER (WHERE kind='expense'),0)::bigint AS e,
              COALESCE(sum(amount_cents) FILTER (WHERE kind='income' AND date >= '2026-11-14'),0)::bigint AS i
         FROM transactions WHERE user_id = $1 AND status='pending' AND deleted_at IS NULL AND date <= '2026-11-30'`,
      [t.ids.luciana],
    );
    const expected = bal - rows[0].e + rows[0].i;
    await send(msg(TG.luciana, "Quanto posso gastar até o final do mês?"));
    expect(lastText()).toContain(`Disponível: R$ ${(expected / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
    expect(lastText()).toMatch(/por dia<\/b> nos próximos 17 dias/);
  });

  it("“essa semana” = segunda até hoje; “semana passada” = semana anterior", async () => {
    await send(msg(TG.luciana, "Quanto eu gastei essa semana?"));
    expect(lastText()).toMatch(/Despesas esta semana/);
    await send(msg(TG.luciana, "quanto gastei semana passada?"));
    expect(lastText()).toMatch(/Despesas semana passada/);
  });

  it("contexto: “e no mês passado?” reaproveita a pergunta anterior", async () => {
    await addTx("luciana", { amountCents: 9000, description: "Feira", date: "2026-10-10", categoryId: await t.categoryId("Mercado") });
    await send(msg(TG.luciana, "Quanto gastei com mercado?"));
    expect(lastText()).toMatch(/Mercado<\/b> em novembro de 2026/);
    await send(msg(TG.luciana, "e no mês passado?"));
    expect(lastText()).toMatch(/Mercado<\/b> em outubro de 2026[\s\S]*R\$ 90,00/);
  });

  it("filtro por valor, recorrentes, fontes de renda, análise e maiores despesas", async () => {
    await addTx("luciana", { amountCents: 25000, description: "Tênis" });
    await send(msg(TG.luciana, "despesas acima de 100 este mês"));
    const listText = lastText();
    expect(listText).toMatch(/acima de R\$ 100,00/);
    expect(listText).toMatch(/Tênis/);
    expect(listText).not.toMatch(/Pão|Revista/);
    for (const m of ["01", "02", "03"]) await addTx("luciana", { amountCents: 5590, description: "Academia", date: `2026-${m === "01" ? "09" : m === "02" ? "10" : "11"}-05` });
    await send(msg(TG.luciana, "quais são meus gastos recorrentes?"));
    expect(lastText()).toMatch(/Parecem recorrentes[\s\S]*Academia: ~R\$ 55,90\/mês/);
    await addTx("luciana", { kind: "income", amountCents: 300000, description: "Salário" });
    await send(msg(TG.luciana, "quais minhas fontes de renda?"));
    expect(lastText()).toMatch(/fontes de renda[\s\S]*Salário/);
    await send(msg(TG.luciana, "faz uma análise dos meus gastos"));
    expect(lastText()).toMatch(/Análise de novembro[\s\S]*Não é recomendação de investimento/);
    await send(msg(TG.luciana, "Quais foram minhas maiores despesas deste mês?"));
    expect(lastText()).toMatch(/Maiores despesas em novembro de 2026[\s\S]*Condomínio|Tênis/);
  });

  it("saudação e agradecimento respondem sem IA; menu principal funciona", async () => {
    let aiCalls = 0;
    t.ctx.ai = { async respond() { aiCalls++; return { type: "none", reason: "x" }; } };
    await send(msg(TG.luciana, "oi"));
    expect(lastText()).toMatch(/Sou o assistente do <b>Luna Finance/);
    await send(cb(TG.luciana, button("Meu resumo")));
    expect(lastText()).toMatch(/Resumo em novembro de 2026/);
    await send(msg(TG.luciana, "obrigado!"));
    expect(lastText()).toMatch(/Por nada/);
    expect(aiCalls).toBe(0);
    t.ctx.ai = null;
  });
});

describe("limites e custos", () => {
  it("mais de 30 mensagens por minuto são barradas", async () => {
    for (let i = 0; i < 31; i++) await send(msg(TG.joao, "/saldo"));
    expect(lastText()).toMatch(/Muitas mensagens/);
    expect(t.tg.sent.filter((s) => s.text?.includes("Seu saldo"))).toHaveLength(30);
  });

  it("IA tem teto de chamadas por hora; acima disso o bot usa só as regras", async () => {
    let aiCalls = 0;
    t.ctx.ai = { async respond() { aiCalls++; return { type: "none", reason: "x" }; } };
    for (let i = 0; i < 32; i++) {
      messageLimiter.reset();
      await send(msg(TG.joao, `frase estranha número ${"x".repeat(i)}`));
    }
    expect(aiCalls).toBe(30);
    expect(lastText()).toMatch(/Não entendi/);
    t.ctx.ai = null;
  });
});

describe("resiliência", () => {
  it("IA lançando exceção não derruba o bot (cai nas regras)", async () => {
    t.ctx.ai = { async respond() { throw new Error("503 overloaded"); } };
    const r = await send(msg(TG.joao, "zzz yyy"));
    expect(r.status).toBe(200);
    expect(lastText()).toMatch(/Não entendi/);
    t.ctx.ai = null;
  });

  it("timeout da IA devolve controle ao bot", async () => {
    const slow: MessagesClient = { messages: { create: () => new Promise(() => {}) } };
    const a = createAssistant({ model: "m", effort: "low", log: createLogger(true), client: slow, timeoutMs: 50 });
    const user = { id: 1, name: "X", email: "x", role: "member" as const, family_access: "full" as const, color: "#000" };
    const r = await a.respond("oi", { db: t.db, user, today: "2026-11-14", categories: [], accounts: [], goals: [] });
    expect(r).toEqual({ type: "none", reason: "timeout" });
  });

  it("Bot API: 502 → retenta com backoff e conclui; erro permanente não é repetido", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      return n < 3
        ? new Response(JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }), { status: 502 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as unknown as typeof fetch;
    const started = Date.now();
    expect(await createTelegramApi("1:X", flaky).sendMessage(1, "a")).toEqual({ message_id: 1 });
    expect(n).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400); // 0,5s + 1s
    let m = 0;
    const forbidden = (async () => {
      m++;
      return new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden" }), { status: 403 });
    }) as unknown as typeof fetch;
    await expect(createTelegramApi("1:X", forbidden).sendMessage(1, "a")).rejects.toBeInstanceOf(TelegramError);
    expect(m).toBe(1);
  });

  it("/healthz informa banco, Telegram e IA — e 503 se o banco cair", async () => {
    const ok = await request(t.app).get("/healthz");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, db: { ok: true }, telegram: { configured: true }, ai: { enabled: false } });
    expect(JSON.stringify(ok.body)).not.toMatch(/token|secret|R\$/i);
    const real = t.ctx.db.query.bind(t.ctx.db);
    t.ctx.db.query = (async () => {
      throw new Error("down");
    }) as typeof t.ctx.db.query;
    const down = await request(t.app).get("/healthz");
    t.ctx.db.query = real;
    expect(down.status).toBe(503);
  });

  it("falha do banco ao confirmar exclusão: nada muda e dá para tentar de novo", async () => {
    const id = await addTx("luciana", { amountCents: 1234, description: "Teste exclusão" });
    await send(cb(TG.luciana, `md:${id}`));
    const c = button("Excluir");
    const realTx = t.ctx.db.tx.bind(t.ctx.db);
    t.ctx.db.tx = async () => {
      throw new Error("connection reset");
    };
    await send(cb(TG.luciana, c));
    t.ctx.db.tx = realTx;
    expect(lastText()).toMatch(/Nada foi salvo/);
    expect((await t.db.query("SELECT deleted_at FROM transactions WHERE id = $1", [id])).rows[0].deleted_at).toBeNull();
    await send(cb(TG.luciana, c));
    expect((await t.db.query("SELECT deleted_at FROM transactions WHERE id = $1", [id])).rows[0].deleted_at).not.toBeNull();
  });
});

describe("migração 3", () => {
  it("é aditiva e reversível sem perder lançamentos", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, () => {});
    const { rows: u } = await db.query<{ id: number }>("INSERT INTO users (name, email) VALUES ('A','a@a.a') RETURNING id");
    const { rows: a } = await db.query<{ id: number }>("INSERT INTO accounts (owner_id, name) VALUES ($1,'X') RETURNING id", [u[0].id]);
    await db.query("INSERT INTO transactions (user_id, account_id, kind, amount_cents, description, date, status, paid_at, created_by) VALUES ($1,$2,'expense',500,'x','2026-11-01','paid','2026-11-01',$1)", [u[0].id, a[0].id]);
    const m3 = migrations.find((m) => m.id === 3)!;
    await db.tx(async (q) => {
      await q.exec(m3.down!);
      await q.query("DELETE FROM schema_migrations WHERE id = 3");
    });
    expect((await db.query("SELECT to_regclass('transfers') AS t")).rows[0].t).toBeNull();
    expect((await db.query("SELECT count(*)::int AS n FROM transactions")).rows[0].n).toBe(1);
    await migrate(db, () => {});
    expect((await db.query("SELECT max(id) AS v FROM schema_migrations")).rows[0].v).toBe(3);
    expect((await db.query("SELECT count(*)::int AS n FROM transactions")).rows[0].n).toBe(1);
    await db.close();
  });
});
