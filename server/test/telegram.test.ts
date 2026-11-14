/**
 * Testes do bot do Telegram — numerados conforme os cenários obrigatórios:
 *  1 vinculação · 2 vinculação não autorizada · 3 despesa · 4 receita · 5 cancelamento
 *  6 edição antes de confirmar · 7 confirmação duplicada · 8 updates repetidos · 9 saldo
 * 10 relatórios · 11 metas · 12 isolamento · 13 falha de banco · 14 falha da API do Telegram
 * 15 mensagens inválidas · 16 vírgula decimal · 17 datas/fuso · 18 segurança do webhook
 * Dados 100% fictícios, banco PGlite em memória.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setNow } from "../src/lib/clock.js";
import { runScheduledJobs } from "../src/notifications/jobs.js";
import { createTelegramApi, TelegramError } from "../src/telegram/api.js";
import type { TgUpdate } from "../src/telegram/bot.js";
import { aiLimiter, messageLimiter } from "../src/telegram/throttle.js";
import { WEBHOOK_SECRET, setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let updateId = 1000;
const TG = { luciana: 5001, luis: 5002, joao: 5004, stranger: 9999 };
const NOW = "2026-11-14T15:00:00Z"; // 12h em São Paulo

beforeAll(async () => {
  t = await setupTestApp({ now: NOW });
});
afterAll(async () => {
  setNow(null);
  await t.close();
});
beforeEach(() => {
  t.tg.clear();
  setNow(NOW);
  // os testes enviam dezenas de mensagens por segundo; o limite é testado à parte
  messageLimiter.reset();
  aiLimiter.reset();
});

// ------------------------------- utilitários -------------------------------
function send(update: Omit<TgUpdate, "update_id"> & { update_id?: number }, secret = WEBHOOK_SECRET) {
  return request(t.app)
    .post("/telegram/webhook")
    .set("x-telegram-bot-api-secret-token", secret)
    .send({ update_id: update.update_id ?? updateId++, ...update });
}
function msg(from: number, text: string | undefined, chatType = "private") {
  return { message: { message_id: updateId, from: { id: from, first_name: "X" }, chat: { id: from, type: chatType }, date: 0, ...(text !== undefined ? { text } : {}) } };
}
function cb(from: number, data: string) {
  return { callback_query: { id: `cb${updateId}`, from: { id: from }, data, message: { message_id: 55, chat: { id: from, type: "private" }, date: 0 } } };
}
const texts = () => t.tg.sent.filter((s) => s.text).map((s) => s.text!).join("\n---\n");
const lastText = () => [...t.tg.sent].reverse().find((s) => s.text && s.method !== "answerCallbackQuery")?.text ?? "";
const answers = () => t.tg.sent.filter((s) => s.method === "answerCallbackQuery").map((s) => s.text ?? "").join(" | ");
function buttons() {
  const withKb = [...t.tg.sent].reverse().find((s) => s.opts?.reply_markup && "inline_keyboard" in s.opts.reply_markup);
  return withKb ? (withKb.opts!.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard.flat() : [];
}
const button = (label: string | RegExp) => {
  const b = buttons().find((x) => (typeof label === "string" ? x.text.includes(label) : label.test(x.text)));
  if (!b) throw new Error(`botão "${label}" não encontrado em: ${buttons().map((x) => x.text).join(", ")}`);
  return b.callback_data!;
};
async function txs(userId: number) {
  const { rows } = await t.db.query<{ id: number; kind: string; amount_cents: number; description: string; date: string; status: string; source: string; payment_method: string | null; category: string | null }>(
    `SELECT t.id, t.kind, t.amount_cents, t.description, t.date, t.status, t.source, t.payment_method, c.name AS category
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.user_id = $1 AND t.deleted_at IS NULL ORDER BY t.id`,
    [userId],
  );
  return rows;
}
async function linkAs(key: "luciana" | "joao" | "luis", tgId: number) {
  const s = await t.as(key);
  const r = await s.post("/api/telegram/link-code");
  await send(msg(tgId, `/vincular ${r.body.code}`));
}

// ============================================================================
describe("18 · segurança do webhook", () => {
  it("recusa requisição sem segredo, com segredo errado e corpo gigante", async () => {
    expect((await request(t.app).post("/telegram/webhook").send({ update_id: 1 })).status).toBe(401);
    expect((await send(msg(TG.stranger, "/saldo"), "segredo-errado")).status).toBe(401);
    expect((await send(msg(TG.stranger, "/saldo"), WEBHOOK_SECRET.slice(0, -1))).status).toBe(401);
    const huge = await request(t.app).post("/telegram/webhook").set("x-telegram-bot-api-secret-token", WEBHOOK_SECRET).set("content-type", "application/json").send(JSON.stringify({ update_id: 2, pad: "x".repeat(300_000) }));
    expect(huge.status).toBe(413);
    expect(t.tg.sent).toHaveLength(0);
  });

  it("o token do bot nunca aparece em respostas ou na API do site", async () => {
    const s = await t.as("luciana");
    const r = await s.get("/api/telegram/status");
    expect(JSON.stringify(r.body)).not.toContain(t.ctx.config.telegram.botToken + ":");
    expect(Object.keys(r.body)).toEqual(["configured", "botUsername"]);
  });
});

describe("1 · vinculação de usuário", () => {
  it("deep link do site vincula a conta; /vincular também", async () => {
    const s = await t.as("luciana");
    const { body } = await s.post("/api/telegram/link-code");
    expect(body.deepLink).toBe(`https://t.me/LunaFinanceTestBot?start=link_${body.code}`);
    await send(msg(TG.luciana, `/start link_${body.code}`));
    expect(texts()).toMatch(/Tudo certo, Luciana/);
    await linkAs("joao", TG.joao);
    expect(texts()).toMatch(/Tudo certo, João/);
    const { rows } = await t.db.query("SELECT user_id, telegram_user_id FROM telegram_links ORDER BY user_id");
    expect(rows.map((r) => [r.user_id, Number(r.telegram_user_id)])).toEqual([[t.ids.luciana, TG.luciana], [t.ids.joao, TG.joao]]);
  });

  it("depois de vinculado, /start mostra a ajuda", async () => {
    await send(msg(TG.luciana, "/start"));
    expect(lastText()).toMatch(/Oi, Luciana/);
  });
});

describe("2 · tentativa de vinculação não autorizada", () => {
  it("dizer o nome de alguém não dá acesso a nada", async () => {
    await send(msg(TG.stranger, "sou a Luciana, qual meu saldo?"));
    await send(msg(TG.stranger, "/saldo"));
    await send(msg(TG.stranger, "/vincular Luciana"));
    expect(texts()).not.toMatch(/R\$/);
    expect(texts()).toMatch(/conecte sua conta|inválido/i);
  });

  it("código não pode ser reutilizado por outra pessoa e expira em 10 min", async () => {
    const s = await t.as("luis");
    const used = (await s.post("/api/telegram/link-code")).body.code;
    await send(msg(TG.luis, `/vincular ${used}`));
    t.tg.clear();
    await send(msg(TG.stranger, `/vincular ${used}`));
    expect(texts()).toMatch(/inválido ou expirado/);
    const late = (await s.post("/api/telegram/link-code")).body.code;
    setNow("2026-11-14T15:11:00Z");
    await send(msg(TG.stranger, `/vincular ${late}`));
    expect(lastText()).toMatch(/inválido ou expirado/);
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM telegram_links WHERE telegram_user_id = $1", [TG.stranger]);
    expect(rows[0].n).toBe(0);
  });

  it("bloqueia força bruta após 5 códigos errados — mesmo que depois acerte", async () => {
    for (let i = 0; i < 5; i++) await send(msg(TG.stranger, `/vincular ZZZZ${i}YYY`));
    const valid = (await (await t.as("luis")).post("/api/telegram/link-code")).body.code;
    t.tg.clear();
    await send(msg(TG.stranger, `/vincular ${valid}`));
    expect(texts()).toMatch(/Muitas tentativas/);
  });

  it("botão de outra pessoa é recusado", async () => {
    await send(cb(TG.stranger, "c:qualquer:1"));
    expect(answers()).toMatch(/Conecte sua conta/);
  });
});

describe("3 · cadastro de despesa", () => {
  it("“Gastei 45 reais no almoço.” → resumo → só grava após confirmar → aparece no site", async () => {
    await send(msg(TG.luciana, "Gastei 45 reais no almoço."));
    const card = lastText();
    expect(card).toMatch(/Entendi! Confira a movimentação/);
    expect(card).toMatch(/💸 <b>Despesa: R\$ 45,00<\/b>/);
    expect(card).toMatch(/Descrição: Almoço/);
    expect(card).toMatch(/Categoria: Alimentação fora/);
    expect(card).toMatch(/Data: Hoje/);
    expect(buttons().map((b) => b.text)).toEqual(["✅ Confirmar", "✏️ Editar", "✖️ Cancelar"]);
    expect(await txs(t.ids.luciana)).toHaveLength(0);

    await send(cb(TG.luciana, button("Confirmar")));
    expect(lastText()).toMatch(/Registrado no Luna Finance/);
    const rows = await txs(t.ids.luciana);
    expect(rows).toEqual([expect.objectContaining({ kind: "expense", amount_cents: 4500, description: "Almoço", source: "telegram", status: "paid", date: "2026-11-14" })]);

    const web = await (await t.as("luciana")).get("/api/transactions");
    expect(web.body.items.map((i: { description: string }) => i.description)).toContain("Almoço");
  });

  it("forma de pagamento e data relativa: “Gastei 32 reais ontem com Uber.” / “Paguei 250 de mercado no Pix.”", async () => {
    await send(msg(TG.luciana, "Gastei 32 reais ontem com Uber."));
    expect(lastText()).toMatch(/Data: Ontem/);
    expect(lastText()).toMatch(/Categoria: Transporte/);
    await send(cb(TG.luciana, button("Confirmar")));
    await send(msg(TG.luciana, "Paguei 250 de mercado no Pix."));
    expect(lastText()).toMatch(/Pagamento: Pix/);
    await send(cb(TG.luciana, button("Confirmar")));
    await send(msg(TG.luciana, "Comprei uma camiseta por 89,90 no cartão."));
    expect(lastText()).toMatch(/Pagamento: Cartão de crédito/);
    expect(lastText()).toMatch(/Categoria: Compras/);
    await send(cb(TG.luciana, button("Confirmar")));
    const rows = await txs(t.ids.luciana);
    expect(rows.find((r) => r.description === "Uber")).toMatchObject({ amount_cents: 3200, date: "2026-11-13" });
    expect(rows.find((r) => r.description === "Mercado")).toMatchObject({ amount_cents: 25000, payment_method: "pix" });
    expect(rows.find((r) => r.description === "Camiseta")).toMatchObject({ amount_cents: 8990, payment_method: "credit_card" });
  });

  it("mensagem incompleta: pergunta só o valor", async () => {
    await send(msg(TG.luciana, "paguei a farmácia"));
    expect(lastText()).toMatch(/Qual foi o valor/);
    await send(msg(TG.luciana, "abc"));
    expect(lastText()).toMatch(/Não entendi o valor/);
    await send(msg(TG.luciana, "37,50"));
    expect(lastText()).toMatch(/Despesa: R\$ 37,50/);
    expect(lastText()).toMatch(/Categoria: Saúde/);
    await send(cb(TG.luciana, button("Cancelar")));
  });

  it("possível duplicidade é sinalizada antes de confirmar", async () => {
    await send(msg(TG.luciana, "Gastei 45 reais no almoço"));
    expect(lastText()).toMatch(/Possível duplicidade/);
    await send(cb(TG.luciana, button("Cancelar")));
  });
});

describe("4 · cadastro de receita", () => {
  it("“Recebi 2.500 de salário.” e “Ganhei 300 reais de um trabalho.”", async () => {
    await send(msg(TG.luciana, "Recebi 2.500 de salário."));
    expect(lastText()).toMatch(/💰 <b>Receita: R\$ 2\.500,00<\/b>/);
    expect(lastText()).toMatch(/Categoria: Salário/);
    await send(cb(TG.luciana, button("Confirmar")));
    await send(msg(TG.luciana, "Ganhei 300 reais de um trabalho."));
    expect(lastText()).toMatch(/Categoria: Freelance/);
    await send(cb(TG.luciana, button("Confirmar")));
    const income = (await txs(t.ids.luciana)).filter((r) => r.kind === "income");
    expect(income.map((r) => r.amount_cents).sort()).toEqual([250000, 30000].sort());
    const dash = await (await t.as("luciana")).get("/api/dashboard");
    expect(dash.body.totals.incomeTotalCents).toBe(280000);
  });

  it("valor sem tipo: pergunta se é receita ou despesa", async () => {
    await send(msg(TG.joao, "mesada 200"));
    expect(lastText()).toMatch(/despesa ou uma receita/);
    await send(cb(TG.joao, button("Receita")));
    expect(lastText()).toMatch(/Receita: R\$ 200,00/);
    await send(cb(TG.joao, button("Confirmar")));
    expect((await txs(t.ids.joao)).map((r) => r.kind)).toEqual(["income"]);
  });
});

describe("5 · cancelamento", () => {
  it("botão Cancelar não grava e invalida a confirmação", async () => {
    const before = (await txs(t.ids.joao)).length;
    await send(msg(TG.joao, "gastei 30 no cinema"));
    const confirmData = button("Confirmar");
    await send(cb(TG.joao, button("Cancelar")));
    expect(lastText()).toMatch(/Cancelado/);
    await send(cb(TG.joao, confirmData));
    expect(answers()).toMatch(/cancelada/);
    expect(await txs(t.ids.joao)).toHaveLength(before);
  });

  it("/cancelar encerra operações e perguntas em andamento", async () => {
    await send(msg(TG.joao, "gastei 12 de lanche"));
    const confirmData = button("Confirmar");
    await send(msg(TG.joao, "paguei o estacionamento"));
    expect(lastText()).toMatch(/Qual foi o valor/);
    await send(msg(TG.joao, "/cancelar"));
    expect(lastText()).toMatch(/cancelei/);
    await send(msg(TG.joao, "15"));
    expect(lastText()).not.toMatch(/Despesa: R\$ 15,00/); // a pergunta foi encerrada
    await send(cb(TG.joao, confirmData));
    expect((await txs(t.ids.joao)).some((r) => r.description === "Lanche")).toBe(false);
  });
});

describe("6 · edição antes da confirmação", () => {
  it("edita valor, data, categoria, pagamento e tipo; cartão antigo deixa de valer", async () => {
    await send(msg(TG.joao, "gastei 20 no lanche"));
    const oldConfirm = button("Confirmar");
    // valor
    await send(cb(TG.joao, button("Editar")));
    await send(cb(TG.joao, button("Valor")));
    expect(lastText()).toMatch(/novo valor/);
    await send(msg(TG.joao, "22,50"));
    expect(lastText()).toMatch(/Despesa: R\$ 22,50/);
    expect(t.tg.sent.some((s) => s.text?.includes("Resumo atualizado"))).toBe(true);
    // confirmar o cartão antigo NÃO funciona
    await send(cb(TG.joao, oldConfirm));
    expect(answers()).toMatch(/alterado/);
    expect((await txs(t.ids.joao)).some((r) => r.description === "Lanche")).toBe(false);
    // data
    await send(cb(TG.joao, button("Editar")));
    await send(cb(TG.joao, button("Data")));
    await send(msg(TG.joao, "ontem"));
    expect(lastText()).toMatch(/Data: Ontem/);
    // categoria
    await send(cb(TG.joao, button("Editar")));
    await send(cb(TG.joao, button("Categoria")));
    await send(cb(TG.joao, button("Lazer")));
    expect(lastText()).toMatch(/Categoria: Lazer/);
    // pagamento
    await send(cb(TG.joao, button("Editar")));
    await send(cb(TG.joao, button("Pagamento")));
    await send(cb(TG.joao, button("Dinheiro")));
    expect(lastText()).toMatch(/Pagamento: Dinheiro/);
    // descrição
    await send(cb(TG.joao, button("Editar")));
    await send(cb(TG.joao, button("Descrição")));
    await send(msg(TG.joao, "Lanche com amigos"));
    expect(lastText()).toMatch(/Descrição: Lanche com amigos/);
    // confirma a versão atual
    await send(cb(TG.joao, button("Confirmar")));
    expect((await txs(t.ids.joao)).find((r) => r.description === "Lanche com amigos")).toMatchObject({
      amount_cents: 2250, date: "2026-11-13", category: "Lazer", payment_method: "cash",
    });
  });

  it("trocar de despesa para receita reajusta a categoria", async () => {
    await send(msg(TG.joao, "uber 40"));
    await send(cb(TG.joao, button("Editar")));
    await send(cb(TG.joao, button("É receita")));
    expect(lastText()).toMatch(/Receita: R\$ 40,00/);
    expect(lastText()).toMatch(/Categoria: Outras receitas/);
    await send(cb(TG.joao, button("Cancelar")));
  });

  it("valor inválido na edição é recusado sem perder o rascunho", async () => {
    await send(msg(TG.joao, "gastei 10 na padaria"));
    await send(cb(TG.joao, button("Editar")));
    await send(cb(TG.joao, button("Valor")));
    await send(msg(TG.joao, "dez mil e poucos"));
    expect(lastText()).toMatch(/Valor inválido/);
    await send(msg(TG.joao, "/cancelar"));
  });
});

describe("7 · confirmação duplicada", () => {
  it("dois cliques (inclusive simultâneos) gravam uma única vez", async () => {
    await send(msg(TG.luciana, "gastei 77 na feira"));
    const c = button("Confirmar");
    await Promise.all([send(cb(TG.luciana, c)), send(cb(TG.luciana, c)), send(cb(TG.luciana, c))]);
    await send(cb(TG.luciana, c));
    expect((await txs(t.ids.luciana)).filter((r) => r.amount_cents === 7700)).toHaveLength(1);
    expect(answers()).toMatch(/já foi registrado/);
  });

  it("confirmação expirada não grava", async () => {
    await send(msg(TG.luciana, "gastei 66 no posto"));
    const c = button("Confirmar");
    setNow("2026-11-14T15:20:00Z");
    await send(cb(TG.luciana, c));
    expect(answers()).toMatch(/expirou/);
    expect((await txs(t.ids.luciana)).some((r) => r.amount_cents === 6600)).toBe(false);
  });
});

describe("8 · mensagens repetidas do Telegram", () => {
  it("mesmo update_id (mensagem ou botão) é processado uma única vez", async () => {
    const fixed = updateId++;
    await send({ update_id: fixed, ...msg(TG.luciana, "gastei 15 de café") });
    await send({ update_id: fixed, ...msg(TG.luciana, "gastei 15 de café") });
    expect(t.tg.sent.filter((s) => s.text?.includes("R$ 15,00"))).toHaveLength(1);
    const c = button("Confirmar");
    const cbId = updateId++;
    await send({ update_id: cbId, ...cb(TG.luciana, c) });
    await send({ update_id: cbId, ...cb(TG.luciana, c) });
    expect((await txs(t.ids.luciana)).filter((r) => r.amount_cents === 1500)).toHaveLength(1);
  });
});

describe("9 · consulta de saldo", () => {
  it("/saldo e “Quanto tenho disponível?” batem com o site", async () => {
    const accounts = await (await t.as("luciana")).get("/api/accounts");
    const total = accounts.body.reduce((s: number, a: { balanceCents: number }) => s + a.balanceCents, 0);
    const brl = (total / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/ /g, " ");
    await send(msg(TG.luciana, "/saldo"));
    expect(lastText()).toContain(`Seu saldo: ${brl}`);
    await send(msg(TG.luciana, "Quanto tenho disponível?"));
    expect(lastText()).toContain(brl);
  });

  it("lançamento feito no SITE aparece no saldo do bot", async () => {
    await (await t.as("luciana")).post("/api/transactions").send({ kind: "income", amountCents: 12345, description: "Venda bazar", date: "2026-11-14" });
    await send(msg(TG.luciana, "qual meu saldo?"));
    const accounts = await (await t.as("luciana")).get("/api/accounts");
    const total = accounts.body.reduce((s: number, a: { balanceCents: number }) => s + a.balanceCents, 0);
    expect(lastText()).toContain((total / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
  });
});

describe("10 · relatórios e consultas", () => {
  it("“Quanto gastei este mês?” e “com alimentação” usam o banco", async () => {
    const { rows } = await t.db.query<{ v: number }>(
      "SELECT sum(amount_cents)::bigint AS v FROM transactions WHERE user_id = $1 AND kind='expense' AND deleted_at IS NULL AND date BETWEEN '2026-11-01' AND '2026-11-30'",
      [t.ids.luciana],
    );
    const brl = (rows[0].v / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
    await send(msg(TG.luciana, "Quanto gastei este mês?"));
    expect(lastText()).toContain(`Despesas em novembro de 2026: R$ ${brl}`);
    const { rows: food } = await t.db.query<{ v: number }>(
      `SELECT sum(t.amount_cents)::bigint AS v FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = $1 AND c.name = 'Alimentação fora' AND t.deleted_at IS NULL AND t.date BETWEEN '2026-11-01' AND '2026-11-30'`,
      [t.ids.luciana],
    );
    await send(msg(TG.luciana, "Quanto gastei com alimentação?"));
    expect(lastText()).toMatch(/Alimentação fora/);
    expect(lastText()).toContain(`R$ ${(food[0].v / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
  });

  it("hoje, últimas despesas, últimas receitas, comparação", async () => {
    await send(msg(TG.luciana, "Quanto gastei hoje?"));
    expect(lastText()).toMatch(/Despesas hoje/);
    await send(msg(TG.luciana, "Quais foram minhas últimas despesas?"));
    expect(lastText()).toMatch(/Últimas despesas/);
    expect(lastText()).toMatch(/Almoço/);
    await send(msg(TG.luciana, "/receitas"));
    expect(lastText()).toMatch(/Últimas receitas[\s\S]*Salário/);
    await send(msg(TG.luciana, "Compare meus gastos deste mês com o anterior."));
    expect(lastText()).toMatch(/novembro × outubro/);
  });

  it("/resumo traz menu de relatórios e cada botão responde", async () => {
    await send(msg(TG.luciana, "/resumo"));
    expect(lastText()).toMatch(/Resumo em novembro de 2026/);
    for (const [label, expected] of [
      ["Hoje", /Resumo hoje/],
      ["Semana", /Resumo últimos 7 dias/],
      ["Por categoria", /Gastos por categoria/],
      ["Comparar meses", /novembro × outubro/],
      ["Maiores despesas", /Maiores despesas/],
      ["Receitas × despesas", /Receitas × despesas \(6 meses\)/],
      ["Evolução do saldo", /Evolução do saldo/],
    ] as const) {
      await send(msg(TG.luciana, "/resumo"));
      await send(cb(TG.luciana, button(label)));
      expect(lastText()).toMatch(expected);
    }
  });
});

describe("11 · metas", () => {
  it("criar meta por mensagem, guardar dinheiro e consultar progresso", async () => {
    await send(msg(TG.luciana, "criar meta de 50 mil para comprar um carro até 12/2027"));
    expect(lastText()).toMatch(/Nova meta[\s\S]*Comprar um carro[\s\S]*R\$ 50\.000,00[\s\S]*31\/12\/2027/);
    await send(cb(TG.luciana, button("Confirmar")));
    expect(lastText()).toMatch(/Meta criada/);
    const web = await (await t.as("luciana")).get("/api/goals");
    const goal = web.body.find((g: { name: string }) => g.name === "Comprar um carro");
    expect(goal).toBeTruthy();

    await send(msg(TG.luciana, "guardei 1.500 na meta carro"));
    expect(lastText()).toMatch(/Guardar na meta[\s\S]*R\$ 1\.500,00/);
    await send(cb(TG.luciana, button("Confirmar")));
    expect(lastText()).toMatch(/Contribuição registrada[\s\S]*R\$ 1\.500,00 de R\$ 50\.000,00/);

    await send(msg(TG.luciana, "Como está minha meta de comprar um carro?"));
    const out = lastText();
    expect(out).toMatch(/Guardado: <b>R\$ 1\.500,00<\/b> de R\$ 50\.000,00/);
    expect(out).toMatch(/Falta: <b>R\$ 48\.500,00<\/b>/);
    expect(out).toMatch(/3%/);
    expect(out).toMatch(/No seu ritmo atual|não há contribuições recentes/);
  });

  it("criação guiada pelo botão e retirada", async () => {
    await send(msg(TG.joao, "/metas"));
    await send(cb(TG.joao, button("Nova meta")));
    await send(msg(TG.joao, "Videogame"));
    await send(msg(TG.joao, "3000"));
    await send(cb(TG.joao, button("Sem prazo")));
    expect(lastText()).toMatch(/Nova meta[\s\S]*Videogame[\s\S]*sem prazo/);
    await send(cb(TG.joao, button("Confirmar")));
    await send(msg(TG.joao, "guardei 500 na meta videogame"));
    await send(cb(TG.joao, button("Confirmar")));
    await send(msg(TG.joao, "tirei 100 da meta videogame"));
    expect(lastText()).toMatch(/Retirada da meta/);
    await send(cb(TG.joao, button("Confirmar")));
    const { rows } = await t.db.query("SELECT sum(amount_cents)::bigint AS v FROM goal_contributions c JOIN goals g ON g.id = c.goal_id WHERE g.name = 'Videogame'");
    expect(Number(rows[0].v)).toBe(40000);
  });
});

describe("12 · isolamento de dados entre familiares", () => {
  it("João não vê, não confirma e não paga nada da Luciana", async () => {
    await send(msg(TG.joao, "Quais foram minhas últimas despesas?"));
    expect(lastText()).not.toMatch(/Almoço|Mercado|Camiseta/);
    await send(msg(TG.joao, "/saldo"));
    const joaoAcc = await (await t.as("joao")).get("/api/accounts");
    expect(lastText()).toContain(((joaoAcc.body[0].balanceCents as number) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));

    // rascunho da Luciana
    await send(msg(TG.luciana, "gastei 99 na loja"));
    const c = button("Confirmar");
    const editData = button("Editar");
    t.tg.clear();
    await send(cb(TG.joao, c));
    await send(cb(TG.joao, editData));
    expect(answers()).toMatch(/não está mais disponível/);
    expect((await txs(t.ids.luciana)).some((r) => r.amount_cents === 9900)).toBe(false);
    expect((await txs(t.ids.joao)).some((r) => r.amount_cents === 9900)).toBe(false);

    // conta a pagar da Luciana
    const bill = await (await t.as("luciana")).post("/api/transactions").send({ kind: "expense", amountCents: 8800, description: "Celular", date: "2026-11-20", status: "pending" });
    await send(cb(TG.joao, `pc:${bill.body[0].id}`));
    expect((await t.db.query("SELECT status FROM transactions WHERE id = $1", [bill.body[0].id])).rows[0].status).toBe("pending");
  });

  it("visão familiar respeita a permissão configurada no site", async () => {
    await t.setAccess("joao", "none");
    await send(msg(TG.joao, "/familia"));
    expect(lastText()).toMatch(/não tem acesso/);
    await t.setAccess("joao", "summary");
    await send(msg(TG.joao, "/familia"));
    expect(lastText()).toMatch(/Saldo total/);
    expect(lastText()).not.toMatch(/Por pessoa/);
    await t.setAccess("joao", "full");
    await send(msg(TG.joao, "/familia"));
    expect(lastText()).toMatch(/Por pessoa/);
    expect(texts().toLowerCase()).not.toMatch(/admin|administrador/);
  });
});

describe("13 · falha de banco de dados", () => {
  it("falha ao gravar na confirmação: nada é salvo, usuário é avisado e pode tentar de novo", async () => {
    await send(msg(TG.luciana, "gastei 41 na papelaria"));
    const c = button("Confirmar");
    const realTx = t.ctx.db.tx.bind(t.ctx.db);
    t.ctx.db.tx = async () => {
      throw new Error("connection terminated unexpectedly");
    };
    t.tg.clear();
    await send(cb(TG.luciana, c));
    t.ctx.db.tx = realTx;
    expect(texts()).toMatch(/Nada foi salvo/);
    expect(texts()).not.toMatch(/Registrado/);
    expect((await txs(t.ids.luciana)).some((r) => r.amount_cents === 4100)).toBe(false);
    // continua pendente → nova tentativa funciona uma única vez
    await send(cb(TG.luciana, c));
    expect(lastText()).toMatch(/Registrado/);
    expect((await txs(t.ids.luciana)).filter((r) => r.amount_cents === 4100)).toHaveLength(1);
  });

  it("banco fora do ar durante o processamento: responde 500 para o Telegram reenviar e processa uma vez quando volta", async () => {
    const realQuery = t.ctx.db.query.bind(t.ctx.db);
    let failing = true;
    t.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      if (failing && /FROM telegram_links/.test(sql)) throw new Error("ECONNRESET");
      return realQuery(sql, params);
    }) as typeof t.ctx.db.query;
    const fixed = updateId++;
    const first = await send({ update_id: fixed, ...msg(TG.luciana, "/saldo") });
    expect(first.status).toBe(500);
    expect(t.tg.sent.filter((s) => s.text?.includes("Seu saldo"))).toHaveLength(0);
    failing = false;
    const retry = await send({ update_id: fixed, ...msg(TG.luciana, "/saldo") });
    t.ctx.db.query = realQuery;
    expect(retry.status).toBe(200);
    const again = await send({ update_id: fixed, ...msg(TG.luciana, "/saldo") });
    expect(again.status).toBe(200);
    expect(t.tg.sent.filter((s) => s.text?.includes("Seu saldo"))).toHaveLength(1);
  });

  it("após 3 falhas seguidas, avisa o usuário sem afirmar sucesso e para de pedir reenvio", async () => {
    const realQuery = t.ctx.db.query.bind(t.ctx.db);
    t.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      if (/FROM telegram_links/.test(sql)) throw new Error("ECONNRESET");
      return realQuery(sql, params);
    }) as typeof t.ctx.db.query;
    const fixed = updateId++;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await send({ update_id: fixed, ...msg(TG.luciana, "gastei 5 de bala") })).status);
    t.ctx.db.query = realQuery;
    expect(codes).toEqual([500, 500, 200, 200]);
    expect(lastText()).toMatch(/problema técnico[\s\S]*confira \/despesas/);
    expect(lastText()).not.toMatch(/Registrado/);
  });
});

describe("14 · falha da API do Telegram", () => {
  it("se o cartão não puder ser enviado, nada é gravado e o update é reprocessado", async () => {
    t.tg.failNext("sendMessage", new TelegramError("sendMessage", 502, "Bad Gateway", { transient: true }));
    const fixed = updateId++;
    const r1 = await send({ update_id: fixed, ...msg(TG.joao, "gastei 18 no açaí") });
    expect(r1.status).toBe(500);
    const r2 = await send({ update_id: fixed, ...msg(TG.joao, "gastei 18 no açaí") });
    expect(r2.status).toBe(200);
    expect(lastText()).toMatch(/Despesa: R\$ 18,00/);
    expect((await txs(t.ids.joao)).some((r) => r.amount_cents === 1800)).toBe(false);
    await send(cb(TG.joao, button("Cancelar")));
  });

  it("se o aviso pós-confirmação falhar, o dado continua salvo e o bot reenvia o aviso", async () => {
    await send(msg(TG.joao, "gastei 19 no sorvete"));
    const c = button("Confirmar");
    t.tg.failNext("editMessageText", new TelegramError("editMessageText", 400, "Bad Request: message to edit not found"));
    await send(cb(TG.joao, c));
    expect((await txs(t.ids.joao)).filter((r) => r.amount_cents === 1900)).toHaveLength(1);
    expect(lastText()).toMatch(/Registrado/);
  });

  it("cliente HTTP: 429 respeita retry_after, rede instável tenta de novo, “not modified” é ignorado, token não vaza", async () => {
    const calls: string[] = [];
    let n = 0;
    const fake = (async (url: string) => {
      calls.push(String(url).replace(/bot[^/]+/, "bot<token>"));
      n++;
      if (n === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } }), { status: 429 });
      if (n === 2) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      if (n === 3) throw new TypeError("fetch failed");
      if (n === 4) return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }), { status: 400 });
    }) as unknown as typeof fetch;
    const api = createTelegramApi("123:SECRET", fake);
    expect(await api.sendMessage(1, "a")).toEqual({ message_id: 1 });
    expect(await api.sendMessage(1, "b")).toEqual({ message_id: 2 });
    await expect(api.editMessageText(1, 1, "c")).resolves.toBeUndefined();
    expect(calls.join(" ")).not.toContain("SECRET");
    const bad = createTelegramApi("123:SECRET", (async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), { status: 403 })) as unknown as typeof fetch);
    const err = await bad.sendMessage(1, "x").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.message).not.toContain("SECRET");
  });
});

describe("15 · mensagens inválidas", () => {
  it("sem texto, longa demais, comando desconhecido, frase sem sentido, grupo, outro bot", async () => {
    await send(msg(TG.joao, undefined));
    expect(lastText()).toMatch(/apenas mensagens de texto/);
    await send(msg(TG.joao, "a".repeat(1200)));
    expect(lastText()).toMatch(/muito longa/);
    await send(msg(TG.joao, "/voar"));
    expect(lastText()).toMatch(/Não conheço esse comando/);
    await send(msg(TG.joao, "blá blá blá"));
    expect(lastText()).toMatch(/Não entendi/);
    await send(msg(-100555, "/saldo", "group"));
    expect(lastText()).toMatch(/conversa privada/);
    t.tg.clear();
    await send({ message: { message_id: 1, from: { id: 777, is_bot: true }, chat: { id: 777, type: "private" }, date: 0, text: "/saldo" } });
    expect(t.tg.sent).toHaveLength(0);
    // update sem message/callback (ex.: edited_message) é aceito e ignorado
    const r = await send({ edited_message: { message_id: 1, chat: { id: TG.joao, type: "private" }, date: 0, text: "x" } });
    expect(r.status).toBe(200);
  });
});

describe("16 · valores com vírgula decimal", () => {
  it.each([
    ["gastei 45,90 na farmácia", 4590],
    ["paguei R$ 1.234,56 de aluguel", 123456],
    ["gastei 1234.56 no mercado", 123456],
    ["recebi 2,5 mil de bônus", 250000],
    ["gastei 0,99 de chiclete", 99],
  ])("“%s” → %i centavos", async (text, cents) => {
    await send(msg(TG.luis, text));
    await send(cb(TG.luis, button("Confirmar")));
    const rows = await txs(t.ids.luis);
    expect(rows[rows.length - 1].amount_cents).toBe(cents);
  });
});

describe("17 · datas e fuso horário (America/Sao_Paulo)", () => {
  it("23h30 de 14/11 em SP já é 15/11 em UTC — “hoje” continua sendo 14/11", async () => {
    setNow("2026-11-15T02:30:00Z");
    await send(msg(TG.luis, "gastei 10 hoje de pão"));
    expect(lastText()).toMatch(/Data: Hoje/);
    await send(cb(TG.luis, button("Confirmar")));
    await send(msg(TG.luis, "anteontem gastei 20 de gasolina"));
    await send(cb(TG.luis, button("Confirmar")));
    const rows = await txs(t.ids.luis);
    expect(rows.find((r) => r.amount_cents === 1000)?.date).toBe("2026-11-14");
    expect(rows.find((r) => r.amount_cents === 2000)?.date).toBe("2026-11-12");
  });

  it("“conta de luz de 200 para dia 5” vai para o próximo mês e fica pendente", async () => {
    await send(msg(TG.luis, "conta de luz de 200 para dia 5"));
    expect(lastText()).toMatch(/Conta a pagar: R\$ 200,00[\s\S]*Vencimento: 05\/12\/2026[\s\S]*A pagar/);
    await send(cb(TG.luis, button("Confirmar")));
    expect((await txs(t.ids.luis)).find((r) => r.amount_cents === 20000)).toMatchObject({ date: "2026-12-05", status: "pending" });
  });
});

describe("configurações e notificações", () => {
  it("/configuracoes alterna avisos", async () => {
    await send(msg(TG.joao, "/configuracoes"));
    expect(lastText()).toMatch(/Configurações[\s\S]*João/);
    const daily = button("Resumo diário");
    expect(daily).toBe("n:daily");
    await send(cb(TG.joao, daily));
    const { rows } = await t.db.query("SELECT notify_daily FROM users WHERE id = $1", [t.ids.joao]);
    expect(rows[0].notify_daily).toBe(true);
  });

  it("avisos de vencimento e atraso saem uma única vez, só para o dono", async () => {
    const lu = await t.as("luciana");
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 20000, description: "Condomínio", date: "2026-11-15", status: "pending" });
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 7000, description: "Gás", date: "2026-11-01", status: "pending" });
    t.tg.clear();
    await runScheduledJobs(t.ctx);
    await runScheduledJobs(t.ctx);
    const due = t.tg.sent.filter((s) => s.text?.includes("Contas a vencer") && s.chatId === TG.luciana);
    expect(due).toHaveLength(1);
    expect(t.tg.sent.filter((s) => s.text?.includes("Gás") && s.text?.includes("atrasada"))).toHaveLength(1);
    expect(t.tg.sent.every((s) => !s.text?.includes("Condomínio") || s.chatId === TG.luciana)).toBe(true);
  });

  it("não manda mensagens de madrugada", async () => {
    setNow("2026-11-14T05:00:00Z");
    await (await t.as("luciana")).post("/api/transactions").send({ kind: "expense", amountCents: 5000, description: "Água", date: "2026-11-14", status: "pending" });
    t.tg.clear();
    await runScheduledJobs(t.ctx);
    expect(t.tg.sent).toHaveLength(0);
  });

  it("endpoint de cron exige segredo", async () => {
    expect((await request(t.app).post("/api/cron/run")).status).toBe(401);
    expect((await request(t.app).post("/api/cron/run").set("authorization", `Bearer ${t.ctx.config.cronSecret}`)).status).toBe(200);
  });

  it("desvincular pelo bot pede confirmação e corta o acesso", async () => {
    await send(msg(TG.joao, "/desvincular"));
    await send(cb(TG.joao, button("Sim, desconectar")));
    t.tg.clear();
    await send(msg(TG.joao, "/saldo"));
    expect(texts()).toMatch(/conecte sua conta/i);
    expect(texts()).not.toMatch(/R\$/);
  });
});

describe("IA integrada ao bot (cliente simulado)", () => {
  it("frase que as regras não entendem vai para a IA; proposta vira cartão e só grava após confirmar", async () => {
    await linkAs("joao", TG.joao);
    const cat = (await t.db.query<{ id: number }>("SELECT id FROM categories WHERE name = 'Lazer'")).rows[0].id;
    t.ctx.ai = {
      async respond() {
        return {
          type: "proposal",
          intent: { type: "entry", draft: { kind: "expense", amountCents: 6000, description: "Boliche", categoryId: cat, date: "2026-11-14", status: "paid", installments: null, paymentMethod: null, accountId: null, amountText: "60" } },
        };
      },
    };
    await send(msg(TG.joao, "fui jogar boliche e deixei uns 60 lá"));
    expect(lastText()).toMatch(/Despesa: R\$ 60,00[\s\S]*Boliche[\s\S]*Lazer/);
    expect((await txs(t.ids.joao)).some((r) => r.amount_cents === 6000)).toBe(false);
    await send(cb(TG.joao, button("Confirmar")));
    expect((await txs(t.ids.joao)).filter((r) => r.amount_cents === 6000)).toHaveLength(1);

    t.ctx.ai = { async respond() { return { type: "text", text: "Seus gastos se concentram em lazer." }; } };
    await send(msg(TG.joao, "por que estou gastando tanto?"));
    expect(lastText()).toMatch(/concentram em lazer[\s\S]*gerada com IA/);

    t.ctx.ai = { async respond() { return { type: "none", reason: "erro" }; } };
    await send(msg(TG.joao, "zzz qwerty"));
    expect(lastText()).toMatch(/Não entendi/);
    t.ctx.ai = null;
  });
});
