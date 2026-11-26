/**
 * Extração determinística de campos de mensagens em português do Brasil:
 * valor, tipo (receita/despesa), descrição, categoria, data, situação,
 * parcelas, conta e forma de pagamento. Não usa IA.
 */
import { addDays, addMonths, isIsoDate, makeDate } from "../lib/clock.js";
import { parseMoneyToCents } from "../lib/money.js";
import type { PaymentMethod } from "../services/transactions.js";

export interface CategoryLite {
  id: number;
  name: string;
  kind: "income" | "expense";
  keywords: string;
}

export interface AccountLite {
  id: number;
  name: string;
}

export interface Draft {
  kind: "income" | "expense";
  amountCents: number;
  description: string;
  categoryId: number | null;
  date: string;
  status: "paid" | "pending";
  installments: number | null;
  paymentMethod: PaymentMethod | null;
  accountId: number | null;
  /** Trecho exato do valor como foi escrito — para conferência. */
  amountText: string;
  /** Campos usados por canais externos (WhatsApp); o Telegram não os preenche. */
  recurrence?: { endDate: string | null; autoPaid: boolean } | null;
  notes?: string | null;
  externalRef?: string | null;
}

export type EntryParse =
  | { type: "entry"; draft: Draft }
  | { type: "incomplete"; missing: Array<"amount" | "kind">; partial: Partial<Draft> }
  | { type: "unknown" };

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const INCOME_WORDS = /\b(recebi|receber|ganhei|ganho|entrou|entrada|caiu|receita|salario|vendi|reembolso|reembolsaram|depositaram|me pagaram|pix recebido|rendeu|rendimento)\b/;
export const EXPENSE_WORDS = /\b(gastei|gasto|paguei|pagar|pago|despesa|comprei|compra|conta|boleto|fatura|debito|mensalidade|parcela|assinatura|saiu)\b/;
const PENDING_WORDS = /\b(vence|vencimento|vencendo|a pagar|pagar|para (o )?dia|pra (o )?dia|ate (o )?dia|agendar|agendado|vai vencer|lembrar)\b/;
const PAID_WORDS = /\b(paguei|gastei|comprei|recebi|ganhei|entrou|caiu|pago|ja paguei)\b/;

const MONEY_RE =
  /(r\$\s*\d[\d.,]*(?:\s*(?:mil|k)\b)?|\d[\d.,]*\s*(?:mil|k)\b|\d[\d.,]*\s*(?:reais|real|conto|contos|pila)\b|\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/gi;

export interface Span {
  start: number;
  end: number;
}

const PAYMENT_PATTERNS: Array<[PaymentMethod, RegExp]> = [
  ["pix", /\b(?:no |via |pelo |por |com )?pix\b/],
  ["credit_card", /\b(?:no |com o |pelo )?(?:cartao de credito|credito|cartao)\b/],
  ["debit_card", /\b(?:no |com o |pelo )?(?:cartao de debito|debito)\b/],
  ["cash", /\b(?:em |no |com )?(?:dinheiro|especie)\b/],
  ["transfer", /\b(?:via |por |com )?(?:transferencia|ted|doc)\b/],
  ["boleto", /\b(?:no |via |pelo |por )boleto\b/],
];

export function findPaymentMethod(n: string): { method: PaymentMethod; span: Span } | null {
  // débito explícito vence "cartão" genérico
  const order: PaymentMethod[] = ["pix", "debit_card", "credit_card", "cash", "transfer", "boleto"];
  for (const method of order) {
    const re = PAYMENT_PATTERNS.find(([m]) => m === method)![1];
    const m = n.match(re);
    if (m) return { method, span: { start: m.index!, end: m.index! + m[0].length } };
  }
  return null;
}

export function findAccount(n: string, accounts: AccountLite[]): { id: number; span: Span } | null {
  let best: { id: number; span: Span; len: number } | null = null;
  for (const a of accounts) {
    const name = normalize(a.name);
    if (name.length < 3 || name === "conta principal") continue;
    const re = new RegExp(`\\b(?:no |na |pelo |pela |do |da )?${escapeRe(name)}\\b`);
    const m = n.match(re);
    if (m && (!best || name.length > best.len)) best = { id: a.id, span: { start: m.index!, end: m.index! + m[0].length }, len: name.length };
  }
  return best ? { id: best.id, span: best.span } : null;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Interpreta datas: hoje, ontem, anteontem, amanhã, dd/mm[/aaaa], "dia 20". */
export function findDate(n: string, today: string, pendingHint: boolean): { date: string | null; spans: Span[]; explicitFuture: boolean } {
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
  const dd = n.match(/\b(?:(?:para|pra|ate|no|todo|vence|vencimento)\s+(?:o\s+)?)?dia\s+(\d{1,2})\b/);
  if (dd && !dm) {
    const d = Number(dd[1]);
    if (d >= 1 && d <= 31) {
      let iso = makeDate(ty, tm, d);
      if (pendingHint) {
        if (d < td) iso = addMonths(makeDate(ty, tm, 1), 1, d);
      } else if (d > td) {
        iso = addMonths(makeDate(ty, tm, 1), -1, d);
      }
      date = iso;
      explicitFuture = iso > today;
      take(dd);
    }
  }
  return { date, spans, explicitFuture };
}

/** Data digitada isoladamente (edição): "ontem", "12/11", "12/11/2026", "2026-11-12". */
export function parseDateText(text: string, today: string): string | null {
  const t = text.trim();
  if (isIsoDate(t)) return t;
  const { date } = findDate(normalize(t), today, false);
  return date;
}

function overlaps(a: Span, list: Span[]) {
  return list.some((b) => a.start < b.end && b.start < a.end);
}

export function findAmount(n: string, exclude: Span[]): { cents: number; text: string; span: Span } | null {
  const candidates: Array<{ cents: number; text: string; span: Span; score: number }> = [];
  for (const m of n.matchAll(MONEY_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length };
    if (overlaps(span, exclude)) continue;
    const raw = m[0].replace(/\s*(reais|real|contos?|pila)\b/, "").trim();
    const after = n.slice(span.end, span.end + 9);
    if (/^\s*(x\b|vezes|parcelas)/.test(after)) continue; // "3x", "3 vezes"
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
      const re = new RegExp(`\\b${escapeRe(term)}\\b`);
      if (re.test(n) && (!best || term.length > best.len)) best = { cat: c, len: term.length };
    }
  }
  return best?.cat ?? null;
}

const FILLER = new Set(
  ("registra registrar registre anota anotar anote lanca lancar lance adiciona adicionar adicione coloca colocar coloque " +
    "uma um de do da dos das com no na nos nas em para pra pro por o a os as e que eu meu minha foi hoje ontem anteontem amanha " +
    "despesa receita gasto gastei paguei pago pagar recebi receber ganhei entrou caiu comprei compra valor reais real r$ " +
    "dia vence vencimento vencendo ate x vezes parcelas parcelado parcelada mil k favor por favor pf pfv agora la aqui " +
    "pix cartao credito debito dinheiro especie transferencia ted via pelo pela")
    .split(" "),
);

function buildDescription(original: string, n: string, removeSpans: Span[], kind: "income" | "expense", category: CategoryLite | null) {
  const conta = n.match(/\b(conta|boleto|fatura|mensalidade|assinatura) d[aeo]s? ([a-z0-9 ]{2,30}?)(?= de r\$| de \d| r\$| \d| para| pra| no dia| dia| vence| no | pelo | via |$)/);
  if (conta) return capitalize(`${conta[1]} de ${conta[2].trim()}`);
  const chars = n.split("");
  for (const s of removeSpans) for (let i = s.start; i < s.end; i++) chars[i] = " ";
  const cleaned = chars.join("").replace(/\s+/g, " ");
  const prep = cleaned.match(/\b(?:com|no|na|em|de|pro|pra|para) (?:o |a |um |uma )?([a-z0-9][a-z0-9 ]{1,40}?)(?=,|\.| hoje| ontem| para| pra| no dia| dia| em \d|$)/g);
  if (prep) {
    for (const p of prep) {
      const words = p.split(" ").slice(1).filter((w) => w && !FILLER.has(w) && !/^\d/.test(w));
      if (words.length) return capitalize(restoreAccents(original, words.slice(0, 5).join(" ")));
    }
  }
  const words = cleaned.split(/[\s,.;!?]+/).filter((w) => w && !FILLER.has(w) && !/^[\d.,]+$/.test(w) && !/^r\$/.test(w));
  if (words.length) return capitalize(restoreAccents(original, words.slice(0, 5).join(" ")));
  return category?.name ?? (kind === "income" ? "Receita" : "Despesa");
}

/** Recupera a grafia original (com acentos) de um trecho normalizado. */
function restoreAccents(original: string, normalizedPhrase: string) {
  const words = original.split(/\s+/);
  const target = normalizedPhrase.split(" ");
  const clean = (w: string) => normalize(w).replace(/[^a-z0-9]/g, "");
  for (let i = 0; i + target.length <= words.length; i++) {
    const slice = words.slice(i, i + target.length);
    if (slice.map(clean).join(" ") === target.map((t) => t.replace(/[^a-z0-9]/g, "")).join(" ")) {
      return slice.join(" ").replace(/[,.;!?]+$/, "");
    }
  }
  return normalizedPhrase;
}

export function capitalize(s: string) {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Extrai um lançamento (receita/despesa) de uma frase. */
export function parseEntry(text: string, categories: CategoryLite[], today: string, accounts: AccountLite[] = []): EntryParse {
  const original = text.trim().slice(0, 500);
  const n = normalize(original);
  if (!n) return { type: "unknown" };

  const income = INCOME_WORDS.test(n);
  const expense = EXPENSE_WORDS.test(n);
  let kind: "income" | "expense" | null = null;
  if (income && !expense) kind = "income";
  else if (expense && !income) kind = "expense";
  else if (income && expense) kind = n.search(INCOME_WORDS) <= n.search(EXPENSE_WORDS) ? "income" : "expense";

  const pendingHint = PENDING_WORDS.test(n) && !/\b(paguei|ja paguei|recebi)\b/.test(n);
  const { date: foundDate, spans: dateSpans, explicitFuture } = findDate(n, today, pendingHint);
  const inst = findInstallments(n);
  const payment = findPaymentMethod(n);
  const account = findAccount(n, accounts);
  const exclude = [...dateSpans, ...(inst ? [inst.span] : [])];
  const amount = findAmount(n, exclude);

  if (amount && !kind) {
    const asExpense = matchCategory(n, "expense", categories);
    const asIncome = matchCategory(n, "income", categories);
    if (asExpense && !asIncome) kind = "expense";
    else if (asIncome && !asExpense) kind = "income";
  }

  const date = foundDate ?? today;
  let status: "paid" | "pending" = "paid";
  if (pendingHint || explicitFuture || date > today) status = "pending";
  if (PAID_WORDS.test(n) && !pendingHint && date <= today) status = "paid";

  const removeSpans = [...(amount ? [amount.span] : []), ...exclude, ...(payment ? [payment.span] : []), ...(account ? [account.span] : [])];

  if (!amount || !kind) {
    if (!amount && !kind) return { type: "unknown" };
    const missing: Array<"amount" | "kind"> = [];
    if (!amount) missing.push("amount");
    if (!kind) missing.push("kind");
    const category = kind ? matchCategory(n, kind, categories) : null;
    return {
      type: "incomplete",
      missing,
      partial: {
        amountCents: amount?.cents,
        amountText: amount?.text,
        kind: kind ?? undefined,
        date,
        status,
        categoryId: category?.id ?? null,
        paymentMethod: payment?.method ?? null,
        accountId: account?.id ?? null,
        description: kind ? buildDescription(original, n, removeSpans, kind, category).slice(0, 160) : undefined,
      },
    };
  }

  const category = matchCategory(n, kind, categories) ?? categories.find((c) => c.kind === kind && /^outr[ao]s/i.test(normalize(c.name))) ?? null;
  const description = buildDescription(original, n, removeSpans, kind, category).slice(0, 160);

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
      paymentMethod: payment?.method ?? null,
      accountId: account?.id ?? null,
      amountText: amount.text,
    },
  };
}
