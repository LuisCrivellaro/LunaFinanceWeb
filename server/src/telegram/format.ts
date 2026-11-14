import { formatDatePt } from "../lib/clock.js";
import { formatBRL } from "../lib/money.js";

/** Escapa texto para parse_mode=HTML do Telegram. */
export function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const brl = (cents: number) => formatBRL(cents).replace(/ /g, " ");
export const dt = (iso: string) => formatDatePt(iso).slice(0, 5);
export const dtFull = formatDatePt;

export function signed(cents: number) {
  return (cents >= 0 ? "+" : "−") + brl(Math.abs(cents)).replace("-", "");
}

export function bar(percent: number, width = 10) {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}
