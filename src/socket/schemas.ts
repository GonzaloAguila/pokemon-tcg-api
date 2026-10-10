/**
 * Zod schemas for every Socket.io payload the server accepts.
 *
 * Shapes mirror what the real frontend sends (pokemon-tcg: LobbyPage, MultiplayerGamePage,
 * ChatPanel, useChatSocket, useDraftSocket). Objects are non-strict: unknown keys are stripped,
 * so deprecated client fields (userId, username, avatarId, titleId) are accepted and ignored.
 * Identity never comes from a payload; see getAuthUserId() in handlers.ts.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Room codes are 6 chars today; keep it bounded (joinRoom creates a room for unknown ids). */
const roomId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "codigo de sala invalido");
/** Card / Pokémon instance ids (e.g. "Pikachu-0-1700000000000-0.123", "draft-...-a1b2c3"). */
const instanceId = z.string().min(1).max(200);
/** DB deck UUID or theme deck id ("brushfire"). */
const deckId = z.string().min(1).max(64);
const idList = (max: number) => z.array(instanceId).max(max);

const BASIC_ENERGY_TYPES = ["grass", "fire", "water", "lightning", "psychic", "fighting"] as const;
const coinSide = z.enum(["heads", "tails"]);

const BENCH_SIZE = 5;
const MAX_PRIZES = 6;
/** Generous upper bound for anything that lists cards from one zone (a deck is 60 cards). */
const MAX_ZONE_CARDS = 60;

const benchIndex = z.number().int().min(0).max(BENCH_SIZE - 1);
/** Most questions one Trainer / power asks (Super Energy Removal: 4). */
const MAX_EFFECT_STEPS = 8;
/**
 * Answers to a Trainer's / power's steps (game-core getTrainerSteps / getPowerSteps):
 * selections[i] = ids of the options chosen at step i (card / Pokémon ids, "0".."n-1"
 * indices, energy types, peek targets...). Only the shape is checked here; game-core
 * checks every answer against the options it offers and throws IllegalActionError.
 */
const effectSelections = z
  .array(z.array(z.string().min(1).max(200)).max(MAX_ZONE_CARDS))
  .max(MAX_EFFECT_STEPS)
  .nullish()
  .transform((v) => v ?? []);
const attackIndex = z.number().int().min(0).max(9);

/** Treat null like "not sent" (the client drops undefined fields when serializing). */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((v) => v ?? undefined);
}

// ---------------------------------------------------------------------------
// Parsing helper
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "payload";
  return `Datos invalidos (${path})`;
}

export function parsePayload<S extends z.ZodTypeAny>(schema: S, data: unknown): ParseResult<z.output<S>> {
  const res = schema.safeParse(data);
  return res.success ? { ok: true, data: res.data } : { ok: false, error: describeIssue(res.error) };
}

// ---------------------------------------------------------------------------
// Lobby / room / chat events (handlers.ts)
// ---------------------------------------------------------------------------

/** globalChat:message; `type` defaults to "text" like the old handler did. */
const globalChatMessage = z.preprocess(
  (v) => (v && typeof v === "object" && (v as { type?: unknown }).type === undefined ? { ...v, type: "text" } : v),
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), content: z.string().trim().min(1).max(500) }),
    z.object({ type: z.literal("sticker"), content: z.string().trim().min(1).max(100) }),
  ]),
);

export const socketSchemas = {
  createRoom: z.object({
    deckId: optional(deckId),
    prizeCount: optional(z.number().int().min(4).max(MAX_PRIZES)),
    // Lobby slider max is 1000 (legend tier). Bets are not charged yet.
    betAmount: optional(z.number().int().min(0).max(1000)),
    reservedUserId: optional(z.string().max(64)),
    friendly: optional(z.boolean()),
  }),

  joinRoom: z.object({
    roomId,
    deckId: optional(deckId),
  }),

  /** deleteRoom, leaveRoom, ready, requestKick, spectateRoom */
  roomRef: z.object({ roomId }),

  /** Coins a Trainer (by card id in hand) or activated power (by Pokémon id) flips before its steps. */
  requestCoinFlip: z.discriminatedUnion("purpose", [
    z.object({ roomId, purpose: z.literal("trainer"), cardId: instanceId }),
    z.object({ roomId, purpose: z.literal("power"), pokemonId: instanceId }),
  ]),

  /** The action itself is validated by parseGameAction() inside GameRoomManager.executeAction. */
  actionEnvelope: z.object({
    roomId,
    action: z.object({ type: z.string().min(1).max(64) }).passthrough(),
  }),

  chatMessage: z.object({
    roomId,
    message: z.object({ content: z.string().trim().min(1).max(500) }),
  }),

  globalChatMessage,
};

// ---------------------------------------------------------------------------
// Draft events (draft-handlers.ts)
// ---------------------------------------------------------------------------

// Ranges match the admin DraftConfigPanel sliders.
const draftConfig = z.object({
  maxPlayers: z.number().int().min(2).max(8).optional(),
  packsPerPlayer: z.number().int().min(1).max(6).optional(),
  cardsPerPack: z.number().int().min(5).max(15).optional(),
  pickTimeSeconds: z.number().int().min(15).max(90).optional(),
  keepInCollection: z.boolean().optional(),
  minDeckSize: z.number().int().min(20).max(60).optional(),
  entryFee: z.number().int().min(0).max(10_000).optional(),
  adminPlays: z.boolean().optional(),
});

export const draftSchemas = {
  create: z.object({ config: optional(draftConfig) }),
  /** draft:join, draft:leave, draft:delete, draft:start */
  roomRef: z.object({ roomId }),
  pick: z.object({ roomId, cardId: instanceId }),
  bonusPick: z.object({ roomId, cardDefIds: idList(10) }),
  submitDeck: z.object({
    roomId,
    // 6 packs x 15 cards + 3 bonus picks is the most a player can draft
    deckCardIds: idList(120),
    energyCards: z
      .array(z.object({ type: z.enum(BASIC_ENERGY_TYPES), count: z.number().int().min(0).max(MAX_ZONE_CARDS) }))
      .max(BASIC_ENERGY_TYPES.length),
  }),
  forfeit: z.object({ draftRoomId: roomId, gameRoomId: roomId }),
};

// ---------------------------------------------------------------------------
// Game actions (GameRoomManager.executeAction)
// ---------------------------------------------------------------------------

const noPayload = z.object({}).nullish().transform(() => ({}));

const action = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

/**
 * Activated Pokémon Power through game-core's effect registry: the Pokémon in play using its
 * power and the answers to getPowerSteps. Legacy `powerType` fields are ignored (stripped).
 */
const powerPayload = z.object({
  pokemonId: instanceId,
  selections: effectSelections,
});

export const gameActionSchema = z.discriminatedUnion("type", [
  action("attack", z.object({
    attackIndex,
    // Sent by the client for energy-discard attacks; the engine picks the energy, so it's ignored.
    selectedEnergyIds: optional(idList(MAX_ZONE_CARDS)),
    metronomeAttack: optional(z.object({ name: z.string().max(100), index: attackIndex })),
    // Porygon: any type other than Colorless
    conversionType: optional(z.enum(BASIC_ENERGY_TYPES)),
    conversionEffect: optional(z.enum(["changeWeakness", "changeResistance"])),
  })),
  action("endTurn", noPayload),
  action("retreat", z.object({ energyIdsToDiscard: idList(MAX_ZONE_CARDS), benchIndex })),
  // Board actions run through game-core (playBasicPokemon / attachEnergyCard / evolvePokemonCard).
  // Legacy fields (playBasicToBench.benchIndex, attachEnergy.isBench/benchIndex) are ignored:
  // the Bench is compacted by the engine and Pokémon are identified by id.
  action("playBasicToActive", z.object({ cardId: instanceId })),
  action("playBasicToBench", z.object({ cardId: instanceId })),
  action("attachEnergy", z.object({ cardId: instanceId, pokemonId: instanceId })),
  action("evolve", z
    .object({
      cardId: instanceId,
      targetPokemonId: optional(instanceId),
      /** Legacy: -1 = Active, 0-4 = Bench slot. Ignored when targetPokemonId is sent. */
      targetIndex: optional(z.number().int().min(-1).max(BENCH_SIZE - 1)),
    })
    .refine((p) => p.targetPokemonId !== undefined || p.targetIndex !== undefined, {
      message: "targetPokemonId requerido",
      path: ["targetPokemonId"],
    })),
  action("takePrize", z.object({ prizeIndex: z.number().int().min(0).max(MAX_PRIZES - 1) })),
  action("promote", z.object({ benchIndex })),
  action("deckSearch", z.object({ cardId: instanceId.nullish().transform((v) => v ?? null) })),
  action("forceSwitch", z.object({ benchIndex })),
  action("selfSwitch", z.object({ benchIndex })),
  action("skipSwitch", noPayload),
  action("benchDamage", z.object({ selectedPokemonIds: idList(2 * BENCH_SIZE) })),
  action("clearPeek", noPayload),
  // Answer to state.pendingAttackChoice.step (option ids; Prophecy's order "0".."n-1").
  // Only the step's chooser may send it; game-core checks it against the step's options.
  action("resolveAttackChoice", z.object({ selection: z.array(z.string().min(1).max(200)).max(MAX_ZONE_CARDS) })),
  // Discard a Mysterious Fossil / Clefairy Doll in play (game-core canDiscardFromPlay)
  action("discardFromPlay", z.object({ pokemonId: instanceId })),
  action("mulligan", noPayload),
  action("playerReady", noPayload),
  action("usePower", powerPayload),
  // Trainer through game-core's effect registry: the card in the hand and the answers to
  // getTrainerSteps. trainerName (optional, legacy) must match the card when sent; coinResult
  // is ignored (coins come from requestCoinFlip or are rolled when the card is played).
  action("playTrainer", z.object({
    cardId: instanceId,
    selections: effectSelections,
    trainerName: optional(z.string().min(1).max(64)),
    coinResult: optional(coinSide),
  })),
  action("surrender", noPayload),
]);

export type GameAction = z.output<typeof gameActionSchema>;
export type GameActionType = GameAction["type"];

export function parseGameAction(input: unknown): { ok: true; action: GameAction } | { ok: false; error: string } {
  const res = parsePayload(gameActionSchema, input);
  return res.ok ? { ok: true, action: res.data } : { ok: false, error: res.error };
}
