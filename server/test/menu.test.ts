/**
 * Menu interativo do Telegram (Inline Keyboard + Callback Query):
 * boas-vindas, 💸 Gastei, 💰 Recebi, 📈 Economizei, 📊 Meu resumo, 🎯 Minhas metas,
 * ⚙️ Configurações, voltar ao menu, cliques repetidos/antigos, isolamento e
 * convivência com a linguagem natural. Dados fictícios em PGlite.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setNow } from "../src/lib/clock.js";
import type { TgUpdate } from "../src/telegram/bot.js";
import { aiLimiter, messageLimiter } from "../src/telegram/throttle.js";
import { WEBHOOK_SECRET, setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let updateId = 90_000;
const TG = { luciana: 8001, joao: 8004 };

beforeAll(async () => {
  t = await setupTestApp({ now: "2026-11-14T15:00:00Z" });
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
  messageLimiter.reset();
  aiLimiter.reset();
});

function send(update: Omit<TgUpdate, "update_id"> & { update_id?: number }) {
  return request(t.app).post("/telegram/webhook").set("x-telegram-bot-api-secret-token", WEBHOOK_SECRET).send({ update_id: update.update_id ?? updateId++, ...update });
}
const msg = (from: number, text: string) => ({ message: { message_id: 1, from: { id: from }, chat: { id: from, type: "private" }, date: 0, text } });
const cb = (from: number, data: string) => ({ callback_query: { id: `cb${updateId}`, from: { id: from }, data, message: { message_id: 9, chat: { id: from, type: "private" }, date: 0 } } });
const lastText = () => [...t.tg.sent].reverse().find((s) => s.text && s.method !== "answerCallbackQuery")?.text ?? "";
const answers = () => t.tg.sent.filter((s) => s.method === "answerCallbackQuery");
function buttons() {
  const m = [...t.tg.sent].reverse().find((s) => s.opts?.reply_markup && "inline_keyboard" in s.opts.reply_markup);
  return m ? (m.opts!.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard.flat() : [];
}
const button = (label: string) => {
  const b = buttons().find((x) => x.text.includes(label));
  if (!b) throw new Error(`botão "${label}" ausente: ${buttons().map((x) => x.text).join(", ")}`);
  return b.callback_data!;
};
async function txs(userId: number) {
  const { rows } = await t.db.query<{ kind: string; amount_cents: number; description: string; category: string | null; source: string }>(
    `SELECT t.kind, t.amount_cents, t.description, c.name AS category, t.source FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.user_id = $1 AND t.deleted_at IS NULL ORDER BY t.id`,
    [userId],
  );
  return rows;
}
const MENU = ["💸 Gastei", "💰 Recebi", "📈 Economizei", "📊 Meu resumo", "🎯 Minhas metas", "⚙️ Configurações"];

describe("boas-vindas com menu", () => {
  it.each(["Oi", "Olá", "Bom dia", "Boa tarde", "Boa noite", "/start", "/menu", "menu"])("“%s” mostra o menu principal", async (text) => {
    await send(msg(TG.luciana, text));
    expect(buttons().map((b) => b.text)).toEqual(MENU);
  });

  it("não vinculado não recebe menu nem dados", async () => {
    await send(msg(4242, "Oi"));
    expect(buttons()).toHaveLength(0);
    expect(lastText()).toMatch(/conecte sua conta/i);
    t.tg.clear();
    await send(cb(4242, "w:expense"));
    expect(answers().map((a) => a.text)).toEqual(["Conecte sua conta para usar este botão."]);
  });
});

describe("💸 Gastei: valor → categoria → descrição → confirmação", () => {
  it("fluxo completo registra uma vez e oferece próximos passos", async () => {
    await send(msg(TG.luciana, "/menu"));
    await send(cb(TG.luciana, button("Gastei")));
    expect(lastText()).toMatch(/Gastei[\s\S]*Qual foi o valor/);
    await send(msg(TG.luciana, "45,90"));
    expect(lastText()).toMatch(/R\$ 45,90[\s\S]*Em qual categoria/);
    await send(cb(TG.luciana, button("Alimentação fora")));
    expect(lastText()).toMatch(/Descreva o gasto/);
    await send(msg(TG.luciana, "almoço com a equipe"));
    expect(lastText()).toMatch(/Despesa: R\$ 45,90[\s\S]*Almoço com a equipe[\s\S]*Alimentação fora/);
    expect(buttons().map((b) => b.text)).toEqual(["✅ Confirmar", "✏️ Editar", "✖️ Cancelar"]);
    expect(await txs(t.ids.luciana)).toHaveLength(0);
    const c = button("Confirmar");
    await Promise.all([send(cb(TG.luciana, c)), send(cb(TG.luciana, c))]);
    expect(await txs(t.ids.luciana)).toEqual([{ kind: "expense", amount_cents: 4590, description: "Almoço com a equipe", category: "Alimentação fora", source: "telegram" }]);
    expect(lastText()).toMatch(/Registrado no Luna Finance/);
    expect(buttons().map((b) => b.text)).toEqual(["➕ Registrar outra", "🏠 Menu principal"]);
    // “Registrar outra” reinicia o mesmo fluxo
    await send(cb(TG.luciana, button("Registrar outra")));
    expect(lastText()).toMatch(/Gastei[\s\S]*Qual foi o valor/);
    await send(cb(TG.luciana, button("Menu principal")));
    expect(buttons().map((b) => b.text)).toEqual(MENU);
  });

  it("pular descrição usa o nome da categoria; editar antes de confirmar funciona", async () => {
    await send(cb(TG.joao, "w:expense"));
    await send(msg(TG.joao, "20"));
    await send(cb(TG.joao, button("Transporte")));
    await send(cb(TG.joao, button("Usar “Transporte”")));
    expect(lastText()).toMatch(/Despesa: R\$ 20,00[\s\S]*Descrição: Transporte/);
    await send(cb(TG.joao, button("Editar")));
    await send(cb(TG.joao, button("Valor")));
    await send(msg(TG.joao, "25"));
    await send(cb(TG.joao, button("Confirmar")));
    expect((await txs(t.ids.joao)).at(-1)).toMatchObject({ amount_cents: 2500, description: "Transporte", category: "Transporte" });
  });

  it("valor inválido pede de novo; botão de etapa antiga não faz nada", async () => {
    await send(cb(TG.joao, "w:expense"));
    await send(msg(TG.joao, "abc"));
    expect(lastText()).toMatch(/Não entendi o valor/);
    await send(msg(TG.joao, "10"));
    const catButton = button("Mercado");
    await send(cb(TG.joao, catButton));
    t.tg.clear();
    await send(cb(TG.joao, catButton)); // clique repetido na categoria
    expect(answers().map((a) => a.text)).toEqual(["Essa etapa já passou. Use o menu para começar de novo."]);
    await send(msg(TG.joao, "feira"));
    await send(cb(TG.joao, button("Cancelar")));
    expect((await txs(t.ids.joao)).some((r) => r.amount_cents === 1000)).toBe(false);
  });

  it("frase completa no meio do fluxo é entendida em linguagem natural", async () => {
    await send(cb(TG.joao, "w:expense"));
    await send(msg(TG.joao, "gastei 33 no cinema"));
    expect(lastText()).toMatch(/Despesa: R\$ 33,00[\s\S]*Cinema/);
    await send(cb(TG.joao, button("Cancelar")));
  });

  it("🏠 Menu principal no meio do fluxo encerra a etapa", async () => {
    await send(cb(TG.joao, "w:expense"));
    await send(cb(TG.joao, button("Menu principal")));
    expect(buttons().map((b) => b.text)).toEqual(MENU);
    await send(msg(TG.joao, "15"));
    expect(lastText()).not.toMatch(/Em qual categoria/); // a pergunta foi encerrada
  });
});

describe("💰 Recebi: valor → origem → confirmação", () => {
  it("origem por botão", async () => {
    await send(cb(TG.luciana, "w:income"));
    await send(msg(TG.luciana, "2.500"));
    expect(lastText()).toMatch(/origem dessa receita/);
    await send(cb(TG.luciana, button("Salário")));
    expect(lastText()).toMatch(/Receita: R\$ 2\.500,00[\s\S]*Salário/);
    await send(cb(TG.luciana, button("Confirmar")));
    expect((await txs(t.ids.luciana)).at(-1)).toMatchObject({ kind: "income", amount_cents: 250000, category: "Salário" });
  });

  it("origem digitada vira descrição e é classificada pelas palavras-chave", async () => {
    await send(cb(TG.luciana, "w:income"));
    await send(msg(TG.luciana, "300"));
    await send(msg(TG.luciana, "freela de design"));
    expect(lastText()).toMatch(/Receita: R\$ 300,00[\s\S]*Freela de design|freela de design[\s\S]*Freelance/i);
    await send(cb(TG.luciana, button("Confirmar")));
    expect((await txs(t.ids.luciana)).at(-1)).toMatchObject({ kind: "income", amount_cents: 30000, category: "Freelance" });
  });
});

describe("📈 Economizei: separa sem contar como receita", () => {
  it("sem meta nem conta de reserva: explica e oferece criar meta", async () => {
    await send(cb(TG.joao, "w:save"));
    await send(msg(TG.joao, "100"));
    expect(lastText()).toMatch(/não é contado como receita/);
    expect(buttons().map((b) => b.text)).toContain("➕ Criar meta");
  });

  it("para uma meta: vira contribuição, não altera receitas nem saldo", async () => {
    const lu = await t.as("luciana");
    const goal = (await lu.post("/api/goals").send({ name: "Reserva de emergência", targetCents: 1000000 })).body;
    const dashBefore = (await lu.get("/api/dashboard")).body;
    await send(cb(TG.luciana, "w:save"));
    await send(msg(TG.luciana, "200"));
    expect(lastText()).toMatch(/Onde você guardou/);
    await send(cb(TG.luciana, button("Reserva de emergência")));
    expect(lastText()).toMatch(/Guardar na meta[\s\S]*R\$ 200,00/);
    const c = button("Confirmar");
    await send(cb(TG.luciana, c));
    await send(cb(TG.luciana, c)); // clique duplo
    expect(lastText()).toMatch(/Contribuição registrada[\s\S]*Total separado: R\$ 200,00 em metas[\s\S]*Economia não é receita/);
    expect(buttons().map((b) => b.text)).toEqual(["➕ Registrar outra", "🏠 Menu principal"]);
    const { rows } = await t.db.query("SELECT count(*)::int AS n, sum(amount_cents)::bigint AS v FROM goal_contributions WHERE goal_id = $1", [goal.id]);
    expect(rows[0]).toEqual({ n: 1, v: 20000 });
    const dashAfter = (await lu.get("/api/dashboard")).body;
    expect(dashAfter.totals).toEqual(dashBefore.totals);
    expect(dashAfter.balanceCents).toBe(dashBefore.balanceCents);
  });

  it("para conta de reserva: vira transferência da conta principal (saldo total igual)", async () => {
    const lu = await t.as("luciana");
    await lu.post("/api/accounts").send({ name: "Poupança", type: "savings" });
    const before = (await lu.get("/api/dashboard")).body;
    await send(cb(TG.luciana, "w:save"));
    await send(msg(TG.luciana, "150"));
    await send(cb(TG.luciana, button("🏦 Poupança")));
    expect(lastText()).toMatch(/Transferência: R\$ 150,00[\s\S]*De: Conta principal[\s\S]*Para: Poupança/);
    await send(cb(TG.luciana, button("Confirmar")));
    expect(lastText()).toMatch(/R\$ 150,00 em contas de reserva/);
    const after = (await lu.get("/api/dashboard")).body;
    expect(after.balanceCents).toBe(before.balanceCents);
    expect(after.totals).toEqual(before.totals);
  });

  it("não aceita meta individual de outra pessoa como destino", async () => {
    const lu = await t.as("luciana");
    const own = (await lu.post("/api/goals").send({ name: "Viagem da Luciana", targetCents: 50000 })).body;
    await (await t.as("joao")).post("/api/accounts").send({ name: "Cofrinho", type: "savings" });
    await send(cb(TG.joao, "w:save"));
    await send(msg(TG.joao, "50"));
    expect(lastText()).toMatch(/Onde você guardou/); // chegou na etapa de destino
    expect(buttons().map((b) => b.text)).not.toContain("🎯 Viagem da Luciana");
    t.tg.clear();
    // João forja o callback com a meta individual da Luciana
    await send(cb(TG.joao, `ws:g${own.id}`));
    expect(lastText()).toMatch(/Não encontrei essa meta/);
    // e com a conta da Luciana
    const luAcc = (await t.db.query<{ id: number }>("SELECT id FROM accounts WHERE owner_id = $1 AND NOT is_default LIMIT 1", [t.ids.luciana])).rows[0].id;
    await send(cb(TG.joao, "w:save"));
    await send(msg(TG.joao, "50"));
    await send(cb(TG.joao, `ws:a${luAcc}`));
    expect(lastText()).toMatch(/Essa conta não está disponível/);
    const tr = await t.db.query("SELECT count(*)::int AS n FROM transfers WHERE user_id = $1", [t.ids.joao]);
    expect(tr.rows[0].n).toBe(0);
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM goal_contributions WHERE goal_id = $1", [own.id]);
    expect(rows[0].n).toBe(0);
  });
});

describe("📊 Meu resumo, 🎯 Minhas metas e ⚙️ Configurações", () => {
  it("resumo e metas usam os dados reais; configurações abrem as preferências", async () => {
    await send(msg(TG.luciana, "/menu"));
    await send(cb(TG.luciana, button("Meu resumo")));
    const dash = (await (await t.as("luciana")).get("/api/dashboard")).body;
    expect(lastText()).toMatch(/Resumo em novembro de 2026/);
    expect(lastText()).toContain(`Receitas: R$ ${(dash.totals.incomeTotalCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
    await send(msg(TG.luciana, "/menu"));
    await send(cb(TG.luciana, button("Minhas metas")));
    expect(lastText()).toMatch(/Metas[\s\S]*Reserva de emergência[\s\S]*2%/);
    await send(msg(TG.luciana, "/menu"));
    await send(cb(TG.luciana, button("Configurações")));
    expect(lastText()).toMatch(/Configurações[\s\S]*Luciana/);
  });
});

describe("robustez dos botões", () => {
  it("todo clique recebe answerCallbackQuery, inclusive com erro no meio", async () => {
    const real = t.ctx.db.query.bind(t.ctx.db);
    t.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      if (/FROM telegram_conversations/.test(sql)) throw new Error("ECONNRESET");
      return real(sql, params);
    }) as typeof t.ctx.db.query;
    t.tg.clear();
    const r = await send(cb(TG.joao, "wc:1"));
    t.ctx.db.query = real;
    expect(r.status).toBe(500); // Telegram reenvia
    expect(answers()).toHaveLength(1); // e mesmo assim o carregamento foi encerrado
  });

  it("callback desconhecido ou malformado é respondido sem efeito", async () => {
    for (const data of ["", "zz", "w:hack", "ws:", "c:x", "m:abc"]) {
      t.tg.clear();
      const r = await send(cb(TG.joao, data));
      expect(r.status).toBe(200);
      expect(answers().length).toBeGreaterThanOrEqual(1);
    }
  });
});
