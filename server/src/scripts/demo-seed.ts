/**
 * Popula um banco VAZIO com dados fictícios para demonstração/desenvolvimento.
 *   npm run demo:seed
 * Recusa rodar em produção ou se já houver pessoas cadastradas.
 * Senhas da demonstração: DemoLuna2026 (Luciana, Luís Carlos, João) e teste123 (Lipe, lipe@demo).
 * A senha do Lipe é curta só para a demo local: o site exige 10+ caracteres ao trocar senha.
 */
import { addMonths, currentMonth, makeDate, shiftMonth, today } from "../lib/clock.js";
import { hashPassword } from "../lib/crypto.js";
import { MEMBER_PALETTE } from "../services/members.js";
import { withContext } from "./_cli.js";

if (process.env.NODE_ENV === "production") throw new Error("demo:seed não roda em produção.");

await withContext(async (ctx) => {
  const db = ctx.db;
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) throw new Error("O banco já tem pessoas cadastradas. Use um banco vazio para a demonstração.");

  const hash = await hashPassword("DemoLuna2026");
  const people = [
    { key: "luciana", name: "Luciana", email: "luciana@demo.luna", role: "member", password: "DemoLuna2026" },
    { key: "luis", name: "Luís Carlos", email: "luis@demo.luna", role: "member", password: "DemoLuna2026" },
    { key: "lipe", name: "Lipe", email: "lipe@demo", role: "admin", password: "teste123" },
    { key: "joao", name: "João", email: "joao@demo.luna", role: "member", password: "DemoLuna2026" },
  ];
  const ids: Record<string, number> = {};
  const acc: Record<string, number> = {};
  for (const [i, p] of people.entries()) {
    const u = await db.query<{ id: number }>(
      "INSERT INTO users (name, email, password_hash, role, color) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [p.name, p.email, p.password === "DemoLuna2026" ? hash : await hashPassword(p.password), p.role, MEMBER_PALETTE[i]],
    );
    ids[p.key] = u.rows[0].id;
    const a = await db.query<{ id: number }>(
      "INSERT INTO accounts (owner_id, name, type, is_default, initial_balance_cents) VALUES ($1,'Conta principal','checking',TRUE,$2) RETURNING id",
      [u.rows[0].id, [420000, 680000, 95000, 30000][i]],
    );
    acc[p.key] = a.rows[0].id;
  }
  const cats = new Map((await db.query<{ id: number; name: string }>("SELECT id, name FROM categories")).rows.map((r) => [r.name, r.id]));
  const t = today();
  const cm = currentMonth();

  async function tx(who: string, kind: string, cents: number, description: string, date: string, category: string, extra: { status?: string; nature?: string; recurrence?: number } = {}) {
    const status = extra.status ?? (date <= t ? "paid" : "pending");
    await db.query(
      `INSERT INTO transactions (user_id, account_id, category_id, kind, amount_cents, description, date, status, paid_at, nature, recurrence_id, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$1)`,
      [ids[who], acc[who], cats.get(category) ?? null, kind, cents, description, date, status, status === "paid" ? date : null, extra.nature ?? "variable", extra.recurrence ?? null, extra.recurrence ? "recurrence" : "web"],
    );
  }

  // recorrências (geradas pelo próprio motor)
  async function recurrence(who: string, kind: string, cents: number, description: string, day: number, category: string, autoPaid: boolean, startMonthsAgo = 5) {
    const start = makeDate(Number(cm.slice(0, 4)), Number(cm.slice(5, 7)) - startMonthsAgo, day);
    const r = await db.query<{ id: number }>(
      `INSERT INTO recurrences (user_id, account_id, category_id, kind, amount_cents, description, nature, day_of_month, start_date, auto_paid, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'fixed',$7,$8,$9,$1) RETURNING id`,
      [ids[who], acc[who], cats.get(category) ?? null, kind, cents, description, day, start, autoPaid],
    );
    return r.rows[0].id;
  }
  await recurrence("luciana", "income", 780000, "Salário", 5, "Salário", true);
  await recurrence("luis", "income", 920000, "Salário", 5, "Salário", true);
  await recurrence("lipe", "income", 240000, "Estágio", 10, "Salário", true);
  await recurrence("joao", "income", 40000, "Mesada", 1, "Outras receitas", true);
  await recurrence("luis", "expense", 280000, "Aluguel", 10, "Moradia", true);
  await recurrence("luciana", "expense", 12990, "Internet", 20, "Contas da casa", false);
  await recurrence("luciana", "expense", 89000, "Plano de saúde", 15, "Saúde", false);
  await recurrence("lipe", "expense", 3990, "Spotify", 12, "Assinaturas", true);
  await recurrence("lipe", "expense", 189000, "Mensalidade FIAP", 8, "Educação", false);
  const { generateAllRecurrences } = await import("../services/transactions.js");
  await generateAllRecurrences(db);
  // as recorrências não automáticas dos meses passados ficam pagas
  await db.query("UPDATE transactions SET status = 'paid', paid_at = date WHERE status = 'pending' AND date < $1", [makeDate(Number(cm.slice(0, 4)), Number(cm.slice(5, 7)), 1)]);

  // gastos variáveis dos últimos 6 meses
  const rand = mulberry32(42);
  const variable: Array<[string, string, string, number, number]> = [
    ["luciana", "Mercado", "Supermercado", 38000, 72000],
    ["luciana", "Mercado", "Feira", 6000, 14000],
    ["luis", "Transporte", "Combustível", 22000, 36000],
    ["luis", "Alimentação fora", "Restaurante", 9000, 26000],
    ["lipe", "Transporte", "Uber", 1800, 4500],
    ["lipe", "Alimentação fora", "iFood", 3500, 7800],
    ["joao", "Lazer", "Cinema", 3000, 6000],
    ["joao", "Alimentação fora", "Lanche", 1500, 4000],
    ["luciana", "Contas da casa", "Conta de luz", 21000, 32000],
    ["luis", "Saúde", "Farmácia", 4000, 15000],
  ];
  for (let m = 5; m >= 0; m--) {
    const ym = shiftMonth(cm, -m);
    for (const [who, cat, desc, min, max] of variable) {
      const times = cat === "Transporte" || cat === "Alimentação fora" ? 3 : 1;
      for (let k = 0; k < times; k++) {
        const day = 1 + Math.floor(rand() * 27);
        const date = makeDate(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), day);
        if (date > t) continue;
        await tx(who, "expense", Math.round((min + rand() * (max - min)) / 10) * 10, desc, date, cat);
      }
    }
  }
  // contas a pagar: uma atrasada e algumas a vencer
  await tx("luciana", "expense", 31540, "Conta de luz", addMonths(t, 0, Math.max(1, Number(t.slice(8)) - 3)), "Contas da casa", { status: "pending" });
  await tx("luis", "expense", 98000, "IPVA (parcela)", makeDate(Number(cm.slice(0, 4)), Number(cm.slice(5, 7)), 28), "Impostos e taxas", { status: "pending" });
  await tx("lipe", "income", 120000, "Projeto freelance", makeDate(Number(cm.slice(0, 4)), Number(cm.slice(5, 7)), 2), "Freelance");

  // metas
  const g1 = await db.query<{ id: number }>("INSERT INTO goals (scope, owner_id, name, target_cents, deadline, color) VALUES ('family',$1,'Reserva de emergência',3000000,$2,'#a87a32') RETURNING id", [ids.luciana, addMonths(t, 10)]);
  const g2 = await db.query<{ id: number }>("INSERT INTO goals (scope, owner_id, name, target_cents, deadline, color) VALUES ('family',$1,'Viagem de fim de ano',1200000,$2,'#2a78d6') RETURNING id", [ids.luis, addMonths(t, 2)]);
  const g3 = await db.query<{ id: number }>("INSERT INTO goals (scope, owner_id, name, target_cents, color) VALUES ('individual',$1,'Notebook novo',650000,'#6250d6') RETURNING id", [ids.lipe]);
  const contrib = async (g: number, who: string, cents: number, monthsAgo: number) =>
    db.query("INSERT INTO goal_contributions (goal_id, user_id, amount_cents, date) VALUES ($1,$2,$3,$4)", [g, ids[who], cents, addMonths(t, -monthsAgo)]);
  for (let m = 5; m >= 0; m--) {
    await contrib(g1.rows[0].id, "luciana", 150000, m);
    await contrib(g1.rows[0].id, "luis", 200000, m);
  }
  await contrib(g2.rows[0].id, "luis", 600000, 3);
  await contrib(g2.rows[0].id, "luciana", 300000, 1);
  await contrib(g2.rows[0].id, "lipe", 100000, 0);
  await contrib(g3.rows[0].id, "lipe", 410000, 2);

  console.log("Demonstração criada. Logins:");
  for (const p of people) console.log(`  ${p.name.padEnd(12)} ${p.email.padEnd(20)} senha ${p.password}`);
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
