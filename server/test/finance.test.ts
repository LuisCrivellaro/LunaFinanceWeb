import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setNow } from "../src/lib/clock.js";
import { generateAllRecurrences } from "../src/services/transactions.js";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let lu: Awaited<ReturnType<TestApp["as"]>>;
beforeAll(async () => {
  t = await setupTestApp({ now: "2026-11-14T15:00:00Z" });
  lu = await t.as("luciana");
});
afterAll(async () => {
  setNow(null);
  await t.close();
});

describe("receitas e despesas", () => {
  let id: number;

  it("cria, valida e calcula saldo", async () => {
    const salary = await lu.post("/api/transactions").send({ kind: "income", amountCents: 500000, description: "Salário", date: "2026-11-05", categoryId: await t.categoryId("Salário"), nature: "fixed" });
    expect(salary.status).toBe(200);
    const exp = await lu.post("/api/transactions").send({ kind: "expense", amountCents: 32050, description: "Supermercado", date: "2026-11-12", categoryId: await t.categoryId("Mercado") });
    expect(exp.status).toBe(200);
    id = exp.body[0].id;
    expect(exp.body[0]).toMatchObject({ status: "paid", paidAt: "2026-11-12", userId: t.ids.luciana, source: "web" });

    const accounts = await lu.get("/api/accounts");
    expect(accounts.body[0].balanceCents).toBe(500000 - 32050);
  });

  it("rejeita dados inválidos", async () => {
    const cases = [
      { kind: "expense", amountCents: 0, description: "x", date: "2026-11-01" },
      { kind: "expense", amountCents: 10.5, description: "x", date: "2026-11-01" },
      { kind: "expense", amountCents: 100, description: "", date: "2026-11-01" },
      { kind: "expense", amountCents: 100, description: "x", date: "2026-02-30" },
      { kind: "outro", amountCents: 100, description: "x", date: "2026-11-01" },
      { kind: "income", amountCents: 100, description: "x", date: "2026-11-01", categoryId: await t.categoryId("Mercado") },
    ];
    for (const c of cases) expect((await lu.post("/api/transactions").send(c)).status).toBe(400);
  });

  it("edita e exclui (exclusão lógica preserva histórico)", async () => {
    const r = await lu.patch(`/api/transactions/${id}`).send({ amountCents: 30000, description: "Mercado do mês" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ amountCents: 30000, description: "Mercado do mês" });
    expect((await lu.del(`/api/transactions/${id}`)).status).toBe(200);
    const { rows } = await t.db.query("SELECT deleted_at FROM transactions WHERE id = $1", [id]);
    expect(rows[0].deleted_at).not.toBeNull();
    const list = await lu.get("/api/transactions");
    expect(list.body.items.find((i: { id: number }) => i.id === id)).toBeUndefined();
  });

  it("filtros e pesquisa", async () => {
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 4500, description: "Uber para o trabalho", date: "2026-11-03", categoryId: await t.categoryId("Transporte") });
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 8900, description: "Pizza 100% sexta", date: "2026-10-20", categoryId: await t.categoryId("Alimentação fora") });
    expect((await lu.get("/api/transactions?q=uber")).body.items).toHaveLength(1);
    expect((await lu.get("/api/transactions?q=100%25")).body.items).toHaveLength(1); // % literal, não curinga
    expect((await lu.get("/api/transactions?q=transporte")).body.items).toHaveLength(1); // busca no nome da categoria
    expect((await lu.get("/api/transactions?from=2026-11-01&to=2026-11-30&kind=expense")).body.items).toHaveLength(1);
    expect((await lu.get(`/api/transactions?categoryId=${await t.categoryId("Salário")}`)).body.items).toHaveLength(1);
    const sorted = (await lu.get("/api/transactions?sort=amount_desc")).body.items;
    expect(sorted[0].amountCents).toBe(500000);
  });
});

describe("parcelamentos", () => {
  it("divide o total em parcelas mensais sem perder centavos", async () => {
    const r = await lu.post("/api/transactions").send({ kind: "expense", amountCents: 100000, description: "Geladeira", date: "2026-10-31", installments: 3, categoryId: await t.categoryId("Compras") });
    expect(r.status).toBe(200);
    expect(r.body.map((x: { amountCents: number }) => x.amountCents)).toEqual([33334, 33333, 33333]);
    expect(r.body.map((x: { date: string }) => x.date)).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
    expect(r.body.map((x: { status: string }) => x.status)).toEqual(["paid", "pending", "pending"]);
    expect(r.body.map((x: { installmentNumber: number }) => x.installmentNumber)).toEqual([1, 2, 3]);
    // excluir "grupo" remove a parcela e as futuras pendentes
    const del = await lu.del(`/api/transactions/${r.body[1].id}?scope=group`);
    expect(del.body.deleted).toBe(2);
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM transactions WHERE installment_group = $1 AND deleted_at IS NULL", [r.body[0].installmentGroup]);
    expect(rows[0].n).toBe(1);
  });
});

describe("recorrência e contas a pagar", () => {
  let recurrenceId: number;

  it("conta recorrente gera ocorrências até o mês seguinte, sem duplicar", async () => {
    const r = await lu.post("/api/transactions").send({ kind: "expense", amountCents: 12000, description: "Internet", date: "2026-10-20", status: "paid", nature: "fixed", categoryId: await t.categoryId("Contas da casa"), recurrence: { autoPaid: false } });
    expect(r.status).toBe(200);
    expect(r.body.map((x: { date: string }) => x.date)).toEqual(["2026-10-20", "2026-11-20", "2026-12-20"]);
    recurrenceId = r.body[0].recurrenceId;
    expect(await generateAllRecurrences(t.db)).toBe(0); // idempotente
    expect(await generateAllRecurrences(t.db)).toBe(0);
  });

  it("virada de mês gera a próxima ocorrência", async () => {
    setNow("2026-12-02T15:00:00Z");
    expect(await generateAllRecurrences(t.db)).toBe(1);
    const { rows } = await t.db.query("SELECT date FROM transactions WHERE recurrence_id = $1 ORDER BY date DESC LIMIT 1", [recurrenceId]);
    expect(rows[0].date).toBe("2027-01-20");
    setNow("2026-11-14T15:00:00Z");
  });

  it("alterar recorrência muda só as futuras pendentes", async () => {
    expect((await lu.patch(`/api/recurrences/${recurrenceId}`).send({ amountCents: 15000 })).status).toBe(200);
    const { rows } = await t.db.query<{ date: string; amount_cents: number }>("SELECT date, amount_cents FROM transactions WHERE recurrence_id = $1 AND deleted_at IS NULL ORDER BY date", [recurrenceId]);
    expect(rows.map((r) => r.amount_cents)).toEqual([12000, 15000, 15000, 15000]);
    expect((await (await t.as("joao")).patch(`/api/recurrences/${recurrenceId}`).send({ amountCents: 1 })).status).toBe(403);
  });

  it("contas atrasadas, a vencer e pagamento", async () => {
    const late = await lu.post("/api/transactions").send({ kind: "expense", amountCents: 9000, description: "Conta de luz", date: "2026-11-10", status: "pending", categoryId: await t.categoryId("Contas da casa") });
    const bills = await lu.get("/api/bills");
    expect(bills.body.overdue.map((b: { id: number }) => b.id)).toContain(late.body[0].id);
    expect(bills.body.overdue[0].overdue).toBe(true);
    expect(bills.body.upcoming.some((b: { description: string }) => b.description === "Internet")).toBe(true);
    const paid = await lu.post(`/api/transactions/${late.body[0].id}/pay`).send({});
    expect(paid.body).toMatchObject({ status: "paid", paidAt: "2026-11-14" });
    const after = await lu.get("/api/bills");
    expect(after.body.overdue.map((b: { id: number }) => b.id)).not.toContain(late.body[0].id);
  });

  it("parar recorrência remove as futuras pendentes", async () => {
    await lu.patch(`/api/recurrences/${recurrenceId}`).send({ active: false });
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM transactions WHERE recurrence_id = $1 AND deleted_at IS NULL AND status = 'pending' AND date >= '2026-11-14'", [recurrenceId]);
    expect(rows[0].n).toBe(0);
  });
});

describe("metas", () => {
  it("meta individual: só a dona contribui; percentual e ritmo mensal", async () => {
    const g = await lu.post("/api/goals").send({ name: "Viagem", targetCents: 600000, deadline: "2027-04-30", scope: "individual" });
    expect(g.status).toBe(200);
    const c = await lu.post(`/api/goals/${g.body.id}/contributions`).send({ amountCents: 150000 });
    expect(c.body.goal).toMatchObject({ savedCents: 150000, percent: 25 });
    expect(c.body.goal.monthlyNeededCents).toBe(75000); // 450 mil / 6 meses (nov..abr)
    expect((await (await t.as("joao")).post(`/api/goals/${g.body.id}/contributions`).send({ amountCents: 100 })).status).toBe(403);
    expect((await lu.post(`/api/goals/${g.body.id}/contributions`).send({ amountCents: -200000 })).status).toBe(400);
  });

  it("meta familiar: todos contribuem, só quem criou edita/exclui", async () => {
    const g = await lu.post("/api/goals").send({ name: "Reserva de emergência", targetCents: 100000, scope: "family" });
    const jo = await t.as("joao");
    expect((await jo.post(`/api/goals/${g.body.id}/contributions`).send({ amountCents: 95000 })).status).toBe(200);
    expect((await jo.patch(`/api/goals/${g.body.id}`).send({ name: "Hack" })).status).toBe(403);
    expect((await jo.del(`/api/goals/${g.body.id}`)).status).toBe(403);
    const done = await (await t.as("lipe")).post(`/api/goals/${g.body.id}/contributions`).send({ amountCents: 5000 });
    expect(done.body.goal.percent).toBe(100);
    expect(done.body.goal.achievedAt).not.toBeNull();
    expect(done.body.goal.contributors).toHaveLength(2);
    const upd = await lu.patch(`/api/goals/${g.body.id}`).send({ targetCents: 200000 });
    expect(upd.body.achievedAt).toBeNull();
    expect((await lu.del(`/api/goals/${g.body.id}`)).status).toBe(200);
  });
});

describe("painel, relatórios e exportação", () => {
  it("painel individual soma apenas os próprios dados", async () => {
    const d = await lu.get("/api/dashboard?month=2026-11");
    expect(d.status).toBe(200);
    expect(d.body.totals.incomeTotalCents).toBe(500000);
    const { rows } = await t.db.query<{ v: number }>(
      "SELECT COALESCE(sum(amount_cents),0)::bigint AS v FROM transactions WHERE user_id = $1 AND kind='expense' AND deleted_at IS NULL AND date BETWEEN '2026-11-01' AND '2026-11-30'",
      [t.ids.luciana],
    );
    expect(d.body.totals.expenseTotalCents).toBe(rows[0].v);
    expect(d.body.series).toHaveLength(6);
    expect(d.body.balanceHistory).toHaveLength(12);
    expect(d.body.balanceHistory.at(-1).balanceCents).toBe(d.body.balanceCents);
    const catSum = d.body.expensesByCategory.reduce((s: number, c: { cents: number }) => s + c.cents, 0);
    expect(catSum).toBe(d.body.totals.expenseTotalCents);
  });

  it("visão familiar agrega os quatro e traz resumo por pessoa", async () => {
    await (await t.as("joao")).post("/api/transactions").send({ kind: "income", amountCents: 80000, description: "Estágio", date: "2026-11-05" });
    const d = await (await t.as("luis")).get("/api/dashboard?view=family&month=2026-11");
    expect(d.body.totals.incomeTotalCents).toBe(580000);
    expect(d.body.members).toHaveLength(4);
    expect(d.body.members.find((m: { userId: number }) => m.userId === t.ids.joao).incomeTotalCents).toBe(80000);
  });

  it("relatório anual e mensal", async () => {
    const y = await lu.get("/api/reports?year=2026");
    expect(y.body.series).toHaveLength(12);
    expect(y.body.totals.resultCents).toBe(y.body.totals.incomeCents - y.body.totals.expenseCents);
    expect(y.body.totals.fixedExpenseCents + y.body.totals.variableExpenseCents).toBe(y.body.totals.expenseCents);
    const m = await lu.get("/api/reports?month=2026-11&view=family");
    expect(m.body.byMember.length).toBeGreaterThan(0);
    expect((await lu.get("/api/reports?month=2026-13")).status).toBe(400);
  });

  it("CSV: separador ';', BOM e proteção contra injeção de fórmula", async () => {
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 100, description: "=HYPERLINK(\"http://x\")", date: "2026-11-14" });
    const r = await lu.get("/api/reports/export.csv?from=2026-11-01&to=2026-11-30");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    expect(r.text).toContain("Data;Tipo;Descrição");
    expect(r.text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(r.text).toContain("-1,00");
  });

  it("categorias personalizadas", async () => {
    const c = await lu.post("/api/categories").send({ name: "Academia", kind: "expense", keywords: "academia, smartfit" });
    expect(c.status).toBe(200);
    expect((await lu.post("/api/categories").send({ name: "academia", kind: "expense" })).status).toBe(409);
    expect((await (await t.as("joao")).patch(`/api/categories/${c.body.id}`).send({ name: "X" })).status).toBe(403);
    expect((await lu.patch(`/api/categories/${c.body.id}`).send({ archived: true })).status).toBe(200);
  });
});
