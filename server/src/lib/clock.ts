/**
 * Relógio injetável (para testes) + utilitários de data no fuso da família.
 * Datas de calendário são sempre strings "YYYY-MM-DD".
 */
let fixedNow: Date | null = null;
let tz = "America/Sao_Paulo";

export function setTimezone(zone: string) {
  tz = zone;
}
export function getTimezone() {
  return tz;
}
/** Somente testes. */
export function setNow(d: Date | string | null) {
  fixedNow = d === null ? null : new Date(d);
}
export function now(): Date {
  return fixedNow ? new Date(fixedNow) : new Date();
}

export function toLocalDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function today(): string {
  return toLocalDate(now());
}
/** Hora local (0-23) no fuso configurado. */
export function localHour(d = now()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));
}
/** 0 = domingo … 6 = sábado, no fuso configurado. */
export function localWeekday(d = now()): number {
  const [y, m, day] = toLocalDate(d).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Cria uma data normalizando mês fora do intervalo e limitando o dia ao fim do mês. */
export function makeDate(year: number, month1: number, day: number): string {
  const base = new Date(Date.UTC(year, month1 - 1, 1));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + 1;
  const dd = Math.max(1, Math.min(day, daysInMonth(y, m)));
  return `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Soma meses mantendo o dia (limitado ao fim do mês): 31/01 + 1 = 28/02. */
export function addMonths(date: string, n: number, preferredDay?: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return makeDate(y, m + n, preferredDay ?? d);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** a - b em dias. */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}

/** "2026-11" → { start: "2026-11-01", end: "2026-11-30" } */
export function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  return { start: makeDate(y, m, 1), end: makeDate(y, m, 31) };
}

export function currentMonth(): string {
  return today().slice(0, 7);
}

export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  return makeDate(y, m + n, 1).slice(0, 7);
}

export function isYearMonth(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export function monthNamePt(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS_PT[m - 1]} de ${y}`;
}
export function formatDatePt(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}
