import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { requireAuth, requireRole, optionalAuth } from "../src/middleware/auth.js";
import { clearAccountStateCache, invalidateAccountState } from "../src/lib/account-state.js";
import * as adminService from "../src/modules/admin/admin.service.js";
import { createUser } from "./helpers.js";
import { tokenFor } from "./socket-helpers.js";
import { startHttpApp } from "./http-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;

beforeAll(async () => {
  http = await startHttpApp((app) => {
    app.get("/me", requireAuth, (req, res) => res.json({ userId: req.user!.userId, role: req.user!.role }));
    app.get("/admin-only", requireAuth, requireRole("admin", "superadmin"), (_req, res) => res.json({ ok: true }));
    app.get("/optional", optionalAuth, (req, res) => res.json({ userId: req.user?.userId ?? null }));
  });
});

afterAll(async () => {
  await http.close();
  await prisma.$disconnect();
});

beforeEach(() => clearAccountStateCache());

describe("HTTP access tokens honor tokenVersion and account status", () => {
  it("a valid token works", async () => {
    const user = await createUser();
    const res = await http.request("GET", "/me", { token: tokenFor(user) });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(user.id);
  });

  it("missing or garbage tokens are 401", async () => {
    expect((await http.request("GET", "/me")).status).toBe(401);
    expect((await http.request("GET", "/me", { token: "not-a-jwt" })).status).toBe(401);
  });

  it("an admin ban revokes the access token immediately", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    expect((await http.request("GET", "/me", { token })).status).toBe(200); // now cached
    await adminService.toggleUserBan(user.id, true, "test");
    const res = await http.request("GET", "/me", { token });
    expect(res.status).toBe(401);
  });

  it("an admin suspension revokes the access token immediately", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    expect((await http.request("GET", "/me", { token })).status).toBe(200);
    await adminService.suspendUser(user.id, 1, "test");
    expect((await http.request("GET", "/me", { token })).status).toBe(401);
  });

  it("a tokenVersion bump made outside the app applies once the cache entry expires", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    expect((await http.request("GET", "/me", { token })).status).toBe(200);
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
    invalidateAccountState(user.id); // stands in for the short TTL
    const res = await http.request("GET", "/me", { token });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/Sesión invalidada/);
  });

  it("a deleted user's token is rejected", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    await prisma.user.delete({ where: { id: user.id } });
    expect((await http.request("GET", "/me", { token })).status).toBe(401);
  });

  it("a banned account whose tokenVersion wasn't bumped is still refused (403)", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: "banned" } });
    const res = await http.request("GET", "/me", { token: tokenFor(user) });
    expect(res.status).toBe(403);
  });

  it("role comes from the DB, so a demoted admin loses admin routes at once", async () => {
    const admin = await createUser();
    await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } });
    const token = tokenFor({ ...admin, role: "admin" });
    expect((await http.request("GET", "/admin-only", { token })).status).toBe(200);
    await adminService.setUserRole(admin.id, "user");
    expect((await http.request("GET", "/admin-only", { token })).status).toBe(403);
  });

  it("optionalAuth treats a revoked token as anonymous", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    expect((await http.request("GET", "/optional", { token })).body.userId).toBe(user.id);
    await adminService.toggleUserBan(user.id, true);
    expect((await http.request("GET", "/optional", { token })).body.userId).toBeNull();
  });
});
