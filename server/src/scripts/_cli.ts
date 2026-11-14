import { loadConfig } from "../config.js";
import { createContext } from "../bootstrap.js";

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const pref = process.argv.find((a) => a.startsWith(`--${name}=`));
  return pref?.slice(name.length + 3);
}

export function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

export async function withContext<T>(fn: (ctx: Awaited<ReturnType<typeof createContext>>) => Promise<T>) {
  const ctx = await createContext({ ...loadConfig(), schedulerEnabled: false });
  try {
    return await fn(ctx);
  } finally {
    await ctx.db.close();
  }
}
