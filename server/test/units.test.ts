import { describe, expect, it } from "vitest";
import { parseMoneyToCents } from "../src/lib/money.js";
import { addMonths, makeDate } from "../src/lib/clock.js";
import { parseMessage } from "../src/telegram/parser.js";
import { DEFAULT_CATEGORIES } from "../src/db/migrate.js";
import { splitInstallments } from "../src/services/transactions.js";
import { validateInterpretation } from "../src/telegram/ai.js";

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

describe("interpretação de mensagens (pt-BR)", () => {
  const entry = (text: string) => {
    const r = parseMessage(text, cats, TODAY);
    if (r.type !== "entry") throw new Error(`esperava entry, veio ${JSON.stringify(r)}`);
    return { ...r.draft, cat: catName(r.draft.categoryId) };
  };

  it("exemplo 1: despesa com supermercado", () => {
    const d = entry("Registra uma despesa de R$ 150 com supermercado.");
    expect(d).toMatchObject({ kind: "expense", amountCents: 15000, status: "paid", date: TODAY, cat: "Mercado", description: "Supermercado" });
  });

  it("exemplo 2: salário recebido", () => {
    const d = entry("Recebi R$ 3.000 de salário.");
    expect(d).toMatchObject({ kind: "income", amountCents: 300000, status: "paid", cat: "Salário", description: "Salário" });
  });

  it("exemplo 3: conta de internet para dia 20 vira conta a pagar", () => {
    const d = entry("Registra uma conta de internet de R$ 120 para dia 20.");
    expect(d).toMatchObject({ kind: "expense", amountCents: 12000, status: "pending", date: "2026-11-20", cat: "Contas da casa", description: "Conta de internet" });
  });

  it("dia que já passou vai para o próximo mês quando é vencimento", () => {
    expect(entry("conta de luz de 200 para dia 5").date).toBe("2026-12-05");
  });

  it("ontem / parcelado / sem verbo", () => {
    expect(entry("gastei 45,90 no ifood ontem")).toMatchObject({ amountCents: 4590, date: "2026-11-13", cat: "Alimentação fora" });
    expect(entry("comprei um notebook de 4.500 em 10x")).toMatchObject({ amountCents: 450000, installments: 10 });
    expect(entry("uber 23")).toMatchObject({ kind: "expense", amountCents: 2300, cat: "Transporte" });
  });

  it("perguntas viram consultas (sem inventar números)", () => {
    expect(parseMessage("qual meu saldo?", cats, TODAY)).toEqual({ type: "query", query: "balance" });
    expect(parseMessage("quanto gastei esse mês?", cats, TODAY)).toEqual({ type: "query", query: "expenses" });
    expect(parseMessage("contas pendentes", cats, TODAY)).toEqual({ type: "query", query: "bills" });
    expect(parseMessage("resumo da família", cats, TODAY)).toEqual({ type: "query", query: "family" });
    expect(parseMessage("minhas metas", cats, TODAY)).toEqual({ type: "query", query: "goals" });
  });

  it("frase sem valor não gera lançamento", () => {
    expect(parseMessage("oi, tudo bem?", cats, TODAY).type).toBe("unknown");
    expect(parseMessage("paguei o mercado", cats, TODAY)).toMatchObject({ type: "incomplete", missing: ["amount"] });
  });
});

describe("validação da saída da IA", () => {
  const base = { type: "entry" as const, query: null, kind: "expense" as const, description: "Farmácia", category_name: "Saúde", date: null, status: null, installments: null };

  it("aceita valor que está escrito na mensagem", () => {
    const r = validateInterpretation({ ...base, amount_text: "R$ 32,50" }, "fui na farmácia e deixei R$ 32,50 lá", cats, TODAY);
    expect(r).toMatchObject({ type: "entry", draft: { amountCents: 3250, categoryId: cats.find((c) => c.name === "Saúde")!.id } });
  });

  it("descarta valor inventado pela IA", () => {
    expect(validateInterpretation({ ...base, amount_text: "R$ 99" }, "fui na farmácia", cats, TODAY)).toBeNull();
  });

  it("ignora categoria inexistente e data absurda", () => {
    const r = validateInterpretation({ ...base, amount_text: "30", category_name: "Inventada", date: "1990-01-01" }, "gastei 30 com algo", cats, TODAY);
    expect(r).toMatchObject({ type: "entry", draft: { categoryId: null, date: TODAY } });
  });
});
