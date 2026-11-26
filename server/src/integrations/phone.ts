/**
 * Telefones no padrão internacional E.164 (+<país><número>, até 15 dígitos).
 *
 * Aceita o que costuma chegar:
 *   "+55 (11) 98765-4321", "5511987654321" (identificador do WhatsApp/OpenBot,
 *   só dígitos com o país), "11987654321" (número brasileiro sem o país).
 * Sem "+", números de 10–11 dígitos são tratados como brasileiros (+55).
 *
 * Celulares brasileiros: o WhatsApp às vezes identifica números antigos SEM o
 * nono dígito (55 11 8765-4321). `phoneVariants` devolve as duas formas para a
 * busca do vínculo — o número salvo continua sendo um só.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(input: unknown, defaultCountry = "55"): string | null {
  if (typeof input !== "string" && typeof input !== "number") return null;
  const raw = String(input).trim();
  if (!raw || raw.length > 40) return null;
  // descarta sufixos de JID do WhatsApp ("5511...@s.whatsapp.net")
  const base = raw.replace(/@.*$/, "");
  const plus = base.startsWith("+") || base.startsWith("00");
  let digits = base.replace(/\D/g, "");
  if (base.startsWith("00")) digits = digits.slice(2);
  if (!plus) {
    if (digits.length === 10 || digits.length === 11) digits = defaultCountry + digits.replace(/^0/, "");
  }
  const out = `+${digits}`;
  return E164.test(out) ? out : null;
}

/** Formas equivalentes do mesmo número (nono dígito de celulares brasileiros). */
export function phoneVariants(e164: string): string[] {
  const out = new Set([e164]);
  const br = /^\+55(\d{2})(\d+)$/.exec(e164);
  if (br) {
    const [, ddd, rest] = br;
    if (rest.length === 9 && rest.startsWith("9")) out.add(`+55${ddd}${rest.slice(1)}`);
    if (rest.length === 8 && /^[6-9]/.test(rest)) out.add(`+55${ddd}9${rest}`);
  }
  return [...out];
}

export function samePhone(a: string, b: string): boolean {
  return phoneVariants(a).includes(b);
}

/** Exibição sem expor o número inteiro (telas e logs): +55 •• ••••-4321. */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const tail = e164.slice(-4);
  const cc = /^\+55/.test(e164) ? "+55" : e164.slice(0, 3);
  return `${cc} •• •••••-${tail}`;
}
