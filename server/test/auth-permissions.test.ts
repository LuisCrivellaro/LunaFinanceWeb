import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, setupTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => t.close());

describe("autenticação", () => {
  it("bloqueia a API sem login", async () => {
    const r = await request(t.app).get("/api/dashboard");
    expect(r.status).toBe(401);
  });

  it("login define cookie httpOnly + SameSite e não devolve token no corpo", async () => {
    const r = await request(t.app).post("/api/auth/login").set("x-luna-client", "web").send({ email: "joao@familia.test", password: PASSWORD });
    expect(r.status).toBe(200);
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(/luna_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);
  });

  it("senha errada → 401 genérico; 5 erros bloqueiam a conta", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(t.app).post("/api/auth/login").set("x-luna-client", "web").send({ email: "luis@familia.test", password: "errada" });
      expect(r.status).toBe(401);
      expect(r.body.error.message).toBe("E-mail ou senha incorretos.");
    }
    const blocked = await request(t.app).post("/api/auth/login").set("x-luna-client", "web").send({ email: "luis@familia.test", password: PASSWORD });
    expect(blocked.status).toBe(429);
    await t.db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [t.ids.luis]);
  });

  it("e-mail inexistente recebe a mesma resposta (sem enumeração)", async () => {
    const r = await request(t.app).post("/api/auth/login").set("x-luna-client", "web").send({ email: "ninguem@x.com", password: "qualquer" });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe("E-mail ou senha incorretos.");
  });

  it("requisição que altera dados sem cabeçalho do cliente é bloqueada (CSRF)", async () => {
    const s = await t.as("joao");
    const r = await s.agent.post("/api/transactions").send({ kind: "expense", amountCents: 100, description: "x", date: "2026-11-14" });
    expect(r.status).toBe(403);
  });

  it("logout invalida a sessão no servidor", async () => {
    const s = await t.as("joao");
    expect((await s.get("/api/me")).status).toBe(200);
    await s.post("/api/auth/logout");
    expect((await s.get("/api/me")).status).toBe(401);
  });

  it("link de primeiro acesso é de uso único e exige senha forte", async () => {
    const lipe = await t.as("lipe");
    const created = await lipe.post("/api/family/members").send({ name: "Visitante", email: "visita@familia.test" });
    expect(created.status).toBe(200);
    const token = new URL(created.body.url).hash.replace("#t=", "");
    const weak = await request(t.app).post("/api/auth/access-link/consume").set("x-luna-client", "web").send({ token, password: "123" });
    expect(weak.status).toBe(400);
    const ok = await request(t.app).post("/api/auth/access-link/consume").set("x-luna-client", "web").send({ token, password: "OutraSenha456" });
    expect(ok.status).toBe(200);
    const again = await request(t.app).post("/api/auth/access-link/consume").set("x-luna-client", "web").send({ token, password: "OutraSenha456" });
    expect(again.status).toBe(404);
    // remove a pessoa extra para não afetar os demais testes
    await t.db.query("UPDATE users SET active = FALSE WHERE email = 'visita@familia.test'");
  });

  it("troca de senha exige a senha atual", async () => {
    const s = await t.as("joao");
    expect((await s.post("/api/me/password").send({ currentPassword: "errada", newPassword: "NovaSenha789" })).status).toBe(400);
    expect((await s.post("/api/me/password").send({ currentPassword: PASSWORD, newPassword: "NovaSenha789" })).status).toBe(200);
    expect((await s.post("/api/me/password").send({ currentPassword: "NovaSenha789", newPassword: PASSWORD })).status).toBe(200);
  });
});

describe("regra absoluta: nenhuma hierarquia visível", () => {
  it("lista de membros não contém papel, nem para quem gerencia", async () => {
    for (const key of ["lipe", "luciana"] as const) {
      const s = await t.as(key);
      const r = await s.get("/api/members");
      expect(r.status).toBe(200);
      const body = JSON.stringify(r.body).toLowerCase();
      expect(body).not.toMatch(/role|admin|adm\b|administrador|owner|dono/);
      expect(r.body.map((m: { name: string }) => m.name)).toEqual(["João", "Lipe", "Luciana", "Luís Carlos"]); // ordem alfabética
    }
  });

  it("/me do Lipe não traz texto de papel — só uma capacidade booleana", async () => {
    const s = await t.as("lipe");
    const r = await s.get("/api/me");
    expect(r.body.capabilities).toEqual({ manageMembers: true });
    expect(JSON.stringify(r.body).toLowerCase()).not.toMatch(/"role"|admin|administrador/);
    const other = await (await t.as("luciana")).get("/api/me");
    expect(other.body.capabilities).toEqual({ manageMembers: false });
  });

  it("gestão de membros é recusada no backend para os demais", async () => {
    const s = await t.as("luciana");
    expect((await s.get("/api/family/members")).status).toBe(403);
    expect((await s.patch(`/api/family/members/${t.ids.joao}`).send({ familyAccess: "none" })).status).toBe(403);
    expect((await s.post(`/api/family/members/${t.ids.joao}/access-link`)).status).toBe(403);
    expect((await s.post("/api/family/members").send({ name: "X", email: "x@x.com" })).status).toBe(403);
  });

  it("a área de gestão também não expõe papéis", async () => {
    const r = await (await t.as("lipe")).get("/api/family/members");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body).toLowerCase()).not.toMatch(/"role"|admin/);
    expect(JSON.stringify(r.body)).not.toMatch(/password_hash|\$scrypt|scrypt\$/);
  });
});

describe("isolamento de dados entre os quatro integrantes", () => {
  let lucianaTx: number;

  beforeAll(async () => {
    const lu = await t.as("luciana");
    const r = await lu.post("/api/transactions").send({ kind: "expense", amountCents: 25000, description: "Farmácia", date: "2026-11-10", categoryId: await t.categoryId("Saúde") });
    expect(r.status).toBe(200);
    lucianaTx = r.body[0].id;
  });

  it("ninguém edita ou exclui lançamento de outra pessoa — nem quem gerencia", async () => {
    for (const key of ["lipe", "joao", "luis"] as const) {
      const s = await t.as(key);
      expect((await s.patch(`/api/transactions/${lucianaTx}`).send({ amountCents: 1 })).status).toBe(403);
      expect((await s.del(`/api/transactions/${lucianaTx}`)).status).toBe(403);
      expect((await s.post(`/api/transactions/${lucianaTx}/pay`).send({})).status).toBe(403);
    }
    const { rows } = await t.db.query("SELECT amount_cents, deleted_at FROM transactions WHERE id = $1", [lucianaTx]);
    expect(rows[0]).toMatchObject({ amount_cents: 25000, deleted_at: null });
  });

  it("não é possível lançar em conta (carteira) de outra pessoa", async () => {
    const { rows } = await t.db.query<{ id: number }>("SELECT id FROM accounts WHERE owner_id = $1", [t.ids.luciana]);
    const r = await (await t.as("joao")).post("/api/transactions").send({ kind: "expense", amountCents: 100, description: "x", date: "2026-11-14", accountId: rows[0].id });
    expect(r.status).toBe(400);
  });

  it("visão 'me' mostra apenas os próprios lançamentos", async () => {
    const r = await (await t.as("joao")).get("/api/transactions?view=me");
    expect(r.status).toBe(200);
    expect(r.body.items.every((i: { userId: number }) => i.userId === t.ids.joao)).toBe(true);
  });

  it("acesso 'full': vê lançamentos da família", async () => {
    const r = await (await t.as("joao")).get("/api/transactions?view=family");
    expect(r.status).toBe(200);
    expect(r.body.items.some((i: { id: number }) => i.id === lucianaTx)).toBe(true);
  });

  it("acesso 'summary': vê totais da família, mas não lançamentos alheios", async () => {
    await t.setAccess("joao", "summary");
    const s = await t.as("joao");
    expect((await s.get("/api/transactions?view=family")).status).toBe(403);
    expect((await s.get(`/api/transactions?view=${t.ids.luciana}`)).status).toBe(403);
    expect((await s.get("/api/reports/export.csv?view=family&from=2026-11-01&to=2026-11-30")).text).not.toMatch(/Farmácia/);
    const dash = await s.get("/api/dashboard?view=family");
    expect(dash.status).toBe(200);
    expect(dash.body.detail).toBe(false);
    expect(dash.body.totals.expenseTotalCents).toBeGreaterThanOrEqual(25000);
    expect(dash.body.members).toBeNull();
    expect(JSON.stringify(dash.body.upcoming)).not.toMatch(/Farmácia/);
    await t.setAccess("joao", "full");
  });

  it("acesso 'none': nada da família", async () => {
    await t.setAccess("luis", "none");
    const s = await t.as("luis");
    expect((await s.get("/api/dashboard?view=family")).status).toBe(403);
    expect((await s.get("/api/reports?view=family")).status).toBe(403);
    expect((await s.get("/api/dashboard?view=me")).status).toBe(200);
    await t.setAccess("luis", "full");
  });

  it("papel interno não dá acesso extra a dados: Lipe com 'summary' também é barrado", async () => {
    await t.setAccess("lipe", "summary");
    expect((await (await t.as("lipe")).get("/api/transactions?view=family")).status).toBe(403);
    await t.setAccess("lipe", "full");
  });

  it("Lipe pode ajustar permissões, e o efeito é imediato", async () => {
    const lipe = await t.as("lipe");
    expect((await lipe.patch(`/api/family/members/${t.ids.joao}`).send({ familyAccess: "none" })).status).toBe(200);
    expect((await (await t.as("joao")).get("/api/dashboard?view=family")).status).toBe(403);
    expect((await lipe.patch(`/api/family/members/${t.ids.joao}`).send({ familyAccess: "full" })).status).toBe(200);
  });

  it("ações sensíveis ficam no log de auditoria", async () => {
    const { rows } = await t.db.query<{ action: string }>("SELECT DISTINCT action FROM audit_log");
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.login", "auth.login_failed", "transaction.create", "member.update_access"]));
  });
});
