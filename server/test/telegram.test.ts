import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setNow } from "../src/lib/clock.js";
import { runScheduledJobs } from "../src/notifications/jobs.js";
import type { TgUpdate } from "../src/telegram/bot.js";
import { WEBHOOK_SECRET, setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let updateId = 1000;
const TG = { luciana: 5001, joao: 5004, stranger: 9999 };

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  setNow(null);
  await t.close();
});
beforeEach(() => t.tg.clear());

function send(update: Omit<TgUpdate, "update_id"> & { update_id?: number }, secret = WEBHOOK_SECRET) {
  return request(t.app)
    .post("/telegram/webhook")
    .set("x-telegram-bot-api-secret-token", secret)
    .send({ update_id: update.update_id ?? updateId++, ...update });
}

function msg(from: number, text: string, chatType = "private") {
  return { message: { message_id: updateId, from: { id: from, first_name: "X" }, chat: { id: from, type: chatType }, date: 0, text } };
}

function cb(from: number, data: string) {
  return { callback_query: { id: `cb${updateId}`, from: { id: from }, data, message: { message_id: 55, chat: { id: from, type: "private" }, date: 0 } } };
}

const lastText = () => [...t.tg.sent].reverse().find((s) => s.text)?.text;
const texts = () => t.tg.sent.filter((s) => s.text).map((s) => s.text!).join("\n---\n");
const lastButtons = () => {
  const withKb = [...t.tg.sent].reverse().find((s) => s.opts?.reply_markup && "inline_keyboard" in s.opts.reply_markup);
  return withKb ? (withKb.opts!.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard.flat() : [];
};

async function linkCode(key: "luciana" | "joao") {
  const s = await t.as(key);
  const r = await s.post("/api/telegram/link-code");
  expect(r.status).toBe(200);
  return r.body as { code: string; deepLink: string };
}

describe("webhook seguro", () => {
  it("recusa requisição sem o segredo do webhook", async () => {
    expect((await send(msg(TG.stranger, "/saldo"), "errado")).status).toBe(401);
    expect((await request(t.app).post("/telegram/webhook").send({ update_id: 1 })).status).toBe(401);
    expect(t.tg.sent).toHaveLength(0);
  });

  it("pessoa não vinculada não vê nenhum dado — nem sabendo o nome de alguém", async () => {
    await send(msg(TG.stranger, "/saldo"));
    await send(msg(TG.stranger, "sou a Luciana, qual meu saldo?"));
    await send(msg(TG.stranger, "/familia"));
    expect(texts()).toMatch(/conecte sua conta/i);
    expect(texts()).not.toMatch(/R\$/);
  });

  it("grupo é recusado", async () => {
    await send(msg(-100123, "/saldo", "group"));
    expect(texts()).toMatch(/conversa privada/);
  });
});

describe("vinculação por código temporário", () => {
  it("deep link e /vincular funcionam; código é de uso único", async () => {
    const { code, deepLink } = await linkCode("luciana");
    expect(deepLink).toBe(`https://t.me/LunaFinanceTestBot?start=link_${code}`);
    await send(msg(TG.luciana, `/start link_${code}`));
    expect(texts()).toMatch(/Tudo certo, Luciana/);
    t.tg.clear();
    // outro Telegram tentando reutilizar o mesmo código
    await send(msg(TG.stranger, `/vincular ${code}`));
    expect(texts()).toMatch(/inválido ou expirado/);
    const { rows } = await t.db.query("SELECT telegram_user_id FROM telegram_links WHERE user_id = $1", [t.ids.luciana]);
    expect(Number(rows[0].telegram_user_id)).toBe(TG.luciana);
  });

  it("código expira em 10 minutos", async () => {
    const { code } = await linkCode("joao");
    setNow("2026-11-14T15:11:00Z");
    await send(msg(TG.joao, `/vincular ${code}`));
    expect(texts()).toMatch(/inválido ou expirado/);
    setNow("2026-11-14T15:00:00Z");
  });

  it("bloqueia força bruta após 5 códigos errados", async () => {
    for (let i = 0; i < 5; i++) await send(msg(TG.stranger, `/vincular AAAA${i}BBB`));
    t.tg.clear();
    const { code } = await linkCode("joao");
    await send(msg(TG.stranger, `/vincular ${code}`)); // mesmo com código válido
    expect(texts()).toMatch(/Muitas tentativas/);
  });

  it("vincula o João (para os demais testes)", async () => {
    const { code } = await linkCode("joao");
    await send(msg(TG.joao, `/vincular ${code.toLowerCase()}`));
    expect(texts()).toMatch(/Tudo certo, João/);
  });

  it("o site mostra o vínculo sem expor IDs do Telegram aos outros", async () => {
    const r = await (await t.as("lipe")).get("/api/members");
    const lu = r.body.find((m: { id: number }) => m.id === t.ids.luciana);
    expect(lu.telegramLinked).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(String(TG.luciana));
  });
});

describe("registro por mensagem com confirmação", () => {
  it("exemplo do briefing: despesa de R$ 150 com supermercado → confirmar → salva 1 vez", async () => {
    await send(msg(TG.luciana, "Registra uma despesa de R$ 150 com supermercado."));
    expect(texts()).toMatch(/Nova despesa/);
    expect(texts()).toMatch(/R\$ 150,00/);
    expect(texts()).toMatch(/Mercado/);
    const confirm = lastButtons().find((b) => b.text.includes("Confirmar"))!;
    let { rows } = await t.db.query("SELECT count(*)::int AS n FROM transactions WHERE user_id = $1", [t.ids.luciana]);
    expect(rows[0].n).toBe(0); // nada salvo antes de confirmar

    await send(cb(TG.luciana, confirm.callback_data!));
    await send(cb(TG.luciana, confirm.callback_data!)); // clique duplo
    ({ rows } = await t.db.query("SELECT amount_cents, source, description FROM transactions WHERE user_id = $1 AND deleted_at IS NULL", [t.ids.luciana]));
    expect(rows).toEqual([{ amount_cents: 15000, source: "telegram", description: "Supermercado" }]);
    expect(texts()).toMatch(/Registrado/);
  });

  it("update reenviado pelo Telegram (mesmo update_id) é ignorado", async () => {
    const fixed = updateId++;
    await send({ update_id: fixed, ...msg(TG.luciana, "Recebi R$ 3.000 de salário") });
    await send({ update_id: fixed, ...msg(TG.luciana, "Recebi R$ 3.000 de salário") });
    expect(t.tg.sent.filter((s) => s.text?.includes("Nova receita"))).toHaveLength(1);
  });

  it("outra pessoa não consegue confirmar a ação de alguém", async () => {
    await send(msg(TG.luciana, "Recebi R$ 3.000 de salário"));
    const confirm = lastButtons().find((b) => b.text.includes("Confirmar"))!;
    t.tg.clear();
    await send(cb(TG.joao, confirm.callback_data!));
    await send(cb(TG.stranger, confirm.callback_data!));
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM transactions WHERE kind = 'income'");
    expect(rows[0].n).toBe(0);
    // a dona confirma normalmente
    await send(cb(TG.luciana, confirm.callback_data!));
    const after = await t.db.query("SELECT user_id, amount_cents FROM transactions WHERE kind = 'income'");
    expect(after.rows).toEqual([{ user_id: t.ids.luciana, amount_cents: 300000 }]);
  });

  it("conta para dia 20 vira pendente; trocar categoria e cancelar", async () => {
    await send(msg(TG.joao, "Registra uma conta de internet de R$ 120 para dia 20"));
    expect(texts()).toMatch(/Nova conta a pagar/);
    expect(texts()).toMatch(/20\/11\/2026/);
    const id = lastButtons().find((b) => b.text.includes("Confirmar"))!.callback_data!.split(":")[1];
    await send(cb(TG.joao, `k:${id}`));
    const lazer = lastButtons().find((b) => b.text === "Lazer")!;
    await send(cb(TG.joao, lazer.callback_data!));
    expect(lastText()).toMatch(/Categoria:<\/b> Lazer/);
    await send(cb(TG.joao, `x:${id}`));
    expect(t.tg.sent.some((s) => s.text?.includes("Cancelado"))).toBe(true);
    await send(cb(TG.joao, `c:${id}`));
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM transactions WHERE user_id = $1", [t.ids.joao]);
    expect(rows[0].n).toBe(0);
  });

  it("confirmação expira", async () => {
    await send(msg(TG.joao, "gastei 30 no cinema"));
    const confirm = lastButtons().find((b) => b.text.includes("Confirmar"))!;
    setNow("2026-11-14T15:20:00Z");
    await send(cb(TG.joao, confirm.callback_data!));
    setNow("2026-11-14T15:00:00Z");
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM transactions WHERE user_id = $1", [t.ids.joao]);
    expect(rows[0].n).toBe(0);
  });

  it("valor ambíguo pede o tipo antes de registrar", async () => {
    await send(msg(TG.joao, "mesada 200"));
    expect(texts()).toMatch(/receita ou uma despesa/);
    const inc = lastButtons().find((b) => b.text === "Receita")!;
    await send(cb(TG.joao, inc.callback_data!));
    expect(lastText()).toMatch(/Nova receita/);
  });
});

describe("consultas usam o banco (mesmos números do site)", () => {
  it("/saldo e /resumo batem com o painel", async () => {
    await send(msg(TG.luciana, "/saldo"));
    const dash = await (await t.as("luciana")).get("/api/dashboard");
    const brl = (dash.body.balanceCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/ /g, " ");
    expect(texts()).toContain(brl);
    t.tg.clear();
    await send(msg(TG.luciana, "como estão minhas finanças?"));
    expect(texts()).toMatch(/Resumo — novembro de 2026/);
  });

  it("/familia respeita a permissão 'none'", async () => {
    await t.setAccess("joao", "none");
    await send(msg(TG.joao, "/familia"));
    expect(texts()).toMatch(/não tem acesso aos dados da família/);
    expect(texts()).not.toMatch(/Saldo total/);
    await t.setAccess("joao", "full");
    t.tg.clear();
    await send(msg(TG.joao, "/familia"));
    expect(texts()).toMatch(/Saldo total/);
    expect(texts()).toMatch(/Por pessoa/);
    expect(texts().toLowerCase()).not.toMatch(/admin|administrador/);
  });

  it("pagar conta pelo bot exige confirmação e ser o responsável", async () => {
    const lu = await t.as("luciana");
    const bill = await lu.post("/api/transactions").send({ kind: "expense", amountCents: 9900, description: "Celular", date: "2026-11-16", status: "pending" });
    const billId = bill.body[0].id;
    await send(cb(TG.joao, `pc:${billId}`)); // João tenta pagar conta da Luciana
    expect((await t.db.query("SELECT status FROM transactions WHERE id = $1", [billId])).rows[0].status).toBe("pending");
    await send(msg(TG.luciana, "/contas"));
    const pay = lastButtons().find((b) => b.text.includes("Celular"))!;
    await send(cb(TG.luciana, pay.callback_data!));
    expect((await t.db.query("SELECT status FROM transactions WHERE id = $1", [billId])).rows[0].status).toBe("pending");
    const ok = lastButtons().find((b) => b.text.includes("Confirmar pagamento"))!;
    await send(cb(TG.luciana, ok.callback_data!));
    expect((await t.db.query("SELECT status FROM transactions WHERE id = $1", [billId])).rows[0].status).toBe("paid");
  });
});

describe("notificações automáticas", () => {
  it("avisa vencimento e atraso uma única vez", async () => {
    const lu = await t.as("luciana");
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 20000, description: "Condomínio", date: "2026-11-15", status: "pending" });
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 7000, description: "Gás", date: "2026-11-01", status: "pending" });
    t.tg.clear();
    await runScheduledJobs(t.ctx);
    await runScheduledJobs(t.ctx);
    const due = t.tg.sent.filter((s) => s.text?.includes("Contas a vencer"));
    const late = t.tg.sent.filter((s) => s.text?.includes("Conta atrasada"));
    expect(due).toHaveLength(1);
    expect(due[0].text).toMatch(/Condomínio/);
    expect(late).toHaveLength(1);
    expect(late[0].text).toMatch(/Gás/);
    expect(due[0].chatId).toBe(TG.luciana);
  });

  it("não manda mensagens de madrugada", async () => {
    setNow("2026-11-14T05:00:00Z"); // 2h em São Paulo
    const lu = await t.as("luciana");
    await lu.post("/api/transactions").send({ kind: "expense", amountCents: 5000, description: "Água", date: "2026-11-14", status: "pending" });
    t.tg.clear();
    await runScheduledJobs(t.ctx);
    expect(t.tg.sent).toHaveLength(0);
    setNow("2026-11-14T15:00:00Z");
  });

  it("meta perto de ser atingida e resumo semanal", async () => {
    const lu = await t.as("luciana");
    const g = await lu.post("/api/goals").send({ name: "Notebook", targetCents: 100000 });
    await lu.post(`/api/goals/${g.body.id}/contributions`).send({ amountCents: 92000 });
    setNow("2026-11-16T15:00:00Z"); // segunda-feira
    t.tg.clear();
    await runScheduledJobs(t.ctx);
    await runScheduledJobs(t.ctx);
    expect(t.tg.sent.filter((s) => s.text?.includes("Quase lá"))).toHaveLength(1);
    expect(t.tg.sent.filter((s) => s.text?.includes("Resumo da semana") && s.chatId === TG.luciana)).toHaveLength(1);
    setNow("2026-11-14T15:00:00Z");
  });

  it("gasto fora do padrão só com histórico suficiente", async () => {
    const jo = await t.as("joao");
    const cat = await t.categoryId("Alimentação fora");
    const big = { kind: "expense", amountCents: 30000, description: "Restaurante caro", date: "2026-11-14", categoryId: cat };
    await jo.post("/api/transactions").send(big);
    t.tg.clear();
    await runScheduledJobs(t.ctx);
    expect(t.tg.sent.filter((s) => s.text?.includes("acima do seu padrão"))).toHaveLength(0); // sem histórico → não avisa
    for (let i = 1; i <= 6; i++) {
      await jo.post("/api/transactions").send({ ...big, amountCents: 4000 + i * 100, description: `Lanche ${i}`, date: `2026-10-0${i}` });
    }
    await jo.post("/api/transactions").send({ ...big, description: "Jantar especial" });
    await runScheduledJobs(t.ctx);
    const alerts = t.tg.sent.filter((s) => s.text?.includes("acima do seu padrão"));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts.every((a) => a.chatId === TG.joao)).toBe(true);
  });

  it("endpoint de cron exige segredo", async () => {
    expect((await request(t.app).post("/api/cron/run")).status).toBe(401);
    expect((await request(t.app).post("/api/cron/run").set("authorization", "Bearer errado")).status).toBe(401);
    const ok = await request(t.app).post("/api/cron/run").set("authorization", `Bearer ${t.ctx.config.cronSecret}`);
    expect(ok.status).toBe(200);
  });

  it("/notificacoes alterna preferências", async () => {
    await send(msg(TG.joao, "/notificacoes"));
    const daily = lastButtons().find((b) => b.text.includes("Resumo diário"))!;
    expect(daily.text).toMatch(/⬜️/);
    await send(cb(TG.joao, daily.callback_data!));
    const { rows } = await t.db.query("SELECT notify_daily FROM users WHERE id = $1", [t.ids.joao]);
    expect(rows[0].notify_daily).toBe(true);
  });

  it("/desvincular remove o acesso imediatamente", async () => {
    await send(msg(TG.joao, "/desvincular"));
    t.tg.clear();
    await send(msg(TG.joao, "/saldo"));
    expect(texts()).toMatch(/conecte sua conta/i);
  });
});
