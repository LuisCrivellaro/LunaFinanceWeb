/**
 * Interpretador determinístico de mensagens em português.
 * Extrai: tipo (receita/despesa), valor, descrição, categoria, data, situação
 * e parcelas. Não depende de IA — a IA (opcional) só entra quando as regras
 * não conseguem entender a frase, e mesmo assim passa pela mesma validação.
 */
import { addDays, addMonths, isIsoDate, makeDate } from "../lib/clock.js";
import { parseMoneyToCents } from "../lib/money.js";

export interface CategoryLite {
  id: number;
  name: string;
  kind: "income" | "expense";
  keywords: string;
}

export interface Draft {
  kind: "income" | "expense";
  amountCents: number;
  description: string;
  categoryId: number | null;
  date: string;
  status: "paid" | "pending";
  installments: number | null;
  /** Trecho exato do valor como foi escrito — para o usuário conferir. */
  amountText: string;
}

export type Intent =
  | { type: "entry"; draft: Draft }
  | { type: "incomplete"; missing: Array<"amount" | "kind">; partial: Partial<Draft> }
  | { type: "query"; query: QueryIntent }
  | { type: "unknown" };

export type QueryIntent = "balance" | "family" | "income" | "expenses" | "bills" | "upcoming" | "goals" | "summary";

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const INCOME_WORDS = /\b(recebi|receber|ganhei|ganho|entrou|entrada|caiu|receita|salario|vendi|reembolso|reembolsaram|depositaram|me pagaram|pix recebido|rendeu|rendimento)\b/;
const EXPENSE_WORDS = /\b(gastei|gasto|paguei|pagar|pago|despesa|comprei|compra|conta|boleto|fatura|debito|mensalidade|parcela|assinatura|saiu)\b/;
const PENDING_WORDS = /\b(vence|vencimento|vencendo|a pagar|pagar|para (o )?dia|pra (o )?dia|ate (o )?dia|boleto|agendar|agendado|vai vencer|lembrar)\b/;
const PAID_WORDS = /\b(paguei|gastei|comprei|recebi|ganhei|entrou|caiu|pago|ja paguei)\b/;

const MONEY_RE =
  /(r\$\s*\d[\d.,]*(?:\s*(?:mil|k)\b)?|\d[\d.,]*\s*(?:mil|k)\b|\d[\d.,]*\s*(?:reais|real|conto|contos|pila)\b|\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/gi;

interface Span {
  start: number;
  end: number;
}

function findDate(n: string, today: string, pendingHint: boolean): { date: string | null; spans: Span[]; explicitFuture: boolean } {
  const spans: Span[] = [];
  let date: string | null = null;
  let explicitFuture = false;
  const [ty, tm, td] = today.split("-").map(Number);
  const take = (m: RegExpMatchArray) => spans.push({ start: m.index!, end: m.index! + m[0].length });

  let m: RegExpMatchArray | null;
  if ((m = n.match(/\b(anteontem)\b/))) {
    date = addDays(today, -2);
    take(m);
  } else if ((m = n.match(/\b(ontem)\b/))) {
    date = addDays(today, -1);
    take(m);
  } else if ((m = n.match(/\b(hoje)\b/))) {
    date = today;
    take(m);
  } else if ((m = n.match(/\b(amanha)\b/))) {
    date = addDays(today, 1);
    explicitFuture = true;
    take(m);
  }
  // dd/mm ou dd/mm/aaaa
  const dm = n.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dm) {
    const d = Number(dm[1]);
    const mo = Number(dm[2]);
    let y = dm[3] ? Number(dm[3]) : ty;
    if (y < 100) y += 2000;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (isIsoDate(iso)) {
      date = iso;
      if (!dm[3] && pendingHint && iso < today) date = `${y + 1}${iso.slice(4)}`;
      explicitFuture = date > today;
      take(dm);
    }
  }
  // "dia 20" / "no dia 5"
  const dd = n.match(/\b(?:(?:para|pra|ate|no|todo|vence|vencimento)\s+(?:o\s+)?)?dia\s+(\d{1,2})\b/);
  if (dd && !dm) {
    const d = Number(dd[1]);
    if (d >= 1 && d <= 31) {
      let iso = makeDate(ty, tm, d);
      if (pendingHint) {
        if (d < td) iso = addMonths(makeDate(ty, tm, 1), 1, d); // já passou → próximo mês
      } else if (d > td) {
        iso = addMonths(makeDate(ty, tm, 1), -1, d); // fato passado → mês anterior
      }
      date = iso;
      explicitFuture = iso > today;
      take(dd);
    }
  }
  return { date, spans, explicitFuture };
}

function overlaps(a: Span, list: Span[]) {
  return list.some((b) => a.start < b.end && b.start < a.end);
}

function findAmount(n: string, exclude: Span[]): { cents: number; text: string; span: Span } | null {
  const candidates: Array<{ cents: number; text: string; span: Span; score: number }> = [];
  for (const m of n.matchAll(MONEY_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length };
    if (overlaps(span, exclude)) continue;
    const raw = m[0].replace(/\s*(reais|real|contos?|pila)\b/, "").trim();
    const after = n.slice(span.end, span.end + 3);
    if (/^\s*x\b/.test(after) || /^\s*vezes/.test(n.slice(span.end, span.end + 7))) continue; // "3x", "3 vezes"
    const before = n.slice(Math.max(0, span.start - 10), span.start);
    if (/(em|parcelad[oa] em)\s*$/.test(before) && /^\s*(x|vezes|parcelas)/.test(n.slice(span.end, span.end + 9))) continue;
    const cents = parseMoneyToCents(raw);
    if (!cents) continue;
    let score = 0;
    if (/r\$/.test(m[0])) score += 3;
    if (/(reais|real|conto|pila|mil|k)\b/.test(m[0])) score += 2;
    if (/[.,]\d{2}$/.test(raw)) score += 1;
    candidates.push({ cents, text: m[0].trim(), span, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.span.start - b.span.start);
  return candidates[0];
}

function findInstallments(n: string): { count: number; span: Span } | null {
  const m = n.match(/\b(?:em\s+|parcelad[oa]\s+em\s+)?(\d{1,2})\s*(?:x|vezes|parcelas)\b/);
  if (!m) return null;
  const count = Number(m[1]);
  if (count < 2 || count > 72) return null;
  return { count, span: { start: m.index!, end: m.index! + m[0].length } };
}

export function matchCategory(n: string, kind: "income" | "expense", categories: CategoryLite[]): CategoryLite | null {
  let best: { cat: CategoryLite; len: number } | null = null;
  for (const c of categories) {
    if (c.kind !== kind) continue;
    const terms = [c.name, ...c.keywords.split(",")].map((t) => normalize(t)).filter((t) => t.length >= 2);
    for (const term of terms) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(n) && (!best || term.length > best.len)) best = { cat: c, len: term.length };
    }
  }
  return best?.cat ?? null;
}

const FILLER = new Set(
  ("registra registrar registre anota anotar anote lanca lancar lance adiciona adicionar adicione coloca colocar coloque " +
    "uma um de do da dos das com no na nos nas em para pra pro por o a os as e que eu meu minha foi hoje ontem anteontem amanha " +
    "despesa receita gasto gastei paguei pago pagar recebi receber ganhei entrou caiu comprei compra valor reais real r$ " +
    "dia vence vencimento vencendo ate x vezes parcelas parcelado parcelada mil k favor por favor pf pfv agora la aqui")
    .split(" "),
);

function buildDescription(original: string, n: string, removeSpans: Span[], kind: "income" | "expense", category: CategoryLite | null) {
  // "conta de internet" → "Conta de internet"
  const conta = n.match(/\b(conta|boleto|fatura|mensalidade|assinatura) d[aeo]s? ([a-z0-9 ]{2,30}?)(?= de r\$| de \d| r\$| \d| para| pra| no dia| dia| vence|$)/);
  if (conta) return capitalize(`${conta[1]} de ${conta[2].trim()}`);
  // "com supermercado" / "no mercado" / "de salário"
  const prep = n.match(/\b(?:com|no|na|em|de|pro|pra|para) (?:o |a )?([a-z0-9][a-z0-9 ]{1,40}?)(?= de r\$| r\$| \d|,|\.| hoje| ontem| para| pra| no dia| dia| em \d|$)/g);
  const chars = n.split("");
  for (const s of removeSpans) for (let i = s.start; i < s.end; i++) chars[i] = " ";
  const cleaned = chars.join("");
  if (prep) {
    for (const p of prep) {
      const words = p.split(" ").slice(1).filter((w) => !FILLER.has(w) && !/^\d/.test(w));
      if (words.length && cleaned.includes(words.join(" "))) return capitalize(restoreAccents(original, words.join(" ")));
    }
  }
  const words = cleaned.split(/[\s,.;!?]+/).filter((w) => w && !FILLER.has(w) && !/^[\d.,]+$/.test(w) && !/^r\$/.test(w));
  if (words.length) return capitalize(restoreAccents(original, words.slice(0, 6).join(" ")));
  return category?.name ?? (kind === "income" ? "Receita" : "Despesa");
}

/** Recupera a grafia original (com acentos) de um trecho normalizado. */
function restoreAccents(original: string, normalizedPhrase: string) {
  const words = original.split(/\s+/);
  const target = normalizedPhrase.split(" ");
  for (let i = 0; i + target.length <= words.length; i++) {
    const slice = words.slice(i, i + target.length);
    if (slice.map((w) => normalize(w).replace(/[^a-z0-9]/g, "")).join(" ") === target.map((t) => t.replace(/[^a-z0-9]/g, "")).join(" ")) {
      return slice.join(" ").replace(/[,.;!?]+$/, "");
    }
  }
  return normalizedPhrase;
}

function capitalize(s: string) {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const QUERY_PATTERNS: Array<[QueryIntent, RegExp]> = [
  ["family", /\b(familia|familiar|todos|da casa)\b.*\b(saldo|resumo|gast|receit|despes)|\b(saldo|resumo).*\b(familia|familiar)\b/],
  ["upcoming", /\b(proxim[oa]s?|vai vencer|vencem|vencimentos?)\b/],
  ["bills", /\b(contas?|boletos?)\b.*\b(pendentes?|atrasad[oa]s?|abert[oa]s?|a pagar|pagar)\b|\b(o que|oque) (eu )?(tenho|falta) (pra|para|a) pagar\b|\batrasad/],
  ["goals", /\bmetas?\b|\bobjetivos?\b/],
  ["balance", /\b(saldo|quanto (eu )?tenho)\b/],
  ["income", /\b(quanto|quais|minhas?|total de)\b.*\b(recebi|receitas?|ganhei|entrou)\b|\breceitas do mes\b/],
  ["expenses", /\b(quanto|quais|minhas?|total de)\b.*\b(gastei|despesas?|gastos?|paguei)\b|\bdespesas do mes\b|\bgastos do mes\b/],
  ["summary", /\b(resumo|balanco|como (estao|esta|tao|ta) (as |minhas )?(financas|contas)|relatorio)\b/],
];

export function detectQuery(n: string): QueryIntent | null {
  const isQuestion = /\?$/.test(n) || /^(qual|quais|quanto|quantos|como|tenho|o que|oque|mostra|mostrar|ver|me (mostra|diz|fala)|lista)/.test(n);
  const hasAmount = /\d/.test(n.replace(/\b\d{1,2}\/\d{1,2}\b/g, ""));
  if (hasAmount && !isQuestion) return null; // provavelmente é um lançamento
  for (const [intent, re] of QUERY_PATTERNS) if (re.test(n)) return intent;
  return null;
}

export function parseMessage(text: string, categories: CategoryLite[], today: string): Intent {
  const original = text.trim().slice(0, 500);
  const n = normalize(original);
  if (!n) return { type: "unknown" };

  const query = detectQuery(n);
  if (query) return { type: "query", query };

  const income = INCOME_WORDS.test(n);
  const expense = EXPENSE_WORDS.test(n);
  let kind: "income" | "expense" | null = null;
  if (income && !expense) kind = "income";
  else if (expense && !income) kind = "expense";
  else if (income && expense) {
    // "recebi o pagamento..." vs "paguei a conta" — o verbo no início decide
    const fi = n.search(INCOME_WORDS);
    const fe = n.search(EXPENSE_WORDS);
    kind = fi <= fe ? "income" : "expense";
  }

  const pendingHint = PENDING_WORDS.test(n) && !/\b(paguei|ja paguei|recebi)\b/.test(n);
  const { date: foundDate, spans: dateSpans, explicitFuture } = findDate(n, today, pendingHint);
  const inst = findInstallments(n);
  const exclude = [...dateSpans, ...(inst ? [inst.span] : [])];
  const amount = findAmount(n, exclude);

  if (amount && !kind) {
    // sem verbo ("uber 23"): se só uma categoria casar, o tipo vem dela
    const asExpense = matchCategory(n, "expense", categories);
    const asIncome = matchCategory(n, "income", categories);
    if (asExpense && !asIncome) kind = "expense";
    else if (asIncome && !asExpense) kind = "income";
  }

  if (!amount || !kind) {
    if (!amount && !kind) return { type: "unknown" };
    const missing: Array<"amount" | "kind"> = [];
    if (!amount) missing.push("amount");
    if (!kind) missing.push("kind");
    return { type: "incomplete", missing, partial: { amountCents: amount?.cents, kind: kind ?? undefined, amountText: amount?.text } };
  }

  const date = foundDate ?? today;
  let status: "paid" | "pending" = "paid";
  if (pendingHint || explicitFuture || date > today) status = "pending";
  if (PAID_WORDS.test(n) && !pendingHint && date <= today) status = "paid";

  const category = matchCategory(n, kind, categories) ?? categories.find((c) => c.kind === kind && /^outr[ao]s/i.test(normalize(c.name))) ?? null;
  const description = buildDescription(original, n, [amount.span, ...exclude], kind, category).slice(0, 160);

  return {
    type: "entry",
    draft: {
      kind,
      amountCents: amount.cents,
      description,
      categoryId: category?.id ?? null,
      date,
      status,
      installments: kind === "expense" && inst ? inst.count : null,
      amountText: amount.text,
    },
  };
}
