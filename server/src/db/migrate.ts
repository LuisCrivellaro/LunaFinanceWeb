import type { Db } from "./index.js";
import { migrations } from "./migrations.js";

export async function migrate(db: Db, log = (m: string) => console.log(m)) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ id: number }>("SELECT id FROM schema_migrations");
  const done = new Set(rows.map((r) => r.id));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.tx(async (q) => {
      await q.exec(m.sql);
      await q.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
    });
    log(`[db] migração ${m.id}_${m.name} aplicada`);
  }
  await seedDefaultCategories(db);
}

export const DEFAULT_CATEGORIES: Array<{
  name: string;
  kind: "income" | "expense";
  icon: string;
  color: string;
  keywords: string;
}> = [
  { name: "Salário", kind: "income", icon: "briefcase", color: "#2F8F6B", keywords: "salario, salário, pagamento, holerite, contracheque" },
  { name: "Freelance", kind: "income", icon: "laptop", color: "#3E7CB1", keywords: "freela, freelance, projeto, servico, serviço, bico, trabalho, job" },
  { name: "Investimentos", kind: "income", icon: "trending-up", color: "#6A5ACD", keywords: "rendimento, dividendo, juros, cdb, tesouro" },
  { name: "Outras receitas", kind: "income", icon: "plus-circle", color: "#7C8A96", keywords: "presente, reembolso, venda, pix recebido" },
  { name: "Mercado", kind: "expense", icon: "shopping-cart", color: "#C9772B", keywords: "mercado, supermercado, feira, hortifruti, açougue, acougue, padaria, compras" },
  { name: "Moradia", kind: "expense", icon: "home", color: "#8C5A3C", keywords: "aluguel, condominio, condomínio, iptu, reforma" },
  { name: "Contas da casa", kind: "expense", icon: "zap", color: "#B8932E", keywords: "luz, energia, agua, água, gas, gás, internet, telefone, celular, enel, sabesp, comgas, vivo, claro, tim" },
  { name: "Transporte", kind: "expense", icon: "car", color: "#4C6A92", keywords: "uber, 99, gasolina, combustivel, combustível, estacionamento, pedagio, pedágio, onibus, ônibus, metro, metrô" },
  { name: "Alimentação fora", kind: "expense", icon: "utensils", color: "#C2553A", keywords: "restaurante, ifood, lanche, almoço, almoco, jantar, pizza, delivery, cafe, café" },
  { name: "Saúde", kind: "expense", icon: "heart-pulse", color: "#B5435A", keywords: "farmacia, farmácia, remedio, remédio, medico, médico, consulta, exame, plano de saude, plano de saúde, dentista" },
  { name: "Educação", kind: "expense", icon: "graduation-cap", color: "#3F7F8C", keywords: "faculdade, escola, curso, livro, mensalidade, fiap, material" },
  { name: "Lazer", kind: "expense", icon: "sparkles", color: "#8A58A6", keywords: "cinema, show, viagem, passeio, bar, jogo, ingresso" },
  { name: "Assinaturas", kind: "expense", icon: "repeat", color: "#5A6FB0", keywords: "netflix, spotify, assinatura, streaming, amazon prime, disney, youtube, icloud" },
  { name: "Compras", kind: "expense", icon: "shopping-bag", color: "#A0607A", keywords: "roupa, loja, shopping, presente, eletronico, eletrônico, camiseta, camisa, calça, tênis, tenis, sapato, blusa, vestido" },
  { name: "Pets", kind: "expense", icon: "paw-print", color: "#9A7B4F", keywords: "pet, ração, racao, veterinario, veterinário, banho e tosa" },
  { name: "Impostos e taxas", kind: "expense", icon: "landmark", color: "#6E6E73", keywords: "imposto, taxa, ipva, multa, tarifa, anuidade" },
  { name: "Outras despesas", kind: "expense", icon: "circle-dashed", color: "#8A8F98", keywords: "" },
];

async function seedDefaultCategories(db: Db) {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM categories");
  if (rows[0].n > 0) return;
  for (const c of DEFAULT_CATEGORIES) {
    await db.query(
      `INSERT INTO categories (name, kind, icon, color, keywords, is_default) VALUES ($1,$2,$3,$4,$5,TRUE)`,
      [c.name, c.kind, c.icon, c.color, c.keywords],
    );
  }
}
