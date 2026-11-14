import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";

// Parâmetros do scrypt (N=2^15, r=8, p=1) — alinhados à recomendação OWASP.
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(pw: string, salt: Buffer, len: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    _scrypt(pw, salt, len, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash fixo usado para gastar o mesmo tempo quando o e-mail não existe (evita enumeração). */
export const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Comparação em tempo constante para segredos (webhook, cron). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return a.length > 0 && b.length > 0 && timingSafeEqual(ha, hb);
}

/** Código curto legível (sem 0/O/1/I/L) para vinculação manual no Telegram. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function humanCode(len = 8): string {
  // rejeição de amostragem para não enviesar o alfabeto
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}
