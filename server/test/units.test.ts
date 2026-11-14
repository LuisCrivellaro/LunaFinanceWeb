import { describe, expect, it } from "vitest";
import { parseMoneyToCents } from "../src/lib/money.js";
import { addMonths, makeDate } from "../src/lib/clock.js";
import { interpret, type NluContext } from "../src/telegram/nlu.js";
import { createAssistant, validateAnswer, type MessagesClient } from "../src/telegram/assistant.js";
import { createLogger } from "../src/context.js";
import { createDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEFAULT_CATEGORIES } from "../src/db/migrate.js";
import { splitInstallments } from "../src/services/transactions.js";

const cats = DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, ...c }));
const catName = (id: number | null) => cats.find((c) => c.id === id)?.name;
const TODAY = "2026-11-14";

describe("dinheiro", () => {
  it.each([
    ["150", 15000],
    ["150,90", 15090],
    ["1.234,56", 123456],
    ["R$ 3.000", 300000],
    ["1234.56", 123456],
    ["3 mil", 300000],
    ["2,5 mil", 250000],
    ["1k", 100000],
    ["12.5", 1250],
    ["1.000.000", 100000000],
  ])("%s → %i centavos", (input, cents) => expect(parseMoneyToCents(input)).toBe(cents));

  it.each(["", "abc", "0", "-5", "1,", "1.000.000.000.000"])("rejeita %s", (v) => expect(parseMoneyToCents(v)).toBeNull());

  it("divide parcelas sem perder centavos", () => {
    const parts = splitInstallments(10000, 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(parts.reduce((a, b) => a + b)).toBe(10000);
  });
});

describe("datas", () => {
  it("limita o dia ao fim do mês", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 2, 31)).toBe("2026-03-31");
    expect(makeDate(2026, 13, 5)).toBe("2027-01-05");
  });
});


const NCTX: NluContext = {
  categories: cats,
  accounts: [{ id: 70, name: "Nubank" }, { id: 71, name: "Conta principal" }],
  goals: [{ id: 1, name: "Comprar um carro" }, { id: 2, name: "Viagem de fim de ano" }],
  today: TODAY,
};

describe("interpretação de mensagens (pt-BR)", () => {
  const entry = (text: string) => {
    const r = interpret(text, NCTX);
    if (r.type !== "entry") throw new Error(`esperava entry, veio ${JSON.stringify(r)}`);
    return { ...r.draft, cat: catName(r.draft.categoryId) };
  };

  it.each([
    ["Gastei 45 reais no almoço.", { kind: "expense", amountCents: 4500, description: "Almoço", cat: "Alimentação fora", date: TODAY }],
    ["Paguei 120 de gasolina.", { amountCents: 12000, description: "Gasolina", cat: "Transporte" }],
    ["Comprei uma camiseta por 89,90 no cartão.", { amountCents: 8990, description: "Camiseta", cat: "Compras", paymentMethod: "credit_card" }],
    ["Gastei 32 reais ontem com Uber.", { amountCents: 3200, description: "Uber", cat: "Transporte", date: "2026-11-13" }],
    ["Paguei 250 de mercado no Pix.", { amountCents: 25000, description: "Mercado", cat: "Mercado", paymentMethod: "pix" }],
    ["Recebi 2.500 de salário.", { kind: "income", amountCents: 250000, cat: "Salário" }],
    ["Ganhei 300 reais de um trabalho.", { kind: "income", amountCents: 30000, cat: "Freelance" }],
    ["Recebi 150 de reembolso.", { kind: "income", amountCents: 15000, cat: "Outras receitas" }],
    ["Registra uma despesa de R$ 150 com supermercado.", { amountCents: 15000, description: "Supermercado", cat: "Mercado" }],
    ["Registra uma conta de internet de R$ 120 para dia 20.", { status: "pending", date: "2026-11-20", description: "Conta de internet" }],
    ["paguei 80 no débito do Nubank", { paymentMethod: "debit_card", accountId: 70 }],
    ["comprei um notebook de 4.500 em 10x", { amountCents: 450000, installments: 10 }],
    ["uber 23", { kind: "expense", amountCents: 2300, cat: "Transporte" }],
  ])("“%s”", (text, expected) => {
    expect(entry(text)).toMatchObject(expected);
  });

  it.each([
    ["Quanto tenho disponível?", { q: "balance" }],
    ["Qual meu saldo?", { q: "balance" }],
    ["Quanto gastei este mês?", { q: "spend", kind: "expense", categoryId: null }],
    ["Quanto recebi este mês?", { q: "spend", kind: "income" }],
    ["Quanto gastei com alimentação?", { q: "spend", categoryId: cats.find((c) => c.name === "Alimentação fora")!.id }],
    ["Quais foram minhas últimas despesas?", { q: "last", kind: "expense" }],
    ["Quanto gastei hoje?", { q: "spend", period: { from: TODAY, to: TODAY } }],
    ["Como está minha situação financeira?", { q: "summary" }],
    ["Compare meus gastos deste mês com o anterior.", { q: "compare" }],
    ["Como está minha meta de comprar um carro?", { q: "goal", goalId: 1 }],
    ["quanto gastei em outubro?", { q: "spend", period: { from: "2026-10-01", to: "2026-10-31" } }],
    ["maiores despesas da semana", { q: "top", period: { from: "2026-11-08", to: TODAY } }],
    ["contas pendentes", { q: "bills" }],
    ["resumo da família", { q: "family" }],
  ])("consulta “%s”", (text, expected) => {
    const r = interpret(text, NCTX);
    expect(r.type).toBe("query");
    expect((r as { query: unknown }).query).toMatchObject(expected);
  });

  it("metas: criar e contribuir", () => {
    expect(interpret("criar meta de 50 mil para comprar uma moto até 12/2027", NCTX)).toEqual({
      type: "goal_create", name: "Comprar uma moto", targetCents: 5000000, deadline: "2027-12-31",
    });
    expect(interpret("guardei 500 na meta viagem", NCTX)).toMatchObject({ type: "goal_contribute", goalId: 2, amountCents: 50000, withdraw: false });
    expect(interpret("tirei 200 da meta viagem", NCTX)).toMatchObject({ type: "goal_contribute", goalId: 2, withdraw: true });
  });

  it("frases sem valor ou sem sentido não viram lançamento", () => {
    expect(interpret("oi, tudo bem?", NCTX).type).toBe("unknown");
    expect(interpret("paguei o mercado", NCTX)).toMatchObject({ type: "incomplete", missing: ["amount"] });
  });
});

// ------------------------------- assistente de IA -------------------------------

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
function scripted(steps: Array<{ stop: string; content: Block[] }>) {
  const calls: unknown[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        calls.push(params);
        const s = steps.shift();
        if (!s) throw new Error("sem mais respostas");
        return { id: "m", type: "message", role: "assistant", model: "x", content: s.content, stop_reason: s.stop, stop_sequence: null, usage: {} } as never;
      },
    },
  };
  return { client, calls };
}

describe("assistente de IA com ferramentas", () => {
  async function deps() {
    const db = await createDb("pglite://memory");
    await migrate(db, () => {});
    const { rows } = await db.query<{ id: number }>("INSERT INTO users (name, email) VALUES ('Teste','t@t.t') RETURNING id");
    const acc = await db.query<{ id: number }>("INSERT INTO accounts (owner_id, name, is_default) VALUES ($1,'Conta principal',TRUE) RETURNING id", [rows[0].id]);
    await db.query(
      "INSERT INTO transactions (user_id, account_id, kind, amount_cents, description, date, status, paid_at, created_by) VALUES ($1,$2,'expense',12345,'Mercado','2026-11-10','paid','2026-11-10',$1)",
      [rows[0].id, acc.rows[0].id],
    );
    const user = { id: rows[0].id, name: "Teste", email: "t@t.t", role: "member" as const, family_access: "full" as const, color: "#000" };
    return { db, d: { db, user, today: TODAY, categories: cats, accounts: [], goals: [{ id: 1, name: "Viagem" }] } };
  }
  const log = createLogger(true);

  it("responde com números que vieram da ferramenta", async () => {
    const { db, d } = await deps();
    const { client, calls } = scripted([
      { stop: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_period_totals", input: { from: "2026-11-01", to: "2026-11-30" } }] },
      { stop: "end_turn", content: [{ type: "text", text: "Em novembro você gastou R$ 123,45." }] },
    ]);
    const a = createAssistant({ model: "claude-opus-5-5", effort: "low", log, client });
    const r = await a.respond("quanto saiu do bolso em novembro?", d);
    expect(r).toEqual({ type: "text", text: "Em novembro você gastou R$ 123,45." });
    // o resultado real da ferramenta foi enviado de volta ao modelo
    expect(JSON.stringify(calls[1])).toContain('\\"expenseCents\\":12345');
    await db.close();
  });

  it("descarta resposta com valor inventado", async () => {
    const { db, d } = await deps();
    const { client } = scripted([
      { stop: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_balance", input: {} }] },
      { stop: "end_turn", content: [{ type: "text", text: "Seu saldo é R$ 9.999,00." }] },
    ]);
    const r = await createAssistant({ model: "m", effort: "low", log, client }).respond("e aí, quanto tenho?", d);
    expect(r.type).toBe("none");
    await db.close();
  });

  it("descarta resposta que afirma ter registrado algo", async () => {
    expect(validateAnswer("Pronto, registrei sua despesa.", []).ok).toBe(false);
    expect(validateAnswer("Você gastou R$ 10,00.", []).ok).toBe(false); // valor sem consulta
  });

  it("proposta vira rascunho (não grava) e exige valor escrito pelo usuário", async () => {
    const { db, d } = await deps();
    const { client } = scripted([
      { stop: "tool_use", content: [{ type: "tool_use", id: "t1", name: "propose_transaction", input: { kind: "expense", amount_text: "R$ 99", description: "Farmácia", category_name: "Saúde", date: null, status: null, payment_method: "pix" } }] },
      { stop: "tool_use", content: [{ type: "tool_use", id: "t2", name: "propose_transaction", input: { kind: "expense", amount_text: "32,50", description: "Farmácia", category_name: "Saúde", date: null, status: null, payment_method: "pix" } }] },
    ]);
    const r = await createAssistant({ model: "m", effort: "low", log, client }).respond("deixei 32,50 na drogaria via pix", d);
    expect(r).toMatchObject({ type: "proposal", intent: { type: "entry", draft: { amountCents: 3250, paymentMethod: "pix", categoryId: cats.find((c) => c.name === "Saúde")!.id } } });
    const { rows } = await db.query("SELECT count(*)::int AS n FROM transactions");
    expect(rows[0].n).toBe(1); // só o lançamento pré-existente
    await db.close();
  });

  it("falha/recusa da API não quebra o bot", async () => {
    const { db, d } = await deps();
    const failing: MessagesClient = { messages: { create: async () => { throw new Error("timeout"); } } };
    expect((await createAssistant({ model: "m", effort: "low", log, client: failing }).respond("oi", d)).type).toBe("none");
    const { client } = scripted([{ stop: "refusal", content: [] }]);
    expect((await createAssistant({ model: "m", effort: "low", log, client }).respond("oi", d)).type).toBe("none");
    await db.close();
  });
});
