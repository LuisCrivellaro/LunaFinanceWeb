/**
 * Camada de acesso ao banco. Usamos SQL explícito (sem ORM) para que cada
 * consulta financeira seja auditável. Dois drivers com o MESMO dialeto:
 *  - Postgres real (`postgres://...`) via `pg` — produção.
 *  - PGlite (`pglite://memory` ou `pglite://caminho`) — Postgres em WASM,
 *    para desenvolvimento local e testes sem instalar nada.
 */
import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Executa SQL com várias instruções e sem parâmetros (migrações). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Executa `fn` dentro de uma transação (BEGIN/COMMIT/ROLLBACK). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: "pg" | "pglite";
}

const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;

// Valores monetários são guardados em centavos (BIGINT). Convertê-los para
// number é seguro até 9 quatrilhões de centavos.
pg.types.setTypeParser(INT8, (v) => Number(v));
pg.types.setTypeParser(NUMERIC, (v) => Number(v));
// Datas (sem hora) ficam como string ISO "YYYY-MM-DD" para evitar erros de fuso.
pg.types.setTypeParser(DATE, (v) => v);

async function createPg(url: string): Promise<Db> {
  const ssl =
    /sslmode=require/.test(url) || process.env.DATABASE_SSL === "true"
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined;
  const pool = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=require/, ""), ssl, max: 10 });
  pool.on("error", (err) => console.error("[db] erro no pool:", err.message));
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query(sql, params) {
      const r = await c.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await c.query(sql);
    },
  });
  return {
    driver: "pg",
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function createPglite(url: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const path = url.replace(/^pglite:\/\//, "");
  const parsers = {
    [INT8]: (v: string) => Number(v),
    [NUMERIC]: (v: string) => Number(v),
    [DATE]: (v: string) => v,
  };
  const db = path === "memory" || path === "" ? new PGlite({ parsers }) : new PGlite(path, { parsers });
  await db.waitReady;
  // PGlite é single-connection: serializamos transações para não intercalar.
  let chain: Promise<unknown> = Promise.resolve();
  const q: Queryable = {
    async query(sql, params) {
      const r = await db.query(sql, params as any[]);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql) {
      await db.exec(sql);
    },
  };
  return {
    driver: "pglite",
    ...q,
    tx(fn) {
      const run = chain.then(() =>
        db.transaction(async (t) =>
          fn({
            async query(sql, params) {
              const r = await t.query(sql, params as any[]);
              return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
            },
            async exec(sql) {
              await t.exec(sql);
            },
          }),
        ),
      );
      chain = run.catch(() => {});
      return run;
    },
    close: () => db.close(),
  };
}

export async function createDb(url: string): Promise<Db> {
  if (!url) throw new Error("DATABASE_URL não configurado");
  if (url.startsWith("pglite://")) return createPglite(url);
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return createPg(url);
  throw new Error("DATABASE_URL deve começar com postgres://, postgresql:// ou pglite://");
}
