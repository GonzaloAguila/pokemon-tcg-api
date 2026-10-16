/**
 * One refresh session per device: logging in elsewhere doesn't end a session (it used to,
 * at its next refresh: players were kicked out mid-draft with a 401); logout ends only its
 * own device; ban, suspension and password changes end them all.
 */
import cookieParser from "cookie-parser";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { authRouter } from "../src/modules/auth/index.js";
import { toggleUserBan, suspendUser } from "../src/modules/admin/admin.service.js";
import { hashRefreshToken } from "../src/modules/auth/refresh-sessions.js";
import { createUser } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  process.env.LOGIN_RATE_LIMIT_MAX = "100";
  http = await startHttpApp((app) => {
    app.use(cookieParser());
    app.use("/api/auth", authRouter);
  });
});
afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});
beforeEach(() => clearAccountStateCache());

const PASSWORD = "Hunter!2026abc";

async function userWithPassword() {
  const user = await createUser();
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  return user;
}

async function login(email: string) {
  const res = await http.request("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { token: res.body.accessToken as string, cookie: res.cookie! };
}
const refresh = (cookie: string) => http.request("POST", "/api/auth/refresh", { cookie });

describe("refresh sessions per device", () => {
  it("logging in on another device keeps the first session alive", async () => {
    const user = await userWithPassword();
    const pc = await login(user.email);
    const phone = await login(user.email);
    expect(pc.cookie).not.toBe(phone.cookie);
    expect((await refresh(pc.cookie)).status).toBe(200);
    expect((await refresh(phone.cookie)).status).toBe(200);
    expect(await prisma.refreshSession.count({ where: { userId: user.id } })).toBe(2);
  });

  it("only a hash of the token is stored", async () => {
    const user = await userWithPassword();
    const s = await login(user.email);
    const token = decodeURIComponent(s.cookie.split("=")[1]);
    const row = await prisma.refreshSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(hashRefreshToken(token));
    expect(row.tokenHash).not.toContain(token);
  });

  it("logout ends only its own device", async () => {
    const user = await userWithPassword();
    const pc = await login(user.email);
    const phone = await login(user.email);
    const out = await http.request("POST", "/api/auth/logout", { token: pc.token, cookie: pc.cookie });
    expect(out.status).toBe(200);
    expect((await refresh(pc.cookie)).status).toBe(401);
    expect((await refresh(phone.cookie)).status).toBe(200);
  });

  it("ban and suspension end every device", async () => {
    const admin = await createUser({}, { role: "admin" });
    for (const revoke of [(id: string) => toggleUserBan(admin.id, id, true), (id: string) => suspendUser(admin.id, id, 1)]) {
      const user = await userWithPassword();
      const a = await login(user.email);
      const b = await login(user.email);
      await revoke(user.id);
      expect((await refresh(a.cookie)).status).toBe(401);
      expect((await refresh(b.cookie)).status).toBe(401);
      expect(await prisma.refreshSession.count({ where: { userId: user.id } })).toBe(0);
    }
  });

  it("a password change ends the other devices and keeps the current one", async () => {
    const user = await userWithPassword();
    const pc = await login(user.email);
    const phone = await login(user.email);
    const change = await http.request("POST", "/api/auth/change-password", {
      token: pc.token,
      body: { currentPassword: PASSWORD, newPassword: "Hunter!2026new" },
    });
    expect(change.status).toBe(200);
    expect((await refresh(phone.cookie)).status).toBe(401);
    expect((await refresh(pc.cookie)).status).toBe(401);
    expect((await refresh(change.cookie!)).status).toBe(200);
    expect(await prisma.refreshSession.count({ where: { userId: user.id } })).toBe(1);
  });
});
