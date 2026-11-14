/** Dinheiro sempre em centavos inteiros. Nunca use float para somar valores. */
export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export const MAX_CENTS = 100_000_000_000; // R$ 1 bilhão — limite de sanidade

/**
 * Converte texto em centavos. Aceita "150", "150,90", "1.234,56", "R$ 3.000",
 * "1234.56", "3 mil", "2,5 mil", "1k". Retorna null se não houver valor válido.
 * Convenção brasileira: vírgula é decimal; ponto seguido de 3 dígitos é milhar.
 */
export function parseMoneyToCents(input: string): number | null {
  let s = input.trim().toLowerCase().replace(/r\$\s*/g, "").replace(/\s+/g, " ");
  let mult = 1;
  const mil = s.match(/^([\d.,]+)\s*(mil|k)$/);
  if (mil) {
    s = mil[1];
    mult = 1000;
  }
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;

  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  let normalized: string;
  if (commas && dots) {
    normalized = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (commas) {
    normalized = commas > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (dots) {
    const decimals = s.length - s.lastIndexOf(".") - 1;
    normalized = dots > 1 || (decimals === 3 && mult === 1) ? s.replace(/\./g, "") : s;
  } else {
    normalized = s;
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * mult * 100);
  if (cents <= 0 || cents > MAX_CENTS) return null;
  return cents;
}
