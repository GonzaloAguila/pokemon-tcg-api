/**
 * Admin-configured draft prizes (DraftConfig.rewards): validation (zod + socket), who gets what
 * (every finisher + their place, nothing for players who left), and the payout at the end of
 * the tournament: coins with a transaction row, packs in "Mis sobres", cosmetics, a message,
 * exactly once per player even when it runs again or concurrently.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { clearAccountStateCache } from "../src/lib/account-state.js";
import { draftSchemas, parsePayload } from "../src/socket/schemas.js";
import { DraftRoomManager, type DraftRoom } from "../src/socket/draft-rooms.js";
import { draftGameWasPlayed, draftRewardExclusions, rewardsForPosition, type DraftRewardTier } from "../src/socket/draft-rewards.js";
import { payDraftPrize, payDraftPrizes } from "../src/socket/draft-payout.js";
import { draftRoomManager } from "../src/socket/draft-handlers.js";
import { createUser, getBalances } from "./helpers.js";
import { nextEvent, startSocketServer, tokenFor } from "./socket-helpers.js";

/** The owner's example: everyone a coin, 2nd 1000 coins + 2 Jungle, 1st 1500 + 2 Jungle + 2 Fossil. */
const OWNER_EXAMPLE: DraftRewardTier[] = [
  { target: "all", items: [{ type: "coin", id: "charizard" }] },
  { target: { place: 2 }, coins: 1000, packs: [{ setId: "jungle", quantity: 2 }] },
  {
    target: { place: 1 },
    coins: 1500,
    packs: [
      { setId: "jungle", quantity: 2 },
      { setId: "fossil", quantity: 2 },
    ],
  },
];

const parseCreate = (config: Record<string, unknown>) => parsePayload(draftSchemas.create, { config });

describe("validation", () => {
  it("accepts the owner's example and a free draft with only these prizes", () => {
    const res = parseCreate({ maxPlayers: 8, entryFee: 0, rewards: OWNER_EXAMPLE });
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.config?.rewards).toEqual(OWNER_EXAMPLE);
  });

  it.each([
    ["an unknown set", [{ target: "all", packs: [{ setId: "neo-genesis", quantity: 1 }] }], /Datos inválidos/],
    ["too many packs of a set", [{ target: "all", packs: [{ setId: "jungle", quantity: 21 }] }], /Datos inválidos/],
    ["too many coins", [{ target: { place: 1 }, coins: 100_001 }], /Datos inválidos/],
    ["negative coins", [{ target: { place: 1 }, coins: -5 }], /Datos inválidos/],
    ["an empty prize", [{ target: { place: 1 } }], "Hay un premio vacío: agrégale monedas, sobres o cosméticos"],
    ["the same set twice", [{ target: { place: 1 }, packs: [{ setId: "jungle", quantity: 1 }, { setId: "jungle", quantity: 2 }] }], "Un premio repite la expansión de un sobre"],
    ["a free cosmetic (Eevee coin)", [{ target: "all", items: [{ type: "coin", id: "eevee" }] }], "Cosmético que no se puede regalar: eevee"],
    ["an unknown skin", [{ target: "all", items: [{ type: "skin", id: "missingno-gold" }] }], "Cosmético que no se puede regalar: missingno-gold"],
    ["two prizes for everyone", [{ target: "all", coins: 1 }, { target: "all", coins: 2 }], "Solo puede haber un premio para todos los participantes"],
    ["overlapping places", [{ target: { place: 2 }, coins: 1 }, { target: { from: 2, to: 4 }, coins: 1 }], "El 2.º puesto tiene más de un premio"],
    ["a reversed range", [{ target: { from: 4, to: 2 }, coins: 1 }], "Un rango de puestos está al revés"],
    ["a place past 8", [{ target: { place: 9 }, coins: 1 }], /Datos inválidos/],
    ["13 tiers", Array.from({ length: 13 }, (_, i) => ({ target: { place: (i % 8) + 1 }, coins: 1 })), /Datos inválidos/],
  ])("rejects %s", (_name, rewards, error) => {
    const res = parseCreate({ maxPlayers: 8, rewards });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(error);
  });

  it("places must exist in this draft (maxPlayers)", () => {
    const res = parseCreate({ maxPlayers: 4, rewards: [{ target: { from: 3, to: 5 }, coins: 100 }] });
    expect(res).toEqual({ ok: false, error: "El 5.º puesto no existe en un draft de 4 jugadores" });
    expect(parseCreate({ rewards: [{ target: { place: 8 }, coins: 100 }] }).ok).toBe(true); // default 8 players
  });
});

describe("who gets what", () => {
  it("everyone the 'all' prize plus their place's; a player who left nothing", () => {
    expect(rewardsForPosition(OWNER_EXAMPLE, 1, false)).toEqual({
      coins: 1500,
      packs: [
        { setId: "jungle", quantity: 2 },
        { setId: "fossil", quantity: 2 },
      ],
      items: [{ type: "coin", id: "charizard" }],
    });
    expect(rewardsForPosition(OWNER_EXAMPLE, 2, false)).toEqual({
      coins: 1000,
      packs: [{ setId: "jungle", quantity: 2 }],
      items: [{ type: "coin", id: "charizard" }],
    });
    expect(rewardsForPosition(OWNER_EXAMPLE, 5, false)).toEqual({ coins: 0, packs: [], items: [{ type: "coin", id: "charizard" }] });
    expect(rewardsForPosition(OWNER_EXAMPLE, 1, true)).toEqual({ coins: 0, packs: [], items: [] });
  });

  it("packs of the same set in 'all' and a place add up; ranges cover every place in them", () => {
    const tiers: DraftRewardTier[] = [
      { target: "all", packs: [{ setId: "jungle", quantity: 1 }] },
      { target: { from: 3, to: 4 }, coins: 200, packs: [{ setId: "jungle", quantity: 1 }] },
    ];
    expect(rewardsForPosition(tiers, 4, false)).toEqual({ coins: 200, packs: [{ setId: "jungle", quantity: 2 }], items: [] });
    expect(rewardsForPosition(tiers, 5, false)).toEqual({ coins: 0, packs: [{ setId: "jungle", quantity: 1 }], items: [] });
  });
});

describe("who counts for the admin's prizes", () => {
  it("a game counts once it left the opening (turn 1); a no-show's game never does", () => {
    expect(draftGameWasPlayed({ turnNumber: 0 })).toBe(false);
    expect(draftGameWasPlayed(null)).toBe(false);
    expect(draftGameWasPlayed({ turnNumber: 1 })).toBe(true);
  });

  it("excludes who left, the admin's seat and players with only byes / walkovers / unplayed games", () => {
    const standings = ["adm", "a", "b", "c", "d", "e"].map((playerId) => ({ playerId, withdrawn: playerId === "e" }));
    const r = (player1Id: string, player2Id: string, extra: { isBye?: boolean; walkover?: boolean; played?: boolean } = {}) => ({
      player1Id, player2Id, isBye: false, walkover: false, ...extra,
    });
    const excluded = draftRewardExclusions(
      standings,
      [r("adm", "a"), r("b", "c", { walkover: true }), r("c", "d", { played: false }), r("b", "e"), r("d", "d", { isBye: true })],
      "adm",
    );
    expect([...excluded].sort()).toEqual(["adm", "c", "d", "e"]);
  });
});

describe("socket: only draft admins set prizes", () => {
  let server: Awaited<ReturnType<typeof startSocketServer>>;
  beforeAll(async () => {
    server = await startSocketServer();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => clearAccountStateCache());

  it("a player can't create a draft with prizes; an admin gets the reason for bad ones and creates good ones", async () => {
    const player = await createUser();
    const ps = await server.connect(tokenFor(player));
    ps.emit("draft:create", { config: { adminPlays: false, rewards: OWNER_EXAMPLE } });
    expect((await nextEvent<{ message: string }>(ps, "draft:error")).message).toBe("Solo los administradores pueden crear salas de draft");

    // Running drafts (rooms:close) isn't enough: prizes are economy grants (users:economy)
    const roomsAdmin = await createUser({}, { role: "admin", permissions: ["rooms:close"] });
    const rs = await server.connect(tokenFor(roomsAdmin));
    rs.emit("draft:create", { config: { adminPlays: false, rewards: OWNER_EXAMPLE } });
    expect((await nextEvent<{ message: string }>(rs, "draft:error")).message).toBe("No tienes permiso para dar premios");
    expect(draftRoomManager.getAllRooms().some((r) => r.adminId === roomsAdmin.id)).toBe(false);
    rs.emit("draft:create", { config: { adminPlays: false } }); // without prizes they still can
    const plain = await nextEvent<{ roomId: string }>(rs, "draft:created");
    draftRoomManager.deleteRoom(plain.roomId, roomsAdmin.id, true);

    const admin = await createUser({}, { role: "admin", permissions: ["rooms:close", "users:economy"] });
    const as = await server.connect(tokenFor(admin));
    as.emit("draft:create", { config: { adminPlays: false, maxPlayers: 4, rewards: [{ target: { place: 6 }, coins: 10 }] } });
    expect((await nextEvent<{ message: string }>(as, "draft:error")).message).toBe("El 6.º puesto no existe en un draft de 4 jugadores");

    as.emit("draft:create", { config: { adminPlays: false, entryFee: 0, rewards: OWNER_EXAMPLE } });
    const { roomId } = await nextEvent<{ roomId: string }>(as, "draft:created");
    const created = draftRoomManager.getRoom(roomId)!;
    expect(created.config.rewards).toEqual(OWNER_EXAMPLE);
    // The admin log row: who, which room, every tier
    const log = await prisma.systemMessage.findUniqueOrThrow({ where: { id: created.rewardsLogId! } });
    expect(log).toMatchObject({ senderId: admin.id, recipientId: admin.id, title: `Draft ${roomId} creado con premios` });
    expect(log.metadata).toMatchObject({ kind: "draft_rewards", draftRoomId: roomId, adminId: admin.id, tiers: OWNER_EXAMPLE });
    // The lobby list shows them to everyone
    expect(draftRoomManager.getAvailableRooms().find((r) => r.id === roomId)!.config.rewards).toEqual(OWNER_EXAMPLE);
    draftRoomManager.deleteRoom(roomId, admin.id, true);

    // Without prizes the config carries an empty list
    as.emit("draft:create", { config: { adminPlays: false } });
    const second = await nextEvent<{ roomId: string }>(as, "draft:created");
    expect(draftRoomManager.getRoom(second.roomId)!.config.rewards).toEqual([]);
    draftRoomManager.deleteRoom(second.roomId, admin.id, true);
  });
});

describe("payout at the end of the tournament", () => {
  const managers: DraftRoomManager[] = [];
  afterEach(() => {
    for (const m of managers) {
      for (const id of [...(m as unknown as { rooms: Map<string, DraftRoom> }).rooms.keys()]) {
        try { m.deleteRoom(id, "", true); } catch { /* already gone */ }
      }
    }
    managers.length = 0;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * An 8-player tournament with `rewards` where the lower seat always wins; seat 7 leaves after
   * round 1. `adminPlays`: the admin is seat 0. `noShowSeat`: every game of that seat never
   * leaves the opening (an AFK account), though it still wins or loses them.
   */
  async function playTournament(
    rewards: DraftRewardTier[],
    entryFee = 0,
    { adminPlays = false, noShowSeat = -1 }: { adminPlays?: boolean; noShowSeat?: number } = {},
  ) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const admin = await createUser({}, { role: "admin" });
    const users = [...(adminPlays ? [admin] : []), ...(await Promise.all(Array.from({ length: adminPlays ? 7 : 8 }, () => createUser())))];
    const manager = new DraftRoomManager();
    managers.push(manager);
    const room = manager.createRoom({ adminPlays, entryFee, rewards }, admin.id, "admin-sock", "Admin");
    users.forEach((u, i) => (adminPlays && i === 0 ? undefined : manager.joinRoom(room.id, u.id, `s${i}`, `P${i}`)));
    room.prizePool = entryFee * users.length;
    for (const p of room.players) p.deck = [];
    (manager as unknown as { startTournament(r: DraftRoom): void }).startTournament(room);
    const seat = (id: string) => users.findIndex((u) => u.id === id);

    let game = 0;
    const registerRound = () => {
      const round = room.tournament!.rounds.find((r) => r.roundNumber === room.tournament!.currentRoundNumber)!;
      for (const pairing of round.pairings) {
        if (manager.isMatchDecided(room.id, round.roundNumber, pairing.matchNumber)) continue;
        manager.registerGameRoom(`G${room.id}-${++game}`, room.id, round.roundNumber, pairing.matchNumber, pairing.player1.id, pairing.player2.id);
      }
    };
    const playRound = () => {
      const round = room.tournament!.rounds.find((r) => r.roundNumber === room.tournament!.currentRoundNumber)!;
      let next = false;
      for (const pairing of round.pairings) {
        const gameRoomId = [...(manager as unknown as { gameRoomToDraft: Map<string, { draftRoomId: string; roundNumber: number; matchNumber: number }> }).gameRoomToDraft]
          .find(([, info]) => info.draftRoomId === room.id && info.roundNumber === round.roundNumber && info.matchNumber === pairing.matchNumber)?.[0];
        if (!gameRoomId) continue;
        const [w, l] = seat(pairing.player1.id) < seat(pairing.player2.id) ? [pairing.player1.id, pairing.player2.id] : [pairing.player2.id, pairing.player1.id];
        const played = seat(w) !== noShowSeat && seat(l) !== noShowSeat;
        next = manager.reportMatchResult(room.id, round.roundNumber, pairing.matchNumber, w, l, gameRoomId, played).newRoundStarted || next;
      }
      if (next) registerRound();
    };

    registerRound();
    playRound();
    if (manager.withdrawPlayer(room.id, users[7].id, 0).newRoundStarted) registerRound();
    for (let i = 0; i < 10 && room.phase !== "finished"; i++) playRound();
    expect(room.phase).toBe("finished");
    return { room, users };
  }

  const packsOf = (userId: string) =>
    prisma.userPack.findMany({ where: { userId }, select: { packId: true, source: true, openedAt: true }, orderBy: { packId: "asc" } });
  const txOf = (userId: string) =>
    prisma.transaction.findMany({ where: { userId, type: { in: ["draft_prize", "draft_reward"] } }, select: { type: true, amount: true, description: true } });

  it("the owner's 8-player example: all + 2nd + 1st, nothing for the player who left, paid exactly once", async () => {
    const { room, users } = await playTournament(OWNER_EXAMPLE);
    const [first, second, third, , , , , left] = users;
    expect(room.prizes!.map((p) => [p.playerId, p.position, p.withdrawn])).toEqual(users.map((u, i) => [u.id, i + 1, i === 7]));
    expect(room.prizes![0].rewards.coins).toBe(1500);
    expect(room.prizes![7].rewards).toEqual({ coins: 0, packs: [], items: [] });

    // Paid at the same time twice (a retry) and once more afterwards: once per player
    await Promise.all([payDraftPrizes(room), ...room.prizes!.map((p) => payDraftPrize(room, p))]);
    room.prizesPaid = false;
    await payDraftPrizes(room);

    expect((await getBalances(first.id)).coins).toBe(1500);
    expect((await getBalances(second.id)).coins).toBe(1000);
    expect((await getBalances(third.id)).coins).toBe(0);
    expect((await getBalances(left.id)).coins).toBe(0);

    expect(await txOf(first.id)).toEqual([{ type: "draft_reward", amount: 1500, description: `Premio de draft ${room.id}: 1.º puesto (premios del torneo)` }]);
    expect(await txOf(second.id)).toEqual([{ type: "draft_reward", amount: 1000, description: `Premio de draft ${room.id}: 2.º puesto (premios del torneo)` }]);
    expect(await txOf(third.id)).toEqual([]);

    const fixed = (packId: string, n: number) => Array.from({ length: n }, () => ({ packId, source: "draft_prize", openedAt: null }));
    expect(await packsOf(first.id)).toEqual([...fixed("fossil-booster", 2), ...fixed("jungle-booster", 2)]);
    expect(await packsOf(second.id)).toEqual(fixed("jungle-booster", 2));
    expect(await packsOf(third.id)).toEqual([]);
    expect(await packsOf(left.id)).toEqual([]);

    for (const u of users.slice(0, 7)) {
      expect(await prisma.userCoin.count({ where: { userId: u.id, coinId: "charizard" } })).toBe(1);
      expect(await prisma.systemMessage.count({ where: { recipientId: u.id, title: "Premio de draft" } })).toBe(1);
    }
    expect(await prisma.userCoin.count({ where: { userId: left.id } })).toBe(0);
    expect(await prisma.systemMessage.count({ where: { recipientId: left.id } })).toBe(0);

    const message = await prisma.systemMessage.findFirstOrThrow({ where: { recipientId: first.id, title: "Premio de draft" } });
    expect(message.content).toContain("1.500 monedas");
    expect(message.content).toContain("2 sobres de Jungle");
    expect(message.content).toContain("2 sobres de Fossil");
    expect(message.content).toContain("Moneda Charizard");
  });

  it("a cosmetic the player already has is skipped; the entry-fee pool and the prizes add up", async () => {
    const { room, users } = await playTournament(
      [
        { target: "all", items: [{ type: "playmat", id: "street" }] },
        { target: { from: 1, to: 2 }, coins: 300, items: [{ type: "skin", id: "charizard-gold" }] },
      ],
      1000,
    );
    // 8000 pool: 50 / 30 / 20 among the 3 first (the one who left gets nothing)
    await prisma.userPlaymat.create({ data: { userId: users[0].id, playmatId: "street" } });
    await payDraftPrizes(room);
    expect((await getBalances(users[0].id)).coins).toBe(4000 + 300);
    expect((await getBalances(users[2].id)).coins).toBe(1600);
    expect(await txOf(users[0].id)).toEqual(
      expect.arrayContaining([
        { type: "draft_prize", amount: 4000, description: "Premio de draft: 1° puesto" },
        { type: "draft_reward", amount: 300, description: `Premio de draft ${room.id}: 1.º puesto (premios del torneo)` },
      ]),
    );
    expect(await prisma.userPlaymat.count({ where: { userId: users[0].id, playmatId: "street" } })).toBe(1);
    expect(await prisma.userCardSkin.count({ where: { userId: users[1].id, skinId: "charizard-gold" } })).toBe(1);
    expect(await prisma.userCardSkin.count({ where: { userId: users[2].id } })).toBe(0);
    expect(await prisma.userPlaymat.count({ where: { userId: users[6].id, playmatId: "street" } })).toBe(1);
    expect(await prisma.userPlaymat.count({ where: { userId: users[7].id } })).toBe(0);
  });

  it("the Halloween 2026 tournament: playmat + emote for everyone, coin, variants and trophies on the podium", async () => {
    const halloween: DraftRewardTier[] = [
      { target: "all", items: [{ type: "playmat", id: "halloween-forest" }, { type: "emote", id: "gengar-tongue" }] },
      {
        target: { place: 1 },
        items: [
          { type: "coin", id: "gengar" },
          { type: "skin", id: "gengar-gold" },
          { type: "trophy", id: "trophy-halloween-2026-gold" },
        ],
      },
      { target: { place: 2 }, items: [{ type: "skin", id: "haunter-galaxy" }, { type: "trophy", id: "trophy-halloween-2026-silver" }] },
      { target: { place: 3 }, items: [{ type: "trophy", id: "trophy-halloween-2026-bronze" }] },
    ];
    expect(parseCreate({ maxPlayers: 8, entryFee: 0, rewards: halloween }).ok).toBe(true);
    const { room, users } = await playTournament(halloween);
    await payDraftPrizes(room);
    const [winner, second, third, fourth, , , , left] = users;
    const medals = async (userId: string) => (await prisma.userMedal.findMany({ where: { userId }, select: { medalId: true } })).map((m) => m.medalId);
    for (const u of users.slice(0, 7)) {
      expect(await prisma.userPlaymat.count({ where: { userId: u.id, playmatId: "halloween-forest" } })).toBe(1);
      expect(await prisma.userEmote.count({ where: { userId: u.id, emoteId: "gengar-tongue" } })).toBe(1);
    }
    expect(await prisma.userPlaymat.count({ where: { userId: left.id } })).toBe(0);
    expect(await prisma.userCoin.count({ where: { userId: winner.id, coinId: "gengar" } })).toBe(1);
    expect(await prisma.userCardSkin.count({ where: { userId: winner.id, skinId: "gengar-gold" } })).toBe(1);
    expect(await prisma.userCardSkin.count({ where: { userId: second.id, skinId: "haunter-galaxy" } })).toBe(1);
    expect(await medals(winner.id)).toEqual(["trophy-halloween-2026-gold"]);
    expect(await medals(second.id)).toEqual(["trophy-halloween-2026-silver"]);
    expect(await medals(third.id)).toEqual(["trophy-halloween-2026-bronze"]);
    expect(await medals(fourth.id)).toEqual([]);
    const message = await prisma.systemMessage.findFirstOrThrow({ where: { recipientId: winner.id, title: "Premio de draft" } });
    expect(message.content).toContain("Tapete Bosque Embrujado");
    expect(message.content).toContain("Trofeo Calabaza de Oro");
  });

  it("adminPlays: the creating admin's seat gets its pool share but none of the admin's prizes", async () => {
    const { room, users } = await playTournament(OWNER_EXAMPLE, 1000, { adminPlays: true });
    const [admin, second, third] = users;
    expect(room.prizes![0]).toMatchObject({ playerId: admin.id, position: 1, coins: 4000, rewards: { coins: 0, packs: [], items: [] } });
    await payDraftPrizes(room);
    expect((await getBalances(admin.id)).coins).toBe(4000);
    expect(await packsOf(admin.id)).toEqual([]);
    expect(await prisma.userCoin.count({ where: { userId: admin.id } })).toBe(0);
    // The 1st place prize isn't moved to anyone: the 2nd gets the 2nd's
    expect((await getBalances(second.id)).coins).toBe(2400 + 1000);
    expect((await getBalances(third.id)).coins).toBe(1600);
    expect(await prisma.userCoin.count({ where: { userId: third.id, coinId: "charizard" } })).toBe(1);
  });

  it("a player without one real game (only no-shows) gets none of the admin's prizes", async () => {
    const { room, users } = await playTournament(OWNER_EXAMPLE, 0, { noShowSeat: 3 });
    expect(room.prizes!.find((p) => p.playerId === users[3].id)!.rewards).toEqual({ coins: 0, packs: [], items: [] });
    // Their opponents still played other real games
    expect(room.prizes!.find((p) => p.playerId === users[4].id)!.rewards.items).toEqual([{ type: "coin", id: "charizard" }]);
    await payDraftPrizes(room);
    expect(await prisma.userCoin.count({ where: { userId: users[3].id } })).toBe(0);
    expect(await prisma.userCoin.count({ where: { userId: users[4].id, coinId: "charizard" } })).toBe(1);
    expect((await getBalances(users[0].id)).coins).toBe(1500);
  });

  it("failed payouts stay on the room, are retried with backoff and logged with what is owed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const admin = await createUser({}, { role: "admin" });
    const lateId = randomUUID(); // no account yet: the first try fails (foreign key)
    const neverId = randomUUID(); // never exists: given up after the last retry
    const grant = { coins: 700, packs: [], items: [] };
    const prize = (playerId: string, position: number) => ({ playerId, playerName: "X", position, coins: 0, withdrawn: false, rewards: grant });
    const room = {
      id: "RETRY1",
      createdAt: new Date(),
      adminId: admin.id,
      rewardsLogId: null,
      prizes: [prize(lateId, 1), prize(neverId, 2)],
      prizesPaid: false,
      unpaidPrizes: [],
    } as unknown as DraftRoom;

    const paying = payDraftPrizes(room, { retryDelaysMs: [200, 200] });
    await vi.waitFor(() => expect(room.unpaidPrizes).toHaveLength(2));
    expect(errors.mock.calls.some(([line]) => String(line).includes(`"userId":"${lateId}"`) && String(line).includes('"roomId":"RETRY1"'))).toBe(true);
    await prisma.user.create({ data: { id: lateId, email: `late-${lateId}@example.com`, username: `late_${lateId.slice(0, 8)}` } });
    await paying;

    expect((await getBalances(lateId)).coins).toBe(700);
    expect(room.unpaidPrizes.map((p) => p.playerId)).toEqual([neverId]);
    expect(errors.mock.calls.some(([line]) => String(line).startsWith("[draft] PRIZE NOT PAID") && String(line).includes(neverId))).toBe(true);
  });
});
