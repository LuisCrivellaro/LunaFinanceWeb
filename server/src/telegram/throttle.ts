/**
 * Limites por usuário do Telegram (em memória — suficiente para uma instância):
 *  - mensagens: protege o banco e evita spam/loops;
 *  - chamadas de IA: teto de custo por pessoa.
 * Com mais de uma instância, os limites passam a valer por instância.
 */
export class SlidingWindow {
  private hits = new Map<string, number[]>();
  constructor(private windowMs: number, private max: number) {}

  /** Registra uma tentativa; retorna false se o limite foi excedido. */
  take(key: string, nowMs = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(nowMs);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }

  reset() {
    this.hits.clear();
  }
}

export const messageLimiter = new SlidingWindow(60_000, Number(process.env.TELEGRAM_USER_RATE_PER_MIN ?? 30));
export const aiLimiter = new SlidingWindow(3_600_000, Number(process.env.LUNA_AI_MAX_CALLS_PER_HOUR ?? 30));
