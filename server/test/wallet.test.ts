import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { migrations } from "../src/db/migrations.js";
import { setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await setupTestApp();
  const add = async (who: "luis" | "luciana" | "lipe" | "joao", amountCents: number, description: string, paymentMethod: string | null, date = "2026-11-10", kind = "expense") => {
    const s = await t.as(who);
    const r = await s.post("/api/transactions").send({ kind, amountCents, description, date, paymentMethod });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  };
  await add("luis", 30000, "Posto", "credit_card");
  await add("luis", 12000, "Padaria", "pix");
  await add("luciana", 25000, "Farmácia", "credit_card");
  await add("lipe", 8000, "Cinema", "credit_card");
  await add("lipe", 999999, "Salário", null, "2026-11-05", "income"); // receita não entra
  await add("joao", 5000, "Lanche", "cash");
  await add("joao", 7000, "Mês passado", "credit_card", "2026-10-20"); // fora do mês
});
afterAll(async () => t.close());

type Card = { userId: number; name: string; relation: string | null; invoiceHolder: boolean; last4: string | null; expenseCents: number | null; cardCents: number | null; recent: Array<{ description: string }> | null };

describe("cartões da família (/api/wallet)", () => {
  it("ordem fixa dos titulares, Luís Carlos como titular da fatura", async () => {
    const r = await (await t.as("lipe")).get("/api/wallet?month=2026-11");
    expect(r.status).toBe(200);
    const cards: Card[] = r.body.cards;
    expect(cards.map((c) => [c.name, c.relation])).toEqual([
      ["Luís Carlos", "Pai"],
      ["Luciana", "Mãe"],
      ["Lipe", "Filho 1"],
      ["João", "Filho 2"],
    ]);
    expect(cards.filter((c) => c.invoiceHolder).map((c) => c.name)).toEqual(["Luís Carlos"]);
    expect(r.body.invoice.holderId).toBe(t.ids.luis);
  });

  it("gastos do mês por titular e compras no cartão somadas uma única vez", async () => {
    const r = await (await t.as("lipe")).get("/api/wallet?month=2026-11");
    const by = Object.fromEntries((r.body.cards as Card[]).map((c) => [c.name, c]));
    expect(by["Luís Carlos"].expenseCents).toBe(42000);
    expect(by["Luís Carlos"].cardCents).toBe(30000);
    expect(by["Luciana"].cardCents).toBe(25000);
    expect(by["Lipe"].expenseCents).toBe(8000); // receita fora
    expect(by["João"].expenseCents).toBe(5000); // outubro fora
    expect(by["João"].cardCents).toBe(0);
    expect(r.body.invoice.familyCardCents).toBe(30000 + 25000 + 8000);
    // nada de limite, saldo de cartão ou final inventado
    expect(JSON.stringify(r.body)).not.toMatch(/limit|balance/i);
    expect((r.body.cards as Card[]).every((c) => c.last4 === null)).toBe(true);
  });

  it("final do cartão: cada um cadastra o seu; quem gerencia cadastra o de todos", async () => {
    const luis = await t.as("luis");
    expect((await luis.patch("/api/me").send({ cardLast4: "12a4" })).status).toBe(400);
    expect((await luis.patch("/api/me").send({ cardLast4: "12345" })).status).toBe(400);
    expect((await luis.patch("/api/me").send({ cardLast4: "4821" })).status).toBe(200);
    expect((await luis.get("/api/me")).body.cardLast4).toBe("4821");
    // quem não gerencia não altera o de outra pessoa
    expect((await luis.patch(`/api/family/members/${t.ids.joao}`).send({ cardLast4: "1111" })).status).toBe(403);

    const lipe = await t.as("lipe");
    expect((await lipe.patch(`/api/family/members/${t.ids.joao}`).send({ cardLast4: "0937" })).status).toBe(200);
    const r = await lipe.get("/api/wallet?month=2026-11");
    const by = Object.fromEntries((r.body.cards as Card[]).map((c) => [c.name, c]));
    expect(by["Luís Carlos"].last4).toBe("4821");
    expect(by["João"].last4).toBe("0937");
    expect(by["Luciana"].last4).toBeNull();

    // vazio remove
    expect((await lipe.patch(`/api/family/members/${t.ids.joao}`).send({ cardLast4: "" })).status).toBe(200);
    const again = await lipe.get("/api/wallet?month=2026-11");
    expect((again.body.cards as Card[]).find((c) => c.name === "João")!.last4).toBeNull();
  });

  it("'summary' vê totais dos outros, mas não os lançamentos", async () => {
    await t.setAccess("joao", "summary");
    const r = await (await t.as("joao")).get("/api/wallet?month=2026-11");
    const by = Object.fromEntries((r.body.cards as Card[]).map((c) => [c.name, c]));
    expect(by["Luciana"].expenseCents).toBe(25000);
    expect(by["Luciana"].recent).toBeNull();
    expect(by["João"].recent?.map((x) => x.description)).toEqual(["Lanche"]);
    expect(JSON.stringify(r.body)).not.toMatch(/Farmácia/);
    await t.setAccess("joao", "full");
  });

  it("'none' vê só o próprio cartão", async () => {
    await t.setAccess("luciana", "none");
    const r = await (await t.as("luciana")).get("/api/wallet?month=2026-11");
    const by = Object.fromEntries((r.body.cards as Card[]).map((c) => [c.name, c]));
    expect(by["Luciana"].expenseCents).toBe(25000);
    expect(by["Luís Carlos"].expenseCents).toBeNull();
    expect(by["Luís Carlos"].recent).toBeNull();
    expect(by["Luís Carlos"].last4).toBeNull(); // cadastrado, mas oculto para 'none'
    expect(r.body.invoice.familyCardCents).toBeNull();
    await t.setAccess("luciana", "full");
  });
});

describe("migração 4 (final do cartão)", () => {
  it("é aditiva, valida 4 dígitos e é reversível", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, () => {});
    const { rows } = await db.query<{ id: number }>("INSERT INTO users (name, email, card_last4) VALUES ('A','a@a.a','1234') RETURNING id");
    await expect(db.query("UPDATE users SET card_last4 = '12' WHERE id = $1", [rows[0].id])).rejects.toThrow();
    const m4 = migrations.find((m) => m.id === 4)!;
    await db.tx(async (q) => {
      await q.exec(m4.down!);
      await q.query("DELETE FROM schema_migrations WHERE id = 4");
    });
    expect((await db.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(1);
    await migrate(db, () => {});
    expect((await db.query("SELECT card_last4 FROM users")).rows[0].card_last4).toBeNull();
    await db.close();
  });
});
