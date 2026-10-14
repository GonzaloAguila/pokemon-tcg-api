/**
 * Regression tests for the 2026-10-14 account bugs:
 * - economy actions need a verified email (403 EMAIL_NOT_VERIFIED); OAuth accounts count as
 *   verified; login, profile reads and deck building stay open
 * - password reset and password change revoke existing sessions
 * - email verification is idempotent (a second click answers "already verified")
 */
import cookieParser from "cookie-parser";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { authRouter } from "../src/modules/auth/index.js";
import { usersRouter } from "../src/modules/users/index.js";
import { decksRouter } from "../src/modules/decks/index.js";
import { marketRouter } from "../src/modules/market/index.js";
import { wheelRouter } from "../src/modules/wheel/index.js";
import { generateVerificationToken } from "../src/modules/auth/auth.service.js";
import { createUser } from "./helpers.js";
import { tokenFor } from "./socket-helpers.js";
import { startHttpApp } from "./http-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  process.env.LOGIN_RATE_LIMIT_MAX = "100";
  http = await startHttpApp((app) => {
    app.use(cookieParser());
    app.use("/api/auth", authRouter);
    app.use("/api/users", usersRouter);
    app.use("/api/users", decksRouter);
    app.use("/api", marketRouter);
    app.use("/api", wheelRouter);
  });
});

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

const PASSWORD = "Hunter!2026abc";

async function userWithPassword() {
  const user = await createUser({ coins: 5000 }, { stats: true });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  return user;
}

async function login(email: string, password = PASSWORD) {
  const res = await http.request("POST", "/api/auth/login", { body: { email, password } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { token: res.body.accessToken as string, cookie: res.cookie! };
}

describe("economy actions need a verified email", () => {
  it("an unverified local account gets 403 EMAIL_NOT_VERIFIED on purchases, claims and spins", async () => {
    const user = await createUser({ coins: 5000 }, { emailVerified: false, stats: true });
    const token = tokenFor(user);
    for (const [method, path, body] of [
      ["POST", "/api/users/me/claim-daily-coins", undefined],
      ["POST", "/api/market/buy-energy", { energyType: "fire", quantity: 1 }],
      ["POST", "/api/wheel/spin", {}],
      ["POST", "/api/users/me/deck-slots/purchase", undefined],
    ] as const) {
      const res = await http.request(method, path, { token, body });
      expect(res.status, path).toBe(403);
      expect(res.body.error).toEqual({ code: "EMAIL_NOT_VERIFIED", message: "Verificá tu email para continuar" });
      expect(res.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED", message: "Verificá tu email para continuar" });
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).coins).toBe(5000);
  });

  it("profile reads and deck building stay open for unverified accounts", async () => {
    const user = await createUser({}, { emailVerified: false, stats: true });
    const token = tokenFor(user);
    expect((await http.request("GET", "/api/users/me", { token })).status).toBe(200);
    const deck = await http.request("POST", "/api/users/me/decks", {
      token,
      body: { name: "mazo", cards: [{ cardDefId: "base-set-058-pikachu", quantity: 4 }] },
    });
    expect(deck.status).toBe(201);
  });

  it("verified and OAuth accounts pass the gate", async () => {
    const verified = await createUser({}, { stats: true });
    const oauth = await createUser({}, { emailVerified: false, provider: "google", stats: true });
    for (const user of [verified, oauth]) {
      const res = await http.request("POST", "/api/users/me/claim-daily-coins", { token: tokenFor(user) });
      expect(res.status, JSON.stringify(res.body)).not.toBe(403);
    }
  });
});

describe("email verification is idempotent", () => {
  it("the second click answers alreadyVerified; an old used link is invalid", async () => {
    const user = await createUser({}, { emailVerified: false });
    await generateVerificationToken(user.id); // no RESEND_API_KEY in tests: logged, not sent
    const { verificationToken } = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    const first = await http.request("GET", `/api/auth/verify-email?token=${verificationToken}`);
    expect(first.status).toBe(200);
    expect(first.body.alreadyVerified).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBe(true);

    const second = await http.request("GET", `/api/auth/verify-email?token=${verificationToken}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ message: "Tu correo electronico ya estaba verificado", alreadyVerified: true });

    await prisma.user.update({ where: { id: user.id }, data: { verificationTokenExpiry: new Date(Date.now() - 1000) } });
    const stale = await http.request("GET", `/api/auth/verify-email?token=${verificationToken}`);
    expect(stale.status).toBe(400);
    expect((await http.request("GET", "/api/auth/verify-email?token=nope")).status).toBe(400);
  });
});

describe("password reset and change revoke sessions", () => {
  it("after a reset the old refresh cookie and access token stop working", async () => {
    const user = await userWithPassword();
    const old = await login(user.email);
    expect((await http.request("GET", "/api/users/me", { token: old.token })).status).toBe(200);

    expect((await http.request("POST", "/api/auth/forgot-password", { body: { email: user.email } })).status).toBe(200);
    const { resetToken } = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const reset = await http.request("POST", "/api/auth/reset-password", { body: { token: resetToken, newPassword: "Hunter!2026xyz" } });
    expect(reset.status).toBe(200);

    expect((await http.request("POST", "/api/auth/refresh", { cookie: old.cookie })).status).toBe(401);
    expect((await http.request("GET", "/api/users/me", { token: old.token })).status).toBe(401);
    // The reset link is single use
    expect((await http.request("POST", "/api/auth/reset-password", { body: { token: resetToken, newPassword: "Hunter!2026qqq" } })).status).toBe(400);
    await login(user.email, "Hunter!2026xyz");
  });

  it("a change revokes other sessions and returns fresh tokens for the current one", async () => {
    const user = await userWithPassword();
    const s = await login(user.email);
    const change = await http.request("POST", "/api/auth/change-password", {
      token: s.token,
      body: { currentPassword: PASSWORD, newPassword: "Hunter!2026new" },
    });
    expect(change.status).toBe(200);
    expect(typeof change.body.accessToken).toBe("string");
    expect(change.cookie).toMatch(/^refreshToken=/);

    expect((await http.request("GET", "/api/users/me", { token: s.token })).status).toBe(401);
    expect((await http.request("POST", "/api/auth/refresh", { cookie: s.cookie })).status).toBe(401);
    expect((await http.request("GET", "/api/users/me", { token: change.body.accessToken })).status).toBe(200);
    expect((await http.request("POST", "/api/auth/refresh", { cookie: change.cookie! })).status).toBe(200);
  });
});
