/**
 * Identificação de intenção (determinística). Decide se a mensagem é um
 * lançamento, uma consulta, uma ação de meta ou algo não reconhecido.
 * Consultas carregam um período resolvido no fuso da família.
 */
import { addDays, monthRange, shiftMonth } from "../lib/clock.js";
import { parseMoneyToCents } from "../lib/money.js";
import {
  findAmount, findDate, normalize, parseEntry, type AccountLite, type CategoryLite, type Draft, type EntryParse,
} from "./parser.js";

export interface Period {
  from: string;
  to: string;
  label: string;
}

export type Query =
  | { q: "balance" }
  | { q: "family" }
  | { q: "spend"; kind: "income" | "expense"; period: Period; categoryId: number | null }
  | { q: "last"; kind: "income" | "expense"; limit: number }
  | { q: "compare"; ym: string }
  | { q: "bills" }
  | { q: "upcoming" }
  | { q: "goals" }
  | { q: "goal"; goalId: number }
  | { q: "summary"; period: Period }
  | { q: "by_category"; period: Period }
  | { q: "top"; period: Period }
  | { q: "evolution" }
  | { q: "flow" };

export interface GoalLite {
  id: number;
  name: string;
}

export type Intent =
  | { type: "entry"; draft: Draft }
  | { type: "incomplete"; missing: Array<"amount" | "kind">; partial: Partial<Draft> }
  | { type: "query"; query: Query }
  | { type: "goal_create"; name: string; targetCents: number | null; deadline: string | null }
  | { type: "goal_contribute"; goalId: number | null; goalText: string; amountCents: number | null; withdraw: boolean }
  | { type: "unknown" };

export interface NluContext {
  categories: CategoryLite[];
  accounts: AccountLite[];
  goals: GoalLite[];
  today: string;
}

const MONTHS = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function monthPeriod(ym: string): Period {
  const { start, end } = monthRange(ym);
  const [y, m] = ym.split("-").map(Number);
  return { from: start, to: end, label: `${MONTHS[m - 1].replace("marco", "março")} de ${y}` };
}

/** Período citado na frase; padrão = mês atual. */
export function detectPeriod(n: string, today: string): Period {
  const ym = today.slice(0, 7);
  if (/\bhoje\b|\bdo dia\b|\bdiari[oa]\b/.test(n)) return { from: today, to: today, label: "hoje" };
  if (/\bontem\b/.test(n)) {
    const y = addDays(today, -1);
    return { from: y, to: y, label: "ontem" };
  }
  if (/\bsemana passada\b/.test(n)) return { from: addDays(today, -13), to: addDays(today, -7), label: "semana passada" };
  if (/\bsemana\b|\bsemanal\b|\b7 dias\b/.test(n)) return { from: addDays(today, -6), to: today, label: "últimos 7 dias" };
  if (/\bmes passado\b|\bmes anterior\b|\bultimo mes\b/.test(n)) return monthPeriod(shiftMonth(ym, -1));
  if (/\b(este|esse|neste|nesse|deste|desse) ano\b|\bno ano\b|\banual\b/.test(n)) {
    return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31`, label: `em ${today.slice(0, 4)}` };
  }
  const m = n.match(/\b(?:em|de|no mes de)\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(\d{4}))?\b/);
  if (m) {
    const idx = MONTHS.indexOf(m[1]) + 1;
    let year = m[2] ? Number(m[2]) : Number(today.slice(0, 4));
    if (!m[2] && `${year}-${String(idx).padStart(2, "0")}` > ym) year -= 1; // "em dezembro" em novembro = ano passado
    return monthPeriod(`${year}-${String(idx).padStart(2, "0")}`);
  }
  return monthPeriod(ym);
}

/** Categoria citada numa PERGUNTA ("quanto gastei com alimentação?"). */
export function findCategoryInQuery(n: string, categories: CategoryLite[], kind: "income" | "expense"): CategoryLite | null {
  let best: { c: CategoryLite; score: number } | null = null;
  for (const c of categories) {
    if (c.kind !== kind) continue;
    const name = normalize(c.name);
    let score = 0;
    if (new RegExp(`\\b${name}\\b`).test(n)) score = 100 + name.length;
    else {
      for (const tok of name.split(" ").filter((t) => t.length >= 4 && !["outras", "outros", "fora", "casa"].includes(t))) {
        if (new RegExp(`\\b${tok}`).test(n)) score = Math.max(score, 50 + tok.length);
      }
      for (const kw of c.keywords.split(",").map((k) => normalize(k)).filter((k) => k.length >= 3)) {
        if (new RegExp(`\\b${kw}\\b`).test(n)) score = Math.max(score, 10 + kw.length);
      }
    }
    if (score && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}

/** Meta mais parecida com o texto (sobreposição de palavras). */
export function findGoal(text: string, goals: GoalLite[]): GoalLite | null {
  const stop = new Set(["meta", "metas", "minha", "meu", "de", "da", "do", "para", "pra", "a", "o", "um", "uma", "comprar", "como", "esta", "esta?", "na", "no"]);
  const words = normalize(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w));
  let best: { g: GoalLite; score: number } | null = null;
  for (const g of goals) {
    const gw = normalize(g.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w));
    const score = words.filter((w) => gw.some((x) => x === w || x.startsWith(w) || w.startsWith(x))).length;
    if (score && (!best || score > best.score)) best = { g, score };
  }
  return best?.g ?? null;
}

function isQuestion(n: string) {
  return /\?$/.test(n) || /^(qual|quais|quanto|quantos|quanta|como|tenho|o que|oque|mostra|mostrar|ver|me (mostra|diz|fala|passa)|lista|listar|compar|resumo|relatorio)/.test(n);
}

export function detectQuery(n: string, ctx: NluContext): Query | null {
  const hasAmount = /\d/.test(n.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "").replace(/\b(19|20)\d{2}\b/g, "").replace(/\b\d+ dias\b/g, ""));
  if (hasAmount && !isQuestion(n)) return null; // provavelmente um lançamento

  const period = detectPeriod(n, ctx.today);
  // família
  if (/\b(familia|familiar|da casa|de todos)\b/.test(n) && /\b(saldo|resumo|gast|receit|despes|situacao|financas|quanto)/.test(n)) return { q: "family" };
  // metas
  if (/\bmetas?\b|\bobjetivos?\b/.test(n)) {
    const g = /\bmeta (de|do|da|para|pra)\b|\bminha meta\b/.test(n) ? findGoal(n, ctx.goals) : null;
    return g ? { q: "goal", goalId: g.id } : { q: "goals" };
  }
  if (/\bcompar/.test(n)) return { q: "compare", ym: ctx.today.slice(0, 7) };
  if (/\bevolucao\b|\bhistorico do saldo\b|\bpatrimonio\b/.test(n)) return { q: "evolution" };
  if (/\breceitas? (x|vs|versus|e|contra) despesas?\b|\bentradas? (e|x|vs) saidas?\b|\bfluxo\b/.test(n)) return { q: "flow" };
  if (/\bmaior(es)? (gastos?|despesas?|compras?)\b|\bonde mais gastei\b|\bcom o que mais gastei\b/.test(n)) return { q: "top", period };
  if (/\bpor categoria\b|\bcategorias\b/.test(n)) return { q: "by_category", period };
  if (/\b(proxim[oa]s?|vai vencer|vencem|vencimentos?)\b/.test(n)) return { q: "upcoming" };
  if (/\b(contas?|boletos?)\b.*\b(pendentes?|atrasad[oa]s?|abert[oa]s?|a pagar|pagar)\b|\b(o que|oque) (eu )?(tenho|falta) (pra|para|a) pagar\b|\batrasad/.test(n)) return { q: "bills" };
  if (/\bultim[oa]s?\b|\brecentes?\b/.test(n)) {
    if (/\b(receitas?|recebimentos?|entradas?|recebi)\b/.test(n)) return { q: "last", kind: "income", limit: 10 };
    if (/\b(despesas?|gastos?|compras?|movimentac|lancamentos?|gastei)\b/.test(n)) return { q: "last", kind: "expense", limit: 10 };
  }
  if (/\b(saldo|quanto (eu )?tenho|disponivel|tenho de dinheiro)\b/.test(n)) return { q: "balance" };
  if (/\b(situacao|como (estao|esta|tao|ta) (as |minhas |meu )?(financas|contas|dinheiro|orcamento)|balanco)\b/.test(n)) return { q: "summary", period };
  if (/\bresumo\b|\brelatorio\b/.test(n)) return { q: "summary", period };
  const spendIncome = /\b(recebi|receitas?|ganhei|entrou|entraram)\b/.test(n);
  const spendExpense = /\b(gastei|gastos?|despesas?|paguei|gastamos)\b/.test(n);
  if ((spendIncome || spendExpense) && isQuestion(n)) {
    const kind = spendExpense ? "expense" : "income";
    const cat = /\b(com|em|de|no|na)\b/.test(n) ? findCategoryInQuery(n, ctx.categories, kind) : null;
    return { q: "spend", kind, period, categoryId: cat?.id ?? null };
  }
  return null;
}

function detectGoalAction(text: string, n: string, ctx: NluContext): Intent | null {
  // criar meta: "criar meta de 50 mil para comprar um carro até 12/2027"
  const create = n.match(/^(?:criar?|crie|nova|adicionar?|cadastrar?)\s+(?:uma\s+)?meta\b(.*)$/);
  if (create) {
    const rest = create[1];
    const amount = findAmount(rest, []);
    const deadlineMatch = rest.match(/\bate\s+(\d{1,2}\/\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
    let deadline: string | null = null;
    if (deadlineMatch) {
      const parts = deadlineMatch[1].split("/").map(Number);
      if (parts.length === 2) deadline = monthRange(`${parts[1]}-${String(parts[0]).padStart(2, "0")}`).end;
      else deadline = findDate(deadlineMatch[1], ctx.today, true).date;
    }
    let name = rest
      .replace(deadlineMatch?.[0] ?? "", " ")
      .replace(amount ? amount.text : "", " ")
      .replace(/\b(de|para|pra|com valor de|no valor de|valor)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // reaproveita a grafia original quando possível
    const idx = normalize(text).indexOf(name);
    if (name && idx >= 0) name = text.trim().slice(idx, idx + name.length);
    return { type: "goal_create", name: name ? name.charAt(0).toUpperCase() + name.slice(1) : "", targetCents: amount?.cents ?? null, deadline };
  }
  // contribuir: "guardei 500 na meta viagem", "tirei 200 da reserva"
  const contrib = n.match(/\b(guardei|guarda|depositei|coloquei|juntei|poupei|separei|adicionei|aportei|tirei|retirei|saquei|usei)\b/);
  if (contrib && (/\bmeta\b/.test(n) || findGoal(n, ctx.goals))) {
    const withdraw = /\b(tirei|retirei|saquei|usei)\b/.test(n);
    const amount = findAmount(n, []);
    const goal = findGoal(n.replace(contrib[0], ""), ctx.goals);
    return { type: "goal_contribute", goalId: goal?.id ?? null, goalText: n, amountCents: amount?.cents ?? null, withdraw };
  }
  return null;
}

export function interpret(text: string, ctx: NluContext): Intent {
  const original = text.trim().slice(0, 500);
  const n = normalize(original);
  if (!n) return { type: "unknown" };
  const goal = detectGoalAction(original, n, ctx);
  if (goal) return goal;
  const query = detectQuery(n, ctx);
  if (query) return { type: "query", query };
  const entry: EntryParse = parseEntry(original, ctx.categories, ctx.today, ctx.accounts);
  return entry;
}

/** Valor isolado digitado numa resposta ("45,90", "R$ 1.200"). */
export function parseAmountReply(text: string): number | null {
  const n = normalize(text).replace(/\b(reais|real)\b/, "").trim();
  return parseMoneyToCents(n);
}
