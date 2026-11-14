const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const brlCompact = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 });
const numCompact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
/** Rótulo curto para eixos ("3,6 mil"); a moeda fica implícita no título do gráfico. */
export const axisMoney = (cents: number) => numCompact.format(cents / 100);

export const money = (cents: number) => brl.format(cents / 100).replace(/ /g, " ");
export const moneyCompact = (cents: number) => brlCompact.format(cents / 100).replace(/ /g, " ");
export const signedMoney = (cents: number) => (cents > 0 ? "+" : cents < 0 ? "−" : "") + money(Math.abs(cents));

/** Separa reais e centavos para tipografia do valor principal. */
export function moneyParts(cents: number) {
  const s = money(cents);
  const i = s.lastIndexOf(",");
  return { main: s.slice(0, i), cents: s.slice(i) };
}

/** Converte o que a pessoa digitou ("1.234,56") em centavos. */
export function parseCents(input: string): number | null {
  const s = input.replace(/[^\d,.-]/g, "");
  if (!s) return null;
  let n: string;
  if (s.includes(",")) n = s.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}$/.test(s) || (s.match(/\./g) || []).length > 1) n = s.replace(/\./g, "");
  else n = s;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

export function centsToInput(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MONTHS_FULL = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export const monthShort = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1];
export const monthLong = (ym: string) => `${MONTHS_FULL[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;
export const monthName = (ym: string) => MONTHS_FULL[Number(ym.slice(5, 7)) - 1];

export function dateShort(iso: string) {
  return `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}
export function dateFull(iso: string) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
export function dateHeading(iso: string, today: string) {
  if (iso === today) return "Hoje";
  if (iso === addDays(today, -1)) return "Ontem";
  if (iso === addDays(today, 1)) return "Amanhã";
  const d = new Date(iso + "T12:00:00");
  const w = WEEKDAYS[d.getDay()];
  return `${w.charAt(0).toUpperCase()}${w.slice(1)}, ${Number(iso.slice(8, 10))} de ${MONTHS_FULL[d.getMonth()]}`;
}

export function todayIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}
export function currentYm() {
  return todayIso().slice(0, 7);
}
export function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function shiftYm(ym: string, n: number) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export function monthBounds(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}
export function daysUntil(iso: string, today: string) {
  return Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
}
export function relativeDue(iso: string, today: string) {
  const d = daysUntil(iso, today);
  if (d === 0) return "vence hoje";
  if (d === 1) return "vence amanhã";
  if (d > 1) return `em ${d} dias`;
  if (d === -1) return "venceu ontem";
  return `atrasada há ${-d} dias`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
export const firstName = (name: string) => name.split(" ")[0];

export function pct(n: number) {
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

/** Cor de integrante no tema atual (passo escuro equivalente — validado). */
const DARK_STEP: Record<string, string> = {
  "#2a78d6": "#3987e5",
  "#eb6834": "#d95926",
  "#1baf7a": "#199e70",
  "#6250d6": "#9085e9",
  "#e87ba4": "#d55181",
  "#eda100": "#c98500",
};
export function memberColor(hex: string, dark: boolean) {
  return dark ? (DARK_STEP[hex.toLowerCase()] ?? hex) : hex;
}
