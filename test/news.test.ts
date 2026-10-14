import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { newsRouter } from "../src/modules/news/news.controller.js";
import { adminRouter } from "../src/modules/admin/admin.controller.js";
import { newsStatus, toExcerpt } from "../src/modules/news/news.service.js";
import { createUser } from "./helpers.js";
import { tokenFor } from "./socket-helpers.js";
import { startHttpApp } from "./http-helpers.js";

let http: Awaited<ReturnType<typeof startHttpApp>>;
let superadminToken: string;
let moderatorToken: string;
let moderatorId: string;
let otherAdminToken: string;
let userToken: string;

const HOUR = 60 * 60 * 1000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);

beforeAll(async () => {
  http = await startHttpApp((app) => {
    app.use("/api", adminRouter);
    app.use("/api", newsRouter);
  });
  const superadmin = await createUser({}, { role: "superadmin" });
  // Moderator: an admin whose only permission is "news"
  const moderator = await prisma.user.update({
    where: { id: (await createUser({}, { role: "admin" })).id },
    data: { permissions: ["news"] },
  });
  const otherAdmin = await prisma.user.update({
    where: { id: (await createUser({}, { role: "admin" })).id },
    data: { permissions: ["messages:send", "users:view"] },
  });
  const user = await createUser();
  superadminToken = tokenFor(superadmin);
  moderatorToken = tokenFor(moderator);
  moderatorId = moderator.id;
  otherAdminToken = tokenFor(otherAdmin);
  userToken = tokenFor(user);
});

beforeEach(async () => {
  await prisma.newsPost.deleteMany();
});

afterAll(async () => {
  await prisma.newsPost.deleteMany();
  await http.close();
  await prisma.$disconnect();
});

const asModerator = (method: string, path: string, body?: unknown) =>
  http.request(method, path, { token: moderatorToken, body });

/** Insert a post directly (dates in the past/future without waiting). */
function seedPost(data: Partial<Parameters<typeof prisma.newsPost.create>[0]["data"]> & { title: string }) {
  return prisma.newsPost.create({
    data: { body: "Texto", publishedAt: new Date(Date.now() - HOUR), authorId: moderatorId, ...data },
  });
}

describe("news permissions", () => {
  it("public endpoints need no token", async () => {
    await seedPost({ title: "Hola" });
    const list = await http.request("GET", "/api/news");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect((await http.request("GET", "/api/news/carousel")).status).toBe(200);
  });

  it("a moderator (only the news permission) can manage posts", async () => {
    const created = await asModerator("POST", "/api/admin/news", { title: "Mantenimiento", body: "Hoy 22 h" });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("draft");
    expect(created.body.authorUsername).toMatch(/^test_/);
    expect((await asModerator("GET", "/api/admin/news")).body.total).toBe(1);
    expect((await asModerator("PATCH", `/api/admin/news/${created.body.id}`, { published: true })).body.status).toBe("published");
    expect((await asModerator("DELETE", `/api/admin/news/${created.body.id}`)).status).toBe(200);
    expect(await prisma.newsPost.count()).toBe(0);
  });

  it("a moderator can't reach other admin endpoints", async () => {
    expect((await asModerator("GET", "/api/admin/users")).status).toBe(403);
    expect((await asModerator("GET", "/api/admin/stats")).status).toBe(403);
  });

  it("users, admins without the permission and anonymous callers are rejected", async () => {
    const post = await seedPost({ title: "x" });
    for (const token of [userToken, otherAdminToken]) {
      expect((await http.request("GET", "/api/admin/news", { token })).status).toBe(403);
      expect((await http.request("POST", "/api/admin/news", { token, body: { title: "a", body: "b" } })).status).toBe(403);
      expect((await http.request("PATCH", `/api/admin/news/${post.id}`, { token, body: { title: "z" } })).status).toBe(403);
      expect((await http.request("DELETE", `/api/admin/news/${post.id}`, { token })).status).toBe(403);
    }
    expect((await http.request("GET", "/api/admin/news")).status).toBe(401);
    expect((await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } })).title).toBe("x");
  });

  it("superadmin is always allowed", async () => {
    const res = await http.request("POST", "/api/admin/news", { token: superadminToken, body: { title: "a", body: "b" } });
    expect(res.status).toBe(201);
  });

  it("the news permission can be granted through the admin permissions endpoint", async () => {
    const admin = await createUser({}, { role: "admin" });
    const res = await http.request("PATCH", `/api/admin/users/${admin.id}/permissions`, {
      token: superadminToken,
      body: { permissions: ["news"] },
    });
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).permissions).toEqual(["news"]);
  });
});

describe("public ordering, pinning and expiry", () => {
  it("lists active pins first, then newest; drafts and expired posts are hidden", async () => {
    await seedPost({ title: "old", publishedAt: new Date(Date.now() - 5 * HOUR) });
    await seedPost({ title: "new", publishedAt: new Date(Date.now() - HOUR) });
    await seedPost({ title: "pinned-old", pinned: true, publishedAt: new Date(Date.now() - 10 * HOUR) });
    await seedPost({ title: "pin-expired", pinned: true, pinnedUntil: inHours(-1), publishedAt: new Date(Date.now() - 2 * HOUR) });
    await seedPost({ title: "pin-until-later", pinned: true, pinnedUntil: inHours(5), publishedAt: new Date(Date.now() - 3 * HOUR) });
    await seedPost({ title: "draft", publishedAt: null });
    await seedPost({ title: "expired", expiresAt: inHours(-1) });

    const res = await http.request("GET", "/api/news");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.data.map((p: { title: string }) => p.title)).toEqual([
      "pin-until-later",
      "pinned-old",
      "new",
      "pin-expired",
      "old",
    ]);
    expect(res.body.data.map((p: { pinned: boolean }) => p.pinned)).toEqual([true, true, false, false, false]);
    expect(res.body.data[0]).not.toHaveProperty("body");
    expect(res.body.data[0].excerpt).toBe("Texto");
  });

  it("pages pins and the rest as one list", async () => {
    for (let i = 0; i < 3; i++) await seedPost({ title: `pin${i}`, pinned: true, publishedAt: new Date(Date.now() - (i + 1) * HOUR) });
    for (let i = 0; i < 4; i++) await seedPost({ title: `post${i}`, publishedAt: new Date(Date.now() - (i + 1) * HOUR) });
    const titles = async (page: number) =>
      (await http.request("GET", `/api/news?page=${page}&limit=2`)).body.data.map((p: { title: string }) => p.title);
    expect(await titles(1)).toEqual(["pin0", "pin1"]);
    expect(await titles(2)).toEqual(["pin2", "post0"]);
    expect(await titles(3)).toEqual(["post1", "post2"]);
    expect(await titles(4)).toEqual(["post3"]);
    expect(await titles(5)).toEqual([]);
  });

  it("caps the public page size at 10", async () => {
    for (let i = 0; i < 12; i++) await seedPost({ title: `p${i}` });
    const res = await http.request("GET", "/api/news?limit=500");
    expect(res.body.limit).toBe(10);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.total).toBe(12);
  });

  it("detail returns the body only while the post is published and not expired", async () => {
    const visible = await seedPost({ title: "ok", body: "**Hola** mundo" });
    const draft = await seedPost({ title: "draft", publishedAt: null });
    const expired = await seedPost({ title: "expired", expiresAt: inHours(-1) });
    const res = await http.request("GET", `/api/news/${visible.id}`);
    expect(res.status).toBe(200);
    expect(res.body.body).toBe("**Hola** mundo");
    expect(res.body.excerpt).toBe("Hola mundo");
    expect((await http.request("GET", `/api/news/${draft.id}`)).status).toBe(404);
    expect((await http.request("GET", `/api/news/${expired.id}`)).status).toBe(404);
    expect((await http.request("GET", "/api/news/does-not-exist")).status).toBe(404);
  });

  it("carousel only has visible showInCarousel posts, pins first, linking to the CTA or the post", async () => {
    const plain = await seedPost({ title: "plain", showInCarousel: true, publishedAt: new Date(Date.now() - HOUR) });
    await seedPost({ title: "cta", showInCarousel: true, ctaLabel: "Abrir sobres", ctaHref: "/packs", pinned: true, publishedAt: new Date(Date.now() - 2 * HOUR) });
    await seedPost({ title: "not-in-carousel" });
    await seedPost({ title: "draft", showInCarousel: true, publishedAt: null });
    await seedPost({ title: "expired", showInCarousel: true, expiresAt: inHours(-1) });
    const res = await http.request("GET", "/api/news/carousel");
    expect(res.body.items.map((i: { title: string }) => i.title)).toEqual(["cta", "plain"]);
    expect(res.body.items[0]).toMatchObject({ href: "/packs", ctaLabel: "Abrir sobres" });
    expect(res.body.items[1]).toMatchObject({ href: `/news/${plain.id}`, ctaLabel: null });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(["category", "ctaLabel", "excerpt", "href", "id", "title"]);
  });

  it("admin list shows every post with its status", async () => {
    await seedPost({ title: "draft", publishedAt: null });
    await seedPost({ title: "pub" });
    await seedPost({ title: "pin", pinned: true });
    await seedPost({ title: "exp", expiresAt: inHours(-1), pinned: true });
    const res = await asModerator("GET", "/api/admin/news");
    const statuses = Object.fromEntries(res.body.data.map((p: { title: string; status: string }) => [p.title, p.status]));
    expect(statuses).toEqual({ draft: "draft", pub: "published", pin: "pinned", exp: "expired" });
    expect(res.body).toMatchObject({ total: 4, page: 1, limit: 10 });
  });
});

describe("publishing and notify", () => {
  it("publishing with notify creates one broadcast linking to the post", async () => {
    const created = await asModerator("POST", "/api/admin/news", {
      title: "Mantenimiento hoy 22 h",
      body: "Vamos a **actualizar** el servidor.",
      category: "maintenance",
      published: true,
      notify: true,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "published", notified: true });
    const messages = await prisma.systemMessage.findMany({ where: { metadata: { path: ["newsId"], equals: created.body.id } } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "broadcast", category: "maintenance", title: "Mantenimiento hoy 22 h", senderId: moderatorId });
    expect(messages[0].metadata).toEqual({ newsId: created.body.id, href: `/news/${created.body.id}` });
    expect(messages[0].content).toContain("Vamos a **actualizar** el servidor.");

    // Asking again doesn't send a second one
    await asModerator("PATCH", `/api/admin/news/${created.body.id}`, { notify: true, title: "Mantenimiento 23 h" });
    expect(await prisma.systemMessage.count({ where: { metadata: { path: ["newsId"], equals: created.body.id } } })).toBe(1);

    // Deleting the post removes its broadcast
    await asModerator("DELETE", `/api/admin/news/${created.body.id}`);
    expect(await prisma.systemMessage.count({ where: { id: messages[0].id } })).toBe(0);
  });

  it("non-maintenance categories notify as news; notify on a draft is rejected", async () => {
    const draft = await asModerator("POST", "/api/admin/news", { title: "Evento", body: "Finde", category: "event", notify: true });
    expect(draft.status).toBe(400);
    expect(await prisma.newsPost.count()).toBe(0);

    const created = await asModerator("POST", "/api/admin/news", { title: "Evento", body: "Finde", category: "event" });
    const published = await asModerator("PATCH", `/api/admin/news/${created.body.id}`, { published: true, notify: true });
    expect(published.body.notified).toBe(true);
    const message = await prisma.systemMessage.findFirstOrThrow({ where: { metadata: { path: ["newsId"], equals: created.body.id } } });
    expect(message.category).toBe("news");
  });

  it("a long body is sent to Mensajes as an excerpt that fits the message", async () => {
    const created = await asModerator("POST", "/api/admin/news", {
      title: "Largo",
      body: "palabra ".repeat(1250),
      published: true,
      notify: true,
    });
    expect(created.status).toBe(201);
    const message = await prisma.systemMessage.findFirstOrThrow({ where: { metadata: { path: ["newsId"], equals: created.body.id } } });
    expect(message.content.length).toBeLessThanOrEqual(2000);
    expect(message.content.endsWith("…")).toBe(true);
  });

  it("re-publishing keeps the original date; unpublishing makes it a draft", async () => {
    const created = await asModerator("POST", "/api/admin/news", { title: "a", body: "b", published: true });
    const firstDate = created.body.publishedAt;
    expect((await asModerator("PATCH", `/api/admin/news/${created.body.id}`, { published: true })).body.publishedAt).toBe(firstDate);
    const unpublished = await asModerator("PATCH", `/api/admin/news/${created.body.id}`, { published: false });
    expect(unpublished.body).toMatchObject({ status: "draft", publishedAt: null });
  });

  it("pinning with pinnedUntil and expiry through PATCH", async () => {
    const created = await asModerator("POST", "/api/admin/news", { title: "a", body: "b", published: true });
    const id = created.body.id;
    const pinned = await asModerator("PATCH", `/api/admin/news/${id}`, { pinned: true, pinnedUntil: inHours(2).toISOString() });
    expect(pinned.body.status).toBe("pinned");
    expect((await http.request("GET", "/api/news")).body.data[0]).toMatchObject({ id, pinned: true });
    const expired = await asModerator("PATCH", `/api/admin/news/${id}`, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(expired.body.status).toBe("expired");
    expect((await http.request("GET", "/api/news")).body.total).toBe(0);
    expect((await http.request("GET", `/api/news/${id}`)).status).toBe(404);
    const revived = await asModerator("PATCH", `/api/admin/news/${id}`, { expiresAt: null, pinnedUntil: null });
    expect(revived.body.status).toBe("pinned");
  });
});

describe("validation", () => {
  const valid = { title: "Título", body: "Texto" };

  it.each([
    [{ ...valid, title: "" }],
    [{ ...valid, title: "   " }],
    [{ ...valid, title: "t".repeat(121) }],
    [{ ...valid, body: "" }],
    [{ ...valid, body: "b".repeat(10_001) }],
    [{ ...valid, category: "forum" }],
    [{ ...valid, pinned: "true" }],
    [{ ...valid, expiresAt: "mañana" }],
    [{ ...valid, pinnedUntil: 12345 }],
    [{ ...valid, ctaLabel: "Ir", ctaHref: "https://evil.example" }],
    [{ ...valid, ctaLabel: "Ir", ctaHref: "//evil" }],
    [{ ...valid, ctaLabel: "Ir", ctaHref: "/Packs" }],
    [{ ...valid, ctaLabel: "Ir", ctaHref: "javascript:alert(1)" }],
    [{ ...valid, ctaLabel: "Ir", ctaHref: "/packs?x=1" }],
    [{ ...valid, ctaLabel: "Ir" }],
    [{ ...valid, ctaHref: "/packs" }],
    [{ ...valid, ctaLabel: "x".repeat(41), ctaHref: "/packs" }],
    [{ ...valid, authorId: "someone-else" }],
    [{ title: "solo título" }],
  ])("create rejects %j", async (body) => {
    const res = await asModerator("POST", "/api/admin/news", body);
    expect(res.status).toBe(400);
    expect(await prisma.newsPost.count()).toBe(0);
  });

  it("accepts limits, trims text, and treats empty CTA fields as none", async () => {
    const res = await asModerator("POST", "/api/admin/news", {
      title: `  ${"t".repeat(120)}  `,
      body: "b".repeat(10_000),
      category: "update",
      ctaLabel: "",
      ctaHref: "",
      expiresAt: "2030-01-01T03:00:00.000Z",
      pinnedUntil: "2029-12-31T22:00:00-03:00",
    });
    expect(res.status).toBe(201);
    expect(res.body.title).toHaveLength(120);
    expect(res.body).toMatchObject({ ctaLabel: null, ctaHref: null, category: "update" });
    expect(res.body.pinnedUntil).toBe("2030-01-01T01:00:00.000Z");
  });

  it("valid internal CTA paths", async () => {
    for (const href of ["/", "/packs", "/news/abc-123", "/market/coins", "/sets/team_rocket"]) {
      const res = await asModerator("POST", "/api/admin/news", { ...valid, ctaLabel: "Ir", ctaHref: href });
      expect(res.status, href).toBe(201);
    }
  });

  it("PATCH validates partial bodies and the merged CTA", async () => {
    const created = await asModerator("POST", "/api/admin/news", { ...valid, ctaLabel: "Ir", ctaHref: "/packs" });
    const url = `/api/admin/news/${created.body.id}`;
    expect((await asModerator("PATCH", url, {})).status).toBe(400);
    expect((await asModerator("PATCH", url, { ctaHref: null })).status).toBe(400);
    expect((await asModerator("PATCH", url, { title: "" })).status).toBe(400);
    expect((await asModerator("PATCH", url, { unknown: 1 })).status).toBe(400);
    expect((await asModerator("PATCH", url, { ctaHref: null, ctaLabel: null })).status).toBe(200);
    expect((await asModerator("PATCH", "/api/admin/news/missing", { title: "a" })).status).toBe(404);
    expect((await asModerator("DELETE", "/api/admin/news/missing")).status).toBe(404);
  });
});

describe("helpers", () => {
  it("toExcerpt strips markdown-lite and cuts at a word", () => {
    expect(toExcerpt("**Nueva** *expansión*\n__ya__ disponible")).toBe("Nueva expansión ya disponible");
    const long = toExcerpt("palabra ".repeat(50), 30);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(31);
  });

  it("newsStatus", () => {
    const now = new Date();
    const base = { publishedAt: new Date(now.getTime() - HOUR), expiresAt: null, pinned: false, pinnedUntil: null };
    expect(newsStatus({ ...base, publishedAt: null }, now)).toBe("draft");
    expect(newsStatus(base, now)).toBe("published");
    expect(newsStatus({ ...base, pinned: true }, now)).toBe("pinned");
    expect(newsStatus({ ...base, pinned: true, pinnedUntil: new Date(now.getTime() - 1) }, now)).toBe("published");
    expect(newsStatus({ ...base, pinned: true, expiresAt: now }, now)).toBe("expired");
  });
});
