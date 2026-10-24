import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { adventureRouter } from "../src/modules/adventure/index.js";
import * as adventure from "../src/modules/adventure/adventure.service.js";
import { createUser, race } from "./helpers.js";
import { startHttpApp } from "./http-helpers.js";
import { tokenFor } from "./socket-helpers.js";

const ADVENTURE = "pueblo-paleta-bosque-verde";
let app: Awaited<ReturnType<typeof startHttpApp>>;

/** Rooms are the socket layer's (adventure-room.test.ts): here a host that only records calls. */
const ensured: string[] = [];
let available = true;

beforeAll(async () => {
  adventure.setAdventureBattleHost({ ensureRoom: async (runId) => { ensured.push(runId); }, isAvailable: () => available });
  app = await startHttpApp((a) => a.use("/api", adventureRouter));
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function player() {
  const user = await createUser();
  return { user, token: tokenFor(user) };
}

async function startRun(token: string, body: Record<string, unknown> = {}) {
  return app.request("POST", "/api/adventure/runs", {
    token,
    body: { adventureId: ADVENTURE, difficulty: "normal", starterId: "charmander", ...body },
  });
}

/** Put a run straight into a phase / battle (what the room and earlier battles would do). */
async function setRun(runId: string, data: Parameters<typeof prisma.adventureRun.update>[0]["data"]) {
  await prisma.adventureRun.update({ where: { id: runId }, data });
}

describe("auth", () => {
  it("every route needs a session", async () => {
    expect((await app.request("GET", "/api/adventures")).status).toBe(401);
    expect((await app.request("POST", "/api/adventure/runs", { body: {} })).status).toBe(401);
  });
});

describe("POST /api/adventure/runs", () => {
  it("creates a run without exposing the seed", async () => {
    const { user, token } = await player();
    const res = await startRun(token);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      adventureId: ADVENTURE,
      difficulty: "normal",
      starterId: "charmander",
      status: "active",
      phase: "pre_battle",
      currentBattle: 1,
      hearts: 3,
      maxHearts: 3,
      battle: null,
      currentBattleInfo: { index: 1, location: "Ruta 1", opponent: { name: "Lucas", trainerClass: "Joven" }, rules: [] },
    });
    expect(res.body).not.toHaveProperty("seed");
    expect(JSON.stringify(res.body)).not.toContain((await prisma.adventureRun.findFirstOrThrow({ where: { userId: user.id } })).seed);
    expect(await prisma.adventureProgress.findUnique({ where: { userId_adventureId: { userId: user.id, adventureId: ADVENTURE } } })).toMatchObject({ runsPlayed: 1 });
  });

  it("409 with an active run (also under concurrency), 404 for unknown ids, 400 for a bad body", async () => {
    const { user, token } = await player();
    const results = await race(4, () => startRun(token));
    const statuses = results.fulfilled.map((r) => r.value.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    expect(await prisma.adventureRun.count({ where: { userId: user.id } })).toBe(1);
    expect((await startRun(token)).body.error.message).toBe("Ya tienes una aventura en curso");

    const other = await player();
    expect((await startRun(other.token, { starterId: "pikachu" })).status).toBe(404);
    expect((await startRun(other.token, { adventureId: "gimnasio-plateado" })).status).toBe(404);
    expect((await startRun(other.token, { difficulty: "easy" })).status).toBe(400);
  });

  it("a finished run doesn't block a new one", async () => {
    const { token } = await player();
    const first = await startRun(token);
    expect((await app.request("POST", `/api/adventure/runs/${first.body.id}/abandon`, { token })).status).toBe(200);
    expect((await startRun(token, { starterId: "squirtle", difficulty: "hard" })).status).toBe(201);
  });
});

describe("GET runs", () => {
  it("active run or 404; another user's run is 404", async () => {
    const { token } = await player();
    expect((await app.request("GET", "/api/adventure/runs/active", { token })).status).toBe(404);
    const run = (await startRun(token)).body;
    const active = await app.request("GET", "/api/adventure/runs/active", { token });
    expect(active.status).toBe(200);
    expect(active.body.id).toBe(run.id);
    const byId = await app.request("GET", `/api/adventure/runs/${run.id}`, { token });
    expect(byId.status).toBe(200);
    expect(byId.body).not.toHaveProperty("seed");

    const stranger = await player();
    expect((await app.request("GET", `/api/adventure/runs/${run.id}`, { token: stranger.token })).status).toBe(404);
    expect((await app.request("GET", "/api/adventure/runs/not-a-uuid", { token })).status).toBe(404);
  });

  it("never sends the battle snapshot's state, only its room id", async () => {
    const { token } = await player();
    const run = (await startRun(token)).body;
    await setRun(run.id, { phase: "in_battle", battle: { roomId: "adv-abc", startedAt: new Date().toISOString(), state: { secret: true }, rngState: 7 } });
    const res = await app.request("GET", `/api/adventure/runs/${run.id}`, { token });
    expect(res.body.battle).toEqual({ roomId: "adv-abc" });
  });
});

describe("PATCH /api/adventure/runs/:id/deck", () => {
  it("edits in pre_battle; 422 under 20 cards; 409 outside pre_battle", async () => {
    const { token } = await player();
    const run = (await startRun(token)).body;
    const path = `/api/adventure/runs/${run.id}/deck`;
    const ok = await app.request("PATCH", path, {
      token,
      body: { remove: [{ cardId: "base-set-061-rattata", qty: 2 }], energies: [{ cardId: "base-set-098-fire-energy", qty: 10 }] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.deck.reduce((n: number, e: { qty: number }) => n + e.qty, 0)).toBe(21);

    const under = await app.request("PATCH", path, { token, body: { remove: [{ cardId: "base-set-098-fire-energy", qty: 2 }], energies: [] } });
    expect(under.status).toBe(422);
    expect(under.body.error.message).toBe("El mazo debe tener al menos 20 cartas (tiene 19)");

    const dce = await app.request("PATCH", path, { token, body: { remove: [], energies: [{ cardId: "base-set-096-double-colorless-energy", qty: 1 }] } });
    expect(dce.status).toBe(422);

    expect((await app.request("PATCH", path, { token, body: { remove: [{ cardId: "x", qty: 0 }], energies: [] } })).status).toBe(400);

    await setRun(run.id, { phase: "in_battle" });
    expect((await app.request("PATCH", path, { token, body: { remove: [], energies: [] } })).status).toBe(409);
  });
});

describe("POST /api/adventure/runs/:id/battle", () => {
  it("moves to in_battle and returns the same room while it lasts; 409 in another phase", async () => {
    const { token } = await player();
    const run = (await startRun(token)).body;
    const path = `/api/adventure/runs/${run.id}/battle`;
    const first = await app.request("POST", path, { token });
    expect(first.status).toBe(200);
    expect(first.body.roomId).toMatch(/^adv-[a-f0-9]{12}$/);
    expect((await app.request("POST", path, { token })).body.roomId).toBe(first.body.roomId);
    expect((await app.request("GET", `/api/adventure/runs/${run.id}`, { token })).body).toMatchObject({ phase: "in_battle", battle: { roomId: first.body.roomId } });
    expect(ensured.filter((id) => id === run.id)).toHaveLength(2);

    await setRun(run.id, { phase: "choosing_treasure", pendingOffer: ["t1-bill"], battle: undefined });
    expect((await app.request("POST", path, { token })).status).toBe(409);
  });

  it("503 while the server can't run battles; the run stays on the map", async () => {
    const { token } = await player();
    const run = (await startRun(token)).body;
    available = false;
    try {
      const res = await app.request("POST", `/api/adventure/runs/${run.id}/battle`, { token });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("ADVENTURE_UNAVAILABLE");
    } finally {
      available = true;
    }
    expect((await app.request("GET", `/api/adventure/runs/${run.id}`, { token })).body).toMatchObject({ phase: "pre_battle", battle: null });
  });
});

describe("POST /api/adventure/runs/:id/treasure", () => {
  it("takes an offered treasure, 422 for one not offered, 409 outside choosing_treasure", async () => {
    const { token } = await player();
    const run = (await startRun(token)).body;
    const path = `/api/adventure/runs/${run.id}/treasure`;
    expect((await app.request("POST", path, { token, body: { skip: true } })).status).toBe(409);

    await setRun(run.id, { phase: "choosing_treasure", pendingOffer: ["t1-bill", "t1-moneda", "t1-pociones"] });
    const notOffered = await app.request("POST", path, { token, body: { treasureId: "t1-energia" } });
    expect(notOffered.status).toBe(422);
    expect((await app.request("POST", path, { token, body: {} })).status).toBe(400);

    const taken = await app.request("POST", path, { token, body: { treasureId: "t1-moneda" } });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ phase: "pre_battle", currentBattle: 2, passives: ["lucky_coin"], treasuresTaken: ["t1-moneda"], pendingOffer: [] });
  });

  it("the run payload resolves the offer for the starter", async () => {
    const { token } = await player();
    const run = (await startRun(token, { starterId: "bulbasaur" })).body;
    await setRun(run.id, { phase: "choosing_treasure", pendingOffer: ["t1-evolucion"] });
    const res = await app.request("GET", `/api/adventure/runs/${run.id}`, { token });
    expect(res.body.offer).toEqual([
      {
        id: "t1-evolucion",
        name: "Pack de evolución",
        description: "+1 básico y +1 Stage 1 de tu inicial",
        rarity: "rare",
        kind: "cards",
        cards: [{ cardId: "base-set-044-bulbasaur", qty: 1 }, { cardId: "base-set-030-ivysaur", qty: 1 }],
      },
    ]);
  });

  it("a live run's offer from the previous content (Arranque rápido after battle 2) still shows and can be taken", async () => {
    const { token } = await player();
    const run = (await startRun(token)).body;
    await setRun(run.id, { phase: "choosing_treasure", currentBattle: 2, adventureVersion: 1, pendingOffer: ["t1-energia", "t1-bill", "t1-moneda"] });
    const view = await app.request("GET", `/api/adventure/runs/${run.id}`, { token });
    expect(view.body.offer.map((t: { id: string; rarity: string }) => [t.id, t.rarity])).toEqual([
      ["t1-energia", "epic"],
      ["t1-bill", "common"],
      ["t1-moneda", "common"],
    ]);
    const taken = await app.request("POST", `/api/adventure/runs/${run.id}/treasure`, { token, body: { treasureId: "t1-energia" } });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ currentBattle: 3, passives: ["start_attached_energy"], treasuresTaken: ["t1-energia"] });
  });
});

describe("POST /api/adventure/runs/:id/abandon", () => {
  it("abandons from the map; 409 inside a battle", async () => {
    const { token } = await player();
    const run = (await startRun(token)).body;
    await setRun(run.id, { phase: "in_battle" });
    expect((await app.request("POST", `/api/adventure/runs/${run.id}/abandon`, { token })).status).toBe(409);
    await setRun(run.id, { phase: "pre_battle" });
    const res = await app.request("POST", `/api/adventure/runs/${run.id}/abandon`, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "abandoned", phase: "finished" });
    expect(res.body.finishedAt).not.toBeNull();
    expect((await app.request("GET", "/api/adventure/runs/active", { token })).status).toBe(404);
  });
});

describe("applyRunBattleResult (server only)", () => {
  async function runInBattle(userId: string, battle: number, difficulty = "normal", starterId = "charmander") {
    const created = await adventure.createRun(userId, { adventureId: ADVENTURE, difficulty: difficulty as "normal", starterId });
    await setRun(created.id, { currentBattle: battle, phase: "in_battle", battle: { roomId: "adv-test", startedAt: new Date().toISOString() } });
    return created.id;
  }

  it("a victory stores the offer and the battle row, once", async () => {
    const { user } = await player();
    const runId = await runInBattle(user.id, 1);
    const result = { victory: true, reason: "prizes" as const, turns: 9 };
    const [a, b] = await Promise.all([adventure.applyRunBattleResult(runId, result), adventure.applyRunBattleResult(runId, result)]);
    const applied = [a, b].filter((r) => r !== null);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.run).toMatchObject({ phase: "choosing_treasure", battle: null });
    expect(applied[0]!.run.offer).toHaveLength(3);
    expect(await prisma.adventureBattleResult.findMany({ where: { runId } })).toMatchObject([
      { battleIndex: 1, attempt: 1, victory: true, reason: "prizes", turns: 9 },
    ]);
  });

  it("a defeat costs a heart; the next attempt is a new row", async () => {
    const { user } = await player();
    const runId = await runInBattle(user.id, 4);
    const lost = await adventure.applyRunBattleResult(runId, { victory: false, reason: "surrender", turns: 3 });
    expect(lost!.run).toMatchObject({ phase: "pre_battle", hearts: 2, heartsLost: 1, attempt: 2 });
    expect(lost!.events).toEqual([{ type: "heartLost", hearts: 2 }]);
  });

  it("winning battle 10 twice in the same difficulty grants the card back once", async () => {
    const { user } = await player();
    const first = await adventure.applyRunBattleResult(await runInBattle(user.id, 10), { victory: true, reason: "prizes", turns: 20 });
    expect(first!.run).toMatchObject({ status: "won", phase: "finished" });
    expect(first!.reward).toEqual({ type: "cosmetic", cosmeticType: "cardBack", id: "cardback-bosque-verde", name: "Dorso Bosque Verde" });
    const second = await adventure.applyRunBattleResult(await runInBattle(user.id, 10, "normal", "squirtle"), { victory: true, reason: "prizes", turns: 18 });
    expect(second!.reward).toBeNull();
    expect(await prisma.userCardBack.count({ where: { userId: user.id, cardBackId: "cardback-bosque-verde" } })).toBe(1);
    expect(await prisma.economyClaim.count({ where: { userId: user.id, kind: "adventure" } })).toBe(1);
    expect(await prisma.adventureProgress.findUniqueOrThrow({ where: { userId_adventureId: { userId: user.id, adventureId: ADVENTURE } } })).toMatchObject({
      clearsNormal: 2,
      clearsHard: 0,
      clearedStartersNormal: ["charmander", "squirtle"],
      runsPlayed: 2,
      flawlessClears: 2,
      puristClears: 2,
      monotypeClears: 2,
    });

    const hard = await adventure.applyRunBattleResult(await runInBattle(user.id, 10, "hard"), { victory: true, reason: "prizes", turns: 25 });
    expect(hard!.reward).toEqual({ type: "starter_unlock", id: "pikachu", name: "Pikachu como inicial" });
    expect(await prisma.userStarterUnlock.findMany({ where: { userId: user.id } })).toMatchObject([{ starterId: "pikachu" }]);
  });

  it("does nothing for a run that isn't in a battle", async () => {
    const { user } = await player();
    const run = await adventure.createRun(user.id, { adventureId: ADVENTURE, difficulty: "normal", starterId: "charmander" });
    expect(await adventure.applyRunBattleResult(run.id, { victory: true, reason: "prizes", turns: 5 })).toBeNull();
  });
});

describe("GET /api/adventures", () => {
  it("lists the adventure with the user's progress and active run", async () => {
    const { token } = await player();
    const empty = await app.request("GET", "/api/adventures", { token });
    expect(empty.status).toBe(200);
    expect(empty.body.map((a: { id: string }) => a.id)).toEqual([ADVENTURE, "ciudad-plateada-ciudad-celeste"]);
    expect(empty.body[0]).toMatchObject({
      id: ADVENTURE,
      name: "El Comienzo",
      battleCount: 10,
      progress: { clearsNormal: 0, clearsHard: 0, runsPlayed: 0 },
      rewards: { normal: { id: "cardback-bosque-verde", claimed: false }, hard: { id: "pikachu", claimed: false } },
      activeRun: null,
    });
    expect(empty.body[0].achievements.map((a: { id: string }) => a.id)).toContain("adventure-1-flawless");
    const run = (await startRun(token)).body;
    expect((await app.request("GET", "/api/adventures", { token })).body[0].activeRun).toMatchObject({ id: run.id, currentBattle: 1 });
  });

  it("detail: rival decks only of beaten battles, rules of beaten and current ones", async () => {
    const { token } = await player();
    const run = (await startRun(token)).body;
    await setRun(run.id, { currentBattle: 7 });
    const res = await app.request("GET", `/api/adventures/${ADVENTURE}`, { token });
    expect(res.status).toBe(200);
    const battles = res.body.battles as { index: number; rivalDeck: unknown; rules: string[] | null; beaten: boolean; current: boolean }[];
    expect(battles.filter((b) => b.rivalDeck !== null).map((b) => b.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(battles.filter((b) => b.rules !== null).map((b) => b.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(battles[6]).toMatchObject({ current: true, beaten: false });
    expect(battles[6].rules).toEqual([
      "Premios: tú 1, el rival 2",
      "Los Metapod del rival no dan premios",
      "El rival empieza con Metapod activo y Caterpie en la banca",
      "Empiezas con Pokémon Flute, Gust of Wind y PlusPower en la mano",
    ]);
    expect(JSON.stringify(battles.slice(6))).not.toContain("base-set-099-grass-energy");
    expect(res.body.starters.map((s: { id: string; locked: boolean }) => [s.id, s.locked])).toEqual([
      ["charmander", false], ["squirtle", false], ["bulbasaur", false],
    ]);
    const treasures = res.body.treasures as { id: string; rarity: string }[];
    expect(treasures.every((t) => ["common", "rare", "epic"].includes(t.rarity))).toBe(true);
    expect(treasures.find((t) => t.id === "t1-energia")?.rarity).toBe("epic");
    expect((await app.request("GET", "/api/adventures/nope", { token })).status).toBe(404);
  });

  it("difficulties: hearts and description per difficulty in the list; the detail adds their offer rules", async () => {
    const { token } = await player();
    const list = (await app.request("GET", "/api/adventures", { token })).body[0];
    expect(list.difficulties).toEqual({
      normal: { hearts: 3, description: expect.any(String) },
      hard: { hearts: 2, description: expect.any(String) },
    });
    const detail = (await app.request("GET", `/api/adventures/${ADVENTURE}`, { token })).body;
    expect(detail.difficulties.hard).toMatchObject({
      hearts: 2,
      treasureOffer: { rarityWeights: { common: 4, rare: 4, epic: 2 }, maxPassives: 1 },
      treasurePools: { tier1: expect.arrayContaining(["h1-kangaskhan"]) },
    });
    expect(detail.difficulties.normal.treasurePools.tier1).toContain("t1-pociones");
    // Without a run (or in a normal one) the top-level pools are the normal ones
    expect(detail.treasurePools.tier1).toContain("t1-pociones");
    const clearHard = detail.achievements.find((a: { id: string }) => a.id === "adventure-1-clear-hard");
    expect(clearHard).toMatchObject({ tier: "platinum", cosmetic: { type: "playmat", id: "playmat-ciudad-plateada", imageUrl: "/bg/bg-ciudad-plateada.jpg" } });
    expect(list.achievements.find((a: { id: string }) => a.id === "adventure-1-flawless").cosmetic).toBeNull();
  });

  it("a hard run: 2 hearts, the hard rules of its battles, the hard rival decks and pools", async () => {
    const { token } = await player();
    const created = await startRun(token, { difficulty: "hard", starterId: "squirtle" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ difficulty: "hard", hearts: 2, maxHearts: 2 });
    await setRun(created.body.id, { currentBattle: 5 });
    const run = (await app.request("GET", "/api/adventure/runs/active", { token })).body;
    expect(run.currentBattleInfo).toMatchObject({
      index: 5,
      rules: ["El rival juega con 2 premios", "El rival empieza con Potion en la mano", "El rival empieza con Venonat activo y Kakuna en la banca"],
      objective: "El rival gana con 2 premios: cuida a tus Pokémon.",
    });
    const detail = (await app.request("GET", `/api/adventures/${ADVENTURE}`, { token })).body;
    expect(detail.battles[4].rules).toEqual(run.currentBattleInfo.rules);
    expect(detail.battles[0].rules).toEqual([]);
    expect(detail.battles[4].objective).toBe(run.currentBattleInfo.objective);
    expect(detail.battles[0].rivalDeck).toContainEqual({ cardId: "base-set-040-raticate", qty: 2 });
    expect(detail.battles[1].rules).toEqual(["El rival empieza con Doduo activo y Pidgey y Jigglypuff en la banca"]);
    expect(detail.treasurePools.tier1).toContain("h1-kangaskhan");
    expect(detail.treasurePools.tier1).not.toContain("t1-pociones");
    expect(detail.battles[9].opponent.lead).toBe("base-set-044-bulbasaur");
  });

  it("detail without an active run shows no rival decks nor rules", async () => {
    const { token } = await player();
    const res = await app.request("GET", `/api/adventures/${ADVENTURE}`, { token });
    expect(res.body.battles.every((b: { rivalDeck: unknown; rules: unknown }) => b.rivalDeck === null && b.rules === null)).toBe(true);
    expect(res.body.battles[6].opponent).toEqual({ name: "Teo", trainerClass: "Cazabichos", lead: "base-set-054-metapod" });
  });
});

describe("adventure 2: entry cost, gym requirement, coins reward", () => {
  const ADV2 = "ciudad-plateada-ciudad-celeste";
  const REQUIREMENT = "Vence a Brock en su gimnasio para desbloquearla";
  const startAdv2 = (token: string, body: Record<string, unknown> = {}) => startRun(token, { adventureId: ADV2, ...body });
  const coinsOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).coins;
  const battleRow = () => ({ roomId: "adv-test", startedAt: new Date().toISOString() });

  async function playerWith(coins: number, medal = true) {
    const user = await createUser({ coins });
    if (medal) await prisma.userMedal.create({ data: { userId: user.id, medalId: "boulder" } });
    return { user, token: tokenFor(user) };
  }

  it("is locked without a Brock win and POST /adventure/runs answers 403 with the requirement text", async () => {
    const { user, token } = await playerWith(100, false);
    const res = await startAdv2(token);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(REQUIREMENT);
    expect(await coinsOf(user.id)).toBe(100);
    expect(await prisma.adventureRun.count({ where: { userId: user.id } })).toBe(0);
    const list = (await app.request("GET", "/api/adventures", { token })).body.find((a: { id: string }) => a.id === ADV2);
    expect(list.requirement).toEqual({ text: REQUIREMENT, met: false });
  });

  it("a boulder medal unlocks it; starting charges exactly 20 coins and logs the transaction", async () => {
    const { user, token } = await playerWith(100);
    const res = await startAdv2(token);
    expect(res.status).toBe(201);
    expect(await coinsOf(user.id)).toBe(80);
    expect(await prisma.transaction.findMany({ where: { userId: user.id, type: "adventure_entry" } })).toMatchObject([
      { amount: -20, currency: "coins", balanceAfter: 80 },
    ]);
    expect(res.body).toMatchObject({ stolen: [], cardsStolen: 0 });
    const list = (await app.request("GET", "/api/adventures", { token })).body.find((a: { id: string }) => a.id === ADV2);
    expect(list.requirement).toEqual({ text: REQUIREMENT, met: true });
  });

  it("an expert-only Brock series win (gym Match rows, no medal) unlocks it", async () => {
    const { user, token } = await playerWith(100, false);
    const gym = (game: number, challenger: number, leader: number) => ({
      leaderId: "brock", leaderName: "Brock", mode: "expert", game, bestOf: 3, score: { leader, challenger },
    });
    await prisma.match.create({ data: { mode: "gym", status: "finished", player1Id: user.id, gym: gym(2, 0, 2) } });
    expect((await startAdv2(token)).status).toBe(403);
    await prisma.match.create({ data: { mode: "gym", status: "finished", player1Id: user.id, gym: gym(2, 2, 0) } });
    expect((await startAdv2(token)).status).toBe(201);
  });

  it("with 19 coins the run is not created and no coins move", async () => {
    const { user, token } = await playerWith(19);
    const res = await startAdv2(token);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/monedas/i);
    expect(await coinsOf(user.id)).toBe(19);
    expect(await prisma.adventureRun.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.adventureProgress.count({ where: { userId: user.id } })).toBe(0);
  });

  it("adventure 1 stays free (coins unchanged)", async () => {
    const { user, token } = await playerWith(5, false);
    expect((await startRun(token)).status).toBe(201);
    expect(await coinsOf(user.id)).toBe(5);
  });

  it("GET /adventures lists El Comienzo first with entryCost 0 and requirement null, sorted by order", async () => {
    const { token } = await playerWith(0, false);
    const body = (await app.request("GET", "/api/adventures", { token })).body;
    expect(body.map((a: { id: string }) => a.id)).toEqual([ADVENTURE, ADV2]);
    expect(body[0]).toMatchObject({ order: 1, entryCost: 0, requirement: null, image: expect.stringMatching(/^\/adventures\//) });
    expect(body[1]).toMatchObject({ order: 2, entryCost: 20 });
    const detail = (await app.request("GET", `/api/adventures/${ADV2}`, { token })).body;
    expect(detail).toMatchObject({ order: 2, entryCost: 20, requirement: { met: false } });
    expect(detail.battles.every((b: { opponent: { sprite?: string } }) => typeof b.opponent.sprite === "string")).toBe(true);
  });

  it("the first hard clear credits 1000 coins once; a second hard clear credits nothing", async () => {
    const { user } = await playerWith(100);
    const hardWin = async () => {
      const created = await adventure.createRun(user.id, { adventureId: ADV2, difficulty: "hard", starterId: "squirtle" });
      await setRun(created.id, { currentBattle: 10, phase: "in_battle", battle: battleRow() });
      return adventure.applyRunBattleResult(created.id, { victory: true, reason: "prizes", turns: 20 });
    };
    const first = await hardWin();
    expect(first!.reward).toEqual({ type: "coins", amount: 1000, name: "1000 monedas" });
    expect(await coinsOf(user.id)).toBe(100 - 20 + 1000);
    expect(await prisma.transaction.count({ where: { userId: user.id, type: "adventure_reward" } })).toBe(1);
    const second = await hardWin();
    expect(second!.reward).toBeNull();
    expect(await coinsOf(user.id)).toBe(100 - 40 + 1000);
  });

  it("a defeat with Team Rocket reports the stolen cards in the result events and the run view", async () => {
    const { user } = await playerWith(100);
    const created = await adventure.createRun(user.id, { adventureId: ADV2, difficulty: "normal", starterId: "charmander" });
    await setRun(created.id, { currentBattle: 9, phase: "in_battle", battle: battleRow() });
    const lost = await adventure.applyRunBattleResult(created.id, { victory: false, reason: "prizes", turns: 8 });
    expect(lost!.events.find((e) => e.type === "stolen")).toBeDefined();
    expect(lost!.run.cardsStolen).toBeGreaterThan(0);
    expect(lost!.run.stolen.length).toBeGreaterThan(0);
  });

  it("a hard Pikachu offer after the major-pool battle has 3 options", async () => {
    const { user } = await playerWith(200);
    await prisma.userStarterUnlock.create({ data: { userId: user.id, starterId: "pikachu" } });
    for (let attempt = 0; attempt < 5; attempt++) {
      const created = await adventure.createRun(user.id, { adventureId: ADV2, difficulty: "hard", starterId: "pikachu" });
      await setRun(created.id, { currentBattle: 5, phase: "in_battle", seed: `seed-${attempt}`, battle: battleRow() });
      const won = await adventure.applyRunBattleResult(created.id, { victory: true, reason: "prizes", turns: 10 });
      expect(won!.run.offer).toHaveLength(3);
      await prisma.adventureRun.update({ where: { id: created.id }, data: { status: "abandoned", phase: "finished" } });
    }
  });
});
