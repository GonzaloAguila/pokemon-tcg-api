/**
 * Game Room Manager
 *
 * Manages in-memory game rooms for real-time multiplayer.
 * TODO: Persist to database for reconnection support.
 */

import { randomInt } from "crypto";
import {
  resolveConfusionFlip,
  type GameState,
  type GameCard,
  type Attack,
  type CoinFlipRequirement,
  GamePhase,
  IllegalActionError,
  initializeMultiplayerGame,
  // Lucky Duel: random Basic + server-built deck, both Actives face down until both are ready
  drawLuckyDuel,
  initializeLuckyDuelGame,
  isLuckyDuel,
  startGame,
  shuffle,
  // Attacks and turn flow
  executeAttack,
  executeMetronome,
  canExecuteAttack,
  canExecuteMetronome,
  getAttackCoinPlan,
  flipAttackCoins,
  resolveAttackChoice,
  getEffectivePokemonCard,
  endTurn,
  executeRetreat,
  doMulligan,
  hasBasicPokemon,
  setPlayerReady,
  startPlayingPhase,
  promoteActivePokemon,
  takePrize,
  prizesOwed,
  getDeckById,
  decks,
  isPokemonCard,
  createGameEvent,
  AttackEffectType,
  // Perspective + board actions (engine-owned, throw IllegalActionError when illegal)
  swapSides,
  findInPlay,
  playBasicPokemon,
  attachEnergyCard,
  evolvePokemonCard,
  discardFromPlay,
  // Pending state handlers
  executeDeckSearch,
  executeBenchDamage,
  applyForceSwitch,
  applySelfSwitch,
  skipPendingSwitch,
  clearPendingPeek,
  // Effect registry: every Trainer and activated Pokémon Power
  canPlayTrainerCard,
  getTrainerCoinFlips,
  getTrainerSteps,
  playTrainerCard,
  canUsePokemonPower,
  getPowerCoinFlips,
  getPowerSteps,
  usePokemonPower,
  getTrainerCoinFlippers,
  getPowerCoinFlippers,
  checkSelection,
  type CoinFlipper,
  type SelectionStep,
  type EnergyType,
  // Team Rocket: on-play power choices, Sinkhole
  resolvePowerChoice,
  getRetreatDamageSources,
  // Gym Heroes: Recall, Vermilion City Gym's coin, Sabrina's ESP re-flip, Narrow Gym, Stadium actions
  getAvailableAttacks,
  canUseVermilionCoin,
  getAttackChoiceCoinPlan,
  resolveBenchTrim,
  canUseStadiumAction,
  getStadiumActionCoinFlips,
  getStadiumActionSteps,
  useStadiumAction,
  type AttackCoinPlan,
  // Answer clock: default answers when the off-turn answerer runs out of time
  minSelectionsOf,
  chooseBenchTrim,
  // Misty's Duel (Rock-Paper-Scissors)
  submitDuelPick,
  aiDuelPick,
  type RpsChoice,
  // Gym Challenge
  getAttackPreReaction,
  canPlayBasicPokemon,
  getPlayBasicCoinFlips,
  flipFaceDown,
  isChaosGymCoinPending,
  getChaosGymOfferStep,
  answerChaosGymOffer,
  declineChaosGymOffer,
  forfeitChaosGymPlay,
  declineBorrowedTrainer,
} from "@gonzaloaguila/game-core";
import { parseGameAction, type TABLE_MODES } from "./schemas.js";
import { isUserOnline } from "./presence.js";
import { isLuckyDuelFaceDown } from "./state-masking.js";
import type { RoomChatMessage } from "./room-chat.js";
import type { RoomCosmetics } from "./room-cosmetics.js";
import type { RoomEmoteLoadouts } from "./room-emotes.js";
import type { DeckRank } from "../modules/decks/deck-rank.js";

/** Table type: a normal table, or Lucky Duel (random Basic and deck, no Bench, no Prizes). */
export type TableMode = (typeof TABLE_MODES)[number];

/**
 * A room's mode: a lobby table's, "adventure" (Modo Aventura battle) or "gym" (Gym Leader battle),
 * the last two created by the server only.
 */
export type RoomMode = TableMode | "adventure" | "gym";

/**
 * Modo Aventura battle room (adventure-room.ts keeps the rest): the human is player 1, player 2
 * is the game-core AI run by the server (no socket, no user id). No turn timer, answer clock,
 * kick, forfeit, bets, match row or settlement: the run's result comes from adventure-room.ts.
 */
export interface AdventureRoomInfo {
  runId: string;
  userId: string;
}

/**
 * Gym Leader battle room (gym-room.ts keeps the rest): the challenger is player 1, the leader is
 * the game-core AI as player 2 (no socket, no user id). Like an adventure battle (no answer clock,
 * kick, forfeit timers, bets, match row or settlement), except that gym-room.ts runs the
 * challenger's turn clock and disconnect grace, which end the battle as a loss.
 */
export interface GymRoomInfo {
  leaderId: string;
  mode: "normal" | "expert";
  userId: string;
}

/** A room whose player 2 is the server's AI (adventure or gym battle). */
export function hasAISeat(room: GameRoom): boolean {
  return !!room.adventure || !!room.gym;
}

interface RoomConfig {
  mode: RoomMode;
  prizeCount: number;           // 4, 5, or 6 (0 for Lucky Duel: no Prizes)
  betAmount: number;            // 0 = no bet
  reservedUserId: string | null; // null = open to all
  friendly: boolean;            // true = no stats recorded
}

interface CreatorInfo {
  username: string | null;
  avatarId: string | null;
  titleId: string | null;
}

export interface GameRoom {
  id: string;
  status: "waiting" | "ready" | "playing" | "finished";

  // Settlement (match-settlement.ts): the `matches` row opened when the game started (bets
  // escrowed), a start in progress (escrow awaiting the DB) and whether the result was settled:
  // once per room, whatever the end path (game over, surrender, kick, disconnect, leave, setup
  // timeout, draft forfeit, admin close)
  matchId?: string;
  startPending?: boolean;
  resultSettled?: boolean;
  /**
   * Lucky Duel: the catalog id of the Basic each seat drew (startLuckyDuelGame), stored on the
   * match row at settlement for the Lucky Duel achievements (the in-game card ids are random).
   */
  luckyDuelStarters?: { player1: string; player2: string };
  /** Started for players who may be absent (draft round): if neither shows up, nobody wins. */
  checkIn?: boolean;
  /** A draft tournament game: not listed in the lobby. */
  isDraft?: boolean;

  // Waiting lobby tables (see WAITING_TABLE_* / CREATOR_RESPONSE_MS): they outlive the creator's
  // lobby socket. `creatorSeenAt`: last time the creator was online (any socket); `touchedAt`:
  // created, or last opened by the creator (their seat retaken). `awaitingCreator`: a rival sat
  // while the creator wasn't at the table; the game starts when the creator opens it, or the
  // table closes at `expiresAt`.
  creatorSeenAt?: number;
  touchedAt?: number;
  awaitingCreator?: { joinedAt: number; expiresAt: number };

  // Players
  player1Id: string | null;
  player1SocketId: string | null;
  player1Ready: boolean;
  player1DeckId: string | null;

  player2Id: string | null;
  player2SocketId: string | null;
  player2Ready: boolean;
  player2DeckId: string | null;
  /**
   * The creator's deck (player1DeckId) as the lobby shows it: its rank F–S (public, the deck
   * itself never is) and its name (only to the creator, `myRooms`). Unset at Lucky Duel.
   */
  creatorDeck?: { name: string | null; rank: DeckRank | null };

  // Game state
  gameState: GameState | null;

  // Turn timer (server-side)
  turnStartedAt: number | null;       // Date.now() when current turn started
  turnTimerDuration: number;          // seconds, default 180

  // Spectators: socket id -> user id (a user may watch from several tabs; counted once)
  spectators: Map<string, string>;
  /** The room chat's last messages (players and spectators), sent to whoever (re)joins. */
  chat: RoomChatMessage[];

  // Room config
  config: RoomConfig;
  creator: CreatorInfo;
  joiner: CreatorInfo;
  /** Both seats' cosmetics, read from the DB when the game started (room-cosmetics.ts). */
  cosmetics?: RoomCosmetics;
  /** Both seats' equipped battle emotes (room-emotes.ts): read at the start, re-read on a miss. */
  emoteLoadouts?: RoomEmoteLoadouts;
  /** When the cleanup sweep first saw the room finished (sweepRooms): deleted FINISHED_ROOM_TTL_MS later. */
  finishedAt?: number;

  // Metadata
  players: string[];
  createdAt: Date;

  // Coins rolled for a Trainer / power before it resolved (requestCoinFlip, or a failed
  // attempt), by effectCoinKey. The action uses these, never coins sent by the client.
  effectCoins?: Record<string, { results: Coin[]; turnNumber: number | null }>;

  // Trainer whose steps the server runs (startTrainer): the answers so far stay here, never in
  // the state sent to clients (Challenge!'s picks are face down until it resolves).
  pendingTrainer?: PendingTrainerRecord;

  // An off-turn answer in progress (offTurnAnswerer): `side` answers, its clock started at
  // `startedAt` (also room.turnStartedAt meanwhile); the turn clock is paused with
  // `turnRemainingMs` left. `durationMs`: how long it lasts (the turn clock's duration, or a timed
  // step's stepAnswerTimeLimitMs). `autoAnswerFailed`: no default answer worked (requestKick allowed).
  answerClock?: { side: PlayerKey; startedAt: number; durationMs: number; turnRemainingMs: number; autoAnswerFailed?: boolean };

  /** Modo Aventura battle (see AdventureRoomInfo). */
  adventure?: AdventureRoomInfo;
  /** Gym Leader battle (see GymRoomInfo). */
  gym?: GymRoomInfo;
  /**
   * Math.random for every engine call of this room's actions and coin requests (adventure rooms:
   * the battle's seeded generator). The calls run synchronously inside the swap (withRandom).
   */
  engineRandom?: () => number;
  /** Where this room's coins come from (default: the manager's coin source, CSPRNG). */
  coinSource?: CoinSource;
}

export type PlayerKey = "player1" | "player2";
type Coin = "heads" | "tails";

/** spectateRoom by a player of that room: they rejoin their seat instead (joinRoom). */
export class SeatedSpectatorError extends Error {
  readonly code = "SEATED_IN_ROOM";
  constructor() {
    super("Juegas en esta mesa: vuelve a tu partida");
    this.name = "SeatedSpectatorError";
  }
}

/** spectateRoom on a friendly or reserved (invite) table: only public tables can be watched. */
export class PrivateTableError extends Error {
  readonly code = "PRIVATE_TABLE";
  constructor() {
    super("Esta mesa es privada: no se puede mirar");
    this.name = "PrivateTableError";
  }
}

/**
 * Whether anyone may watch this table: not friendly, not reserved for one opponent. Draft games
 * can always be watched (the draft's players and spectators follow its tournament).
 */
export function isPublicTable(room: GameRoom): boolean {
  return !!room.isDraft || (!room.config.friendly && !room.config.reservedUserId);
}

/** joinRoom on a room that doesn't exist (finished, deleted, or lost in an API restart). */
export class RoomNotFoundError extends Error {
  readonly code = "ROOM_NOT_FOUND";
  constructor() {
    super("La partida ya no existe");
    this.name = "RoomNotFoundError";
  }
}

/** Joining another table while a rival already sat at one of yours: go to yours (`roomId`). */
export class OwnTableTakenError extends Error {
  readonly code = "OWN_TABLE_TAKEN";
  constructor(readonly roomId: string) {
    super("Un rival ya se unió a tu mesa");
    this.name = "OwnTableTakenError";
  }
}

/**
 * The player the game is waiting on (the one a turn-timer kick targets), from the stored
 * state (player 1's perspective), or null when nobody / both:
 * - MULLIGAN/SETUP: the only player not ready yet (both or neither ready: null);
 * - whoever owes a pending answer: a Trainer step or an attack choice asked to the other
 *   player (Challenge!, Terror Strike, Flee), a Bench trim (Narrow Gym), a promotion (also off-turn, after a Knock Out) or a
 *   Prize. If both players owe something (each could promote first), null: nobody may be
 *   kicked while they themselves keep the game waiting;
 * - otherwise the side whose turn it is (its own pending choices included).
 */
export function awaitedSide(state: GameState | null | undefined): PlayerKey | null {
  if (!state || state.gamePhase === "GAME_OVER") return null;
  if (state.gamePhase === "MULLIGAN" || state.gamePhase === "SETUP") {
    if (state.playerReady === state.opponentReady) return null;
    return state.playerReady ? "player2" : "player1";
  }
  const turnSide: PlayerKey = state.isPlayerTurn ? "player1" : "player2";
  const otherSide: PlayerKey = turnSide === "player1" ? "player2" : "player1";
  const trainerChoice = pendingTrainerChoiceOf(state);
  if (trainerChoice) return trainerChoiceAnswerer(state, trainerChoice);
  // Chaos Gym: the player who accepted the offered Trainer plays it (out of turn)
  const chaosPlayer = chaosOfferPlayer(state);
  if (chaosPlayer) return chaosPlayer;
  // Misty's Duel: whoever hasn't picked (both: the player whose turn it isn't, see duelPickers)
  const pickers = duelPickers(state);
  if (pickers.length > 0) return pickers.includes(otherSide) ? otherSide : pickers[0];
  // Narrow Gym: whoever must trim their Bench first (state in player 1's perspective)
  const benchTrim = state.pendingBenchTrim?.[0];
  if (benchTrim) return benchTrim.side === "player" ? "player1" : "player2";
  if (state.pendingAttackChoice) return state.pendingAttackChoice.step.chooser === "opponent" ? otherSide : turnSide;
  const player1Owes = state.playerNeedsToPromote || state.playerCanTakePrize;
  const player2Owes = state.opponentNeedsToPromote || state.opponentCanTakePrize;
  if (player1Owes && player2Owes) return null;
  if (player1Owes) return "player1";
  if (player2Owes) return "player2";
  return turnSide;
}
/**
 * The player who owes an answer while it is NOT their turn (state in player 1's perspective),
 * or null: a Trainer step or an attack choice asked to the other player (Challenge!, Erika, Lt.
 * Surge's Treaty, Blaine's Quiz #1, Terror Strike, mid-attack reactions such as Flee or Bench
 * Guard of the defending side), or the head of Narrow Gym's Bench trim queue when it is theirs.
 * While one is pending the answer clock runs for them and the turn clock is paused
 * (GameRoomManager.updateClocks); when it runs out the server answers by default. A timed step
 * (`answerTimeLimitMs`: the Blaine's Quiz guesses) is on the answer clock whoever answers it, the
 * side whose turn it is included (a quiz offered by Chaos Gym is guessed by that side).
 */
export function offTurnAnswerer(state: GameState | null | undefined): PlayerKey | null {
  if (!state || state.gamePhase === "GAME_OVER" || state.gamePhase === "MULLIGAN" || state.gamePhase === "SETUP") return null;
  const turnSide: PlayerKey = state.isPlayerTurn ? "player1" : "player2";
  const otherSide: PlayerKey = turnSide === "player1" ? "player2" : "player1";
  const trainerChoice = pendingTrainerChoiceOf(state);
  if (trainerChoice) {
    const answerer = trainerChoiceAnswerer(state, trainerChoice);
    return answerer === turnSide && !trainerChoice.step.answerTimeLimitMs ? null : answerer;
  }
  // Chaos Gym: the accepted offer is played on the offered player's answer clock (default: give it up)
  const chaosPlayer = chaosOfferPlayer(state);
  if (chaosPlayer) return chaosPlayer === turnSide ? null : chaosPlayer;
  // Misty's Duel: always on the answer clock (never a kick), even when only the player whose turn
  // it is still has to pick; with both missing the clock shows the other player's
  const pickers = duelPickers(state);
  if (pickers.length > 0) return pickers.includes(otherSide) ? otherSide : pickers[0];
  const benchTrim = state.pendingBenchTrim?.[0];
  if (benchTrim) {
    const side: PlayerKey = benchTrim.side === "player" ? "player1" : "player2";
    return side === turnSide ? null : side;
  }
  if (state.pendingAttackChoice) {
    const step = state.pendingAttackChoice.step;
    return step.chooser === "opponent" ? otherSide : step.answerTimeLimitMs ? turnSide : null;
  }
  return null;
}

/**
 * Misty's Duel (state.pendingDuel, player 1's perspective): the players who haven't picked this
 * round, the player whose turn it is first. Empty when no duel is pending.
 */
export function duelPickers(state: GameState | null | undefined): PlayerKey[] {
  const duel = state?.pendingDuel;
  if (!duel) return [];
  const missing: PlayerKey[] = [];
  if (duel.playerPick === null) missing.push("player1");
  if (duel.opponentPick === null) missing.push("player2");
  return state!.isPlayerTurn ? missing : missing.reverse();
}

/**
 * The answer given for a player who ran out of time on a step: the fewest options it accepts,
 * taken from the first ones (Erika: "0"; an optional power: none), else every option in order
 * (orderings). Null when neither is valid. A step may name its own default
 * (`defaultSelection`, e.g. a future "decline" for Challenge!): used first when valid.
 */
export function defaultSelection(step: SelectionStep): string[] | null {
  // Disabled options can't be chosen: the fallbacks only take the enabled ones
  const ids = step.options.filter((option) => !option.disabled).map((option) => option.id);
  const own = step.defaultSelection;
  for (const candidate of [...(own ? [own] : []), ids.slice(0, minSelectionsOf(step)), ids]) {
    try {
      checkSelection(step, candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** The action that answers `side`'s pending off-turn question by default (see offTurnAnswerer). */
function defaultAnswerAction(state: GameState, side: PlayerKey): { type: string; payload: unknown } | null {
  const trainerChoice = pendingTrainerChoiceOf(state);
  if (trainerChoice) {
    const selection = defaultSelection(trainerChoice.step);
    return selection ? { type: "answerTrainerChoice", payload: { selection } } : null;
  }
  if (chaosOfferPlayer(state) === side) return { type: "declineChaosOffer", payload: {} };
  if (state.pendingBenchTrim?.length) {
    // The engine's pick (its lowest-value Benched Pokémon), on that player's own view
    const discardIds = chooseBenchTrim(side === "player1" ? state : swapSides(state));
    return discardIds.length > 0 ? { type: "benchTrim", payload: { discardIds } } : null;
  }
  if (state.pendingAttackChoice) {
    const selection = defaultSelection(state.pendingAttackChoice.step);
    return selection ? { type: "resolveAttackChoice", payload: { selection } } : null;
  }
  return null;
}

/**
 * How long the pending answer's clock lasts when its step asks for less than the table's turn
 * clock (game-core `SelectionStep.answerTimeLimitMs`: the Blaine's Quiz guesses, 10 s), else
 * undefined (the turn clock's duration). Same order as defaultAnswerAction.
 */
export function stepAnswerTimeLimitMs(state: GameState | null | undefined): number | undefined {
  if (!state) return undefined;
  const trainerChoice = pendingTrainerChoiceOf(state);
  const step = trainerChoice ? trainerChoice.step : state.pendingAttackChoice?.step;
  const limit = step?.answerTimeLimitMs;
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

/**
 * Extra time the server waits after a timed step's clock (stepAnswerTimeLimitMs) before answering
 * by default: an answer sent at the last second the answerer saw still arrives in time.
 */
export const TIMED_ANSWER_GRACE_MS = 1_000;

/**
 * Whose clock runs, sent with every game state (room-state.ts): `kind` "turn" = the awaited
 * player's turn clock (requestKick once it ran out), "answer" = an off-turn answer's clock (the
 * server answers by default when it runs out; the turn clock of `pausedUserId` is paused with
 * `pausedRemainingSeconds` left and resumes after the answer).
 */
export interface RoomClock {
  kind: "turn" | "answer";
  userId: string | null;
  startedAt: number | null;
  durationSeconds: number;
  pausedUserId?: string | null;
  pausedRemainingSeconds?: number;
}

/** Who flipped a coin: "attacker" = the player acting (attack, Trainer, retreat), "defender" = the other one. */
type Flipper = "attacker" | "defender";
interface CoinFlipInfo {
  attackName: string;
  /** The attacker's coins: Smokescreen / Sand-attack coin first, then the attack's own */
  results: Coin[];
  /** Who flipped each of `results` (Knock Down, Digger); omitted = all the acting player */
  flippedBy?: Flipper[];
  /**
   * Rebellion (Misty's Gyarados, Gym Challenge): `results` holds `powerCoins` power coins right
   * after the first `smokescreenCoins` (Smokescreen / Sand-attack) ones, flipped by the attacker
   * (both tails: the attack does nothing). Omitted when the attacker flips no power coin.
   */
  smokescreenCoins?: number;
  powerCoins?: number;
  /** Coins flipped by the defending side (Transparency, Final Beam), after the attacker's */
  defenderResults?: Coin[];
  /**
   * Who flipped each of `defenderResults` when it wasn't the defending player (game-core's
   * plan.defenderFlipper: Rocket's Scyther's Shadow Images is flipped by the attacker)
   */
  defenderFlippedBy?: Flipper[];
}

/**
 * state.pendingTrainerChoice as stored and sent to clients (TR contract §3). `chooser` is
 * relative to the Trainer's player (the side whose turn it is): "self" = that player answers,
 * "opponent" = the other player. Masking strips `step` for whoever doesn't answer.
 */
export interface PendingTrainerChoice {
  cardId: string;
  trainerName: string;
  step: SelectionStep;
  chooser: "self" | "opponent";
  /**
   * The Trainer's player is NOT the side whose turn it is (Chaos Gym's offered card, played by
   * the other player out of turn): `chooser` is relative to that player. Absent = the turn side.
   */
  playedOffTurn?: true;
}

interface PendingTrainerRecord {
  side: PlayerKey;
  cardId: string;
  /** Answers so far (server-side only) */
  selections: string[][];
  coinKey: string;
  /** Chaos Gym's offer question (getChaosGymOfferStep), answered with answerChaosGymOffer */
  kind?: "chaosOffer";
}

const otherKey = (side: PlayerKey): PlayerKey => (side === "player1" ? "player2" : "player1");

/** Who answers the pending Trainer step (state in player 1's perspective). */
function trainerChoiceAnswerer(state: GameState, choice: PendingTrainerChoice): PlayerKey {
  const turnSide: PlayerKey = state.isPlayerTurn ? "player1" : "player2";
  const trainerSide = choice.playedOffTurn ? otherKey(turnSide) : turnSide;
  return choice.chooser === "opponent" ? otherKey(trainerSide) : trainerSide;
}

/**
 * Chaos Gym (Gym Challenge): the player who accepted the offered Trainer and now plays it out of
 * turn (playTrainer / startTrainer / requestCoinFlip with the offer's cardId, or declineChaosOffer),
 * or null. State in player 1's perspective (pendingChaosOffer's sides are relative).
 */
export function chaosOfferPlayer(state: GameState | null | undefined): PlayerKey | null {
  const offer = state?.pendingChaosOffer;
  if (!offer?.accepted) return null;
  return offer.offeredTo === "player" ? "player1" : "player2";
}

type RoomGameState = GameState & { pendingTrainerChoice?: PendingTrainerChoice };

const pendingTrainerChoiceOf = (state: GameState): PendingTrainerChoice | undefined =>
  (state as RoomGameState).pendingTrainerChoice;

function withoutTrainerChoice(state: GameState): GameState {
  if (!("pendingTrainerChoice" in state)) return state;
  const { pendingTrainerChoice: _omit, ...rest } = state as RoomGameState;
  return rest as GameState;
}

/** Steps the acting client can't answer itself: another player's answer, or hidden cards. */
const isServerStep = (step: SelectionStep): boolean => step.chooser === "opponent" || step.reveals !== undefined;

/**
 * Check the answers a client sent for a Trainer's / power's steps: each one valid for its step,
 * none answering a step the server must run (isServerStep: Challenge!'s opponent, Rocket's
 * Sneak Attack's revealed hand). Returns the next step (null = every step answered).
 */
function walkClientSteps(
  getSteps: (selections: string[][]) => SelectionStep | null,
  selections: string[][],
): SelectionStep | null {
  for (let i = 0; i < selections.length; i++) {
    const step = getSteps(selections.slice(0, i));
    if (!step) throw new IllegalActionError("Hay selecciones de más");
    if (isServerStep(step)) throw new IllegalActionError("Esta elección la pide el servidor: juega la carta con startTrainer");
    checkSelection(step, selections[i]);
  }
  return getSteps(selections);
}

/**
 * flippedBy of a Trainer's / power's coins (TR contract §2) from game-core's
 * getTrainerCoinFlippers / getPowerCoinFlippers ("self" = the effect's player = "attacker").
 * Omitted when that player flipped them all (every effect but Digger's "you, opponent, you...").
 */
function toFlippedBy(flippers: CoinFlipper[]): Flipper[] | undefined {
  if (!flippers.includes("opponent")) return undefined;
  return flippers.map((flipper) => (flipper === "self" ? "attacker" : "defender"));
}

/** Who flipped each coin of the Trainer `cardId`; `view` is its player's, with the card still in the hand. */
const trainerFlippedBy = (view: GameState, cardId: string, count: number): Flipper[] | undefined =>
  toFlippedBy(getTrainerCoinFlippers(view, cardId, count));

/** Who flipped each coin of the power of `pokemonId`; `view` is its owner's. */
const powerFlippedBy = (view: GameState, pokemonId: string, count: number): Flipper[] | undefined =>
  toFlippedBy(getPowerCoinFlippers(view, pokemonId, count));

/** showCoinFlip of a Trainer's coins (Poké Ball, Digger...); `view` as in trainerFlippedBy. */
function trainerCoinInfo(view: GameState, cardId: string, trainerName: string | undefined, results: Coin[]): CoinFlipInfo {
  const flippedBy = trainerFlippedBy(view, cardId, results.length);
  return { attackName: trainerName ?? "Entrenador", results, ...(flippedBy ? { flippedBy } : {}) };
}

/**
 * Name of the Trainer `cardId` as its player sees it (`view`: theirs): the card in the hand, or
 * the card Sabrina's Psychic Control borrowed / Chaos Gym offered (not in the hand).
 */
function trainerDisplayName(view: GameState, cardId: string, handName: string | undefined): string {
  if (handName) return handName;
  if (view.pendingBorrowedTrainer?.cardId === cardId) return view.pendingBorrowedTrainer.cardName;
  if (view.pendingChaosOffer?.cardId === cardId) return view.pendingChaosOffer.cardName;
  return "";
}

/** Caption of a Trainer's coins: "Chaos Gym" for Chaos Gym's coin (game-core isChaosGymCoinPending), else the card's name. */
function trainerCoinCaption(view: GameState, cardId: string, handName: string | undefined): string | undefined {
  if (isChaosGymCoinPending(view, cardId)) return view.stadium?.card.name ?? "Chaos Gym";
  return trainerDisplayName(view, cardId, handName) || undefined;
}

/** playTrainerCard's context for the Trainer Sabrina's Psychic Control borrowed from the opponent's discard pile. */
function borrowedContext(view: GameState, cardId: string): { borrowedFromOpponentDiscard?: true } {
  return view.pendingBorrowedTrainer?.cardId === cardId ? { borrowedFromOpponentDiscard: true } : {};
}

/** showCoinFlip of a power's coins (Heal...); `view` is its owner's. */
function powerCoinInfo(view: GameState, pokemonId: string, results: Coin[]): CoinFlipInfo {
  const source = findInPlay(view, "player", pokemonId)?.pokemon.pokemon;
  const powerName = source && isPokemonCard(source) ? source.power?.name : undefined;
  const flippedBy = powerFlippedBy(view, pokemonId, results.length);
  return { attackName: powerName ?? "Poder Pokémon", results, ...(flippedBy ? { flippedBy } : {}) };
}

/** The stored state with this Trainer step pending (chooser taken from the step). */
function withTrainerChoice(state: GameState, choice: Omit<PendingTrainerChoice, "chooser">): GameState {
  const pendingTrainerChoice: PendingTrainerChoice = { ...choice, chooser: choice.step.chooser ?? "self" };
  return { ...state, pendingTrainerChoice } as RoomGameState;
}

/** What a client asks coins for before choosing (requestCoinFlip). */
export type CoinFlipRequest =
  | { purpose: "trainer"; cardId: string }
  | { purpose: "power"; pokemonId: string }
  | { purpose: "stadium" };

/** A coin flip rolled by the server (CSPRNG). Every multiplayer coin comes from here. */
export type CoinSource = () => "heads" | "tails";

function serverCoin(): "heads" | "tails" {
  return randomInt(2) === 0 ? "heads" : "tails";
}

/**
 * Run `fn` with Math.random replaced by `random` (restored even if fn throws), or as is without
 * one. Only for synchronous code: an await inside would leak the swap to other rooms.
 */
export function withRoomRandom<T>(random: (() => number) | undefined, fn: () => T): T {
  if (!random) return fn();
  const original = Math.random;
  Math.random = random;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

/** Cap for "flip until tails" (odds 2^-63 of reaching it); the last coin is then tails. */
const MAX_UNTIL_TAILS = 64;

/** Exactly the coins an engine requirement asks for. */
function rollCoins(requirement: CoinFlipRequirement, flip: CoinSource): Coin[] {
  if (requirement === "untilTails") {
    const coins: Coin[] = [];
    while (coins.length < MAX_UNTIL_TAILS - 1) {
      const coin = flip();
      coins.push(coin);
      if (coin === "tails") return coins;
    }
    coins.push("tails");
    return coins;
  }
  return Array.from({ length: requirement }, () => flip());
}

function coinsSatisfy(requirement: CoinFlipRequirement, coins: Coin[]): boolean {
  if (requirement === "untilTails") return coins.length > 0 && coins.indexOf("tails") === coins.length - 1;
  return coins.length === requirement;
}

/**
 * Trainer coins stay with the card instance; power coins with the Pokémon and Stadium action
 * coins with the Stadium card, for one turn.
 */
function effectCoinKey(player: PlayerKey, kind: "trainer" | "power" | "stadium", sourceId: string, turnNumber?: number): string {
  return kind === "trainer" ? `${player}:trainer:${sourceId}` : `${player}:${kind}:${sourceId}:${turnNumber}`;
}

/**
 * showCoinFlip of an attack's coins (game-core's AttackCoinPlan layout: [Smokescreen] + the
 * attack's own + [Stadium] + [defender]). `results` = everything but the defender coin; flippedBy
 * when the defending player flips the attack's own coins (Knock Down; Smokescreen and the Stadium
 * coin stay the attacker's); defenderFlippedBy when the attacker flips the defender coin
 * (Shadow Images, plan.defenderFlipper).
 */
export function attackCoinInfo(attackName: string, plan: AttackCoinPlan, coinResults: Coin[]): CoinFlipInfo {
  const attackerCoinCount = coinResults.length - plan.defender;
  const results = coinResults.slice(0, attackerCoinCount);
  const defenderResults = coinResults.slice(attackerCoinCount);
  // Rebellion (Misty's Gyarados): the attacker's power coins come right after Smokescreen's
  const powerCoins = plan.power ?? 0;
  const ownStart = plan.smokescreen + powerCoins;
  const ownCoins = attackerCoinCount - ownStart - (plan.stadium ?? 0);
  const flippedBy: Flipper[] | undefined =
    plan.attackFlipper === "opponent"
      ? results.map((_, i) => (i >= ownStart && i < ownStart + ownCoins ? "defender" : "attacker"))
      : undefined;
  return {
    attackName,
    results,
    ...(powerCoins > 0 && results.length >= ownStart ? { smokescreenCoins: plan.smokescreen, powerCoins } : {}),
    ...(flippedBy ? { flippedBy } : {}),
    ...(defenderResults.length > 0 ? { defenderResults } : {}),
    ...(defenderResults.length > 0 && plan.defenderFlipper === "attacker" ? { defenderFlippedBy: defenderResults.map(() => "attacker" as const) } : {}),
  };
}

/** Name of the attack a mid-attack question paused (`view`: the attacker's), for coin captions. */
function pausedAttackName(view: GameState): string | undefined {
  const resume = view.pendingAttackChoice?.reaction?.resume;
  if (!resume || resume.kind !== "attack") return undefined;
  if (resume.copiedAttack) return resume.copiedAttack.name;
  const active = view.playerActivePokemon;
  return active ? getAvailableAttacks(view, active).find((available) => available.index === resume.attackIndex)?.attack.name : undefined;
}

/** Legacy evolve target: -1 = Active, 0-4 = Bench slot (in the actor's perspective). */
function pokemonIdAt(state: GameState, targetIndex: number | undefined): string | undefined {
  if (targetIndex === undefined) return undefined;
  const pokemon = targetIndex === -1 ? state.playerActivePokemon : state.playerBench[targetIndex];
  return pokemon?.pokemon.id;
}

/**
 * A takePrize with no Prize owed: a double click (Prizes owed are a count, game-core prizesOwed;
 * each takePrize takes one until it is 0), or a click on a stale board / after the game ended.
 * Nothing to do: handlers.ts answers it without an error toast (code only).
 */
export const NO_PRIZE_OWED_CODE = "NO_PRIZE_OWED";
const noPrizeOwed = (): ActionResult => ({ success: false, code: NO_PRIZE_OWED_CODE, error: "No tienes premios por tomar" });

/** Runtime errors (bugs) carry English internals: the player gets a Spanish line instead. */
const ACTION_FAILED = "No se pudo realizar la acción";
const isProgrammingError = (error: unknown) =>
  error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError;

/** The Spanish reason of a game-core IllegalActionError (illegal move), else null. */
function illegalReason(error: unknown): string | null {
  if (error instanceof IllegalActionError) return error.reason;
  if (error instanceof Error && error.name === "IllegalActionError") return (error as IllegalActionError).reason ?? error.message;
  return null;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** Stable code of some rejections (NO_PRIZE_OWED_CODE). */
  code?: string;
  gameState?: GameState;
  gameOver?: boolean;
  winner?: "player1" | "player2";
  /** The game ended in a draw (Lucky Duel: both Actives Knocked Out at once): no winner. */
  draw?: boolean;
  /** Coins every client animates (attacks, confusion tails): showCoinFlip to the room */
  coinFlipInfo?: CoinFlipInfo;
  /**
   * A confused attacker's heads: its own showCoinFlip ("Confusión"), sent BEFORE coinFlipInfo (the
   * attack's coins, if any). Tails is coinFlipInfo itself (the attack doesn't happen).
   */
  confusionCoinFlipInfo?: CoinFlipInfo;
  /** Trainer/power coins: showCoinFlip to everyone but the player who already showed them (requestCoinFlip) */
  opponentCoinFlipInfo?: CoinFlipInfo;
  /** That player (default: the actor; differs when the opponent answered a Trainer's last step) */
  coinsShownTo?: PlayerKey;
  /**
   * The attack stopped at a question asked in the middle of it (pendingAttackChoice.reaction:
   * Flee, Bench Guard, Sabrina's ESP, Charity): it hasn't happened yet (no attackedThisTurn, the
   * turn goes on) until resolveAttackChoice answers it.
   */
  attackPaused?: boolean;
  winReason?: string;
  setupTimerStarted?: number; // timestamp when setup timer started (ms)
}

/**
 * Neutralize perspective-specific event messages for multiplayer.
 * Replaces "Tú"/"tu"/"Rival" with "Jugador 1"/"Jugador 2" so both
 * players see the same neutral logs.
 *
 * @param events - Full events array
 * @param fromIndex - Only process events from this index onward
 * @param self - Name for the "Tú/tu" perspective (the acting player)
 * @param opponent - Name for the "Rival" perspective
 */
export function neutralizeEvents(
  events: GameState["events"],
  fromIndex: number,
  self: string,
  opponent: string
): GameState["events"] {
  if (fromIndex >= events.length) return events;

  // Exact string replacements [search, replacement] - order matters (longer first)
  const replacements: [string, string][] = [
    // Victory/Defeat
    ["¡Victoria! Has tomado todos tus premios", `Victoria de ${self}: tomó todos sus premios`],
    ["¡Derrota! El rival tomó todos sus premios", `Victoria de ${opponent}: tomó todos sus premios`],
    ["¡Victoria! El rival no tiene más Pokémon", `Victoria de ${self}. ${opponent} no tiene más Pokémon`],
    ["¡Derrota! No tienes más Pokémon", `Victoria de ${opponent}. ${self} no tiene más Pokémon`],
    ["¡Victoria! El rival no tiene cartas para robar", `Victoria de ${self}. ${opponent} no tiene cartas para robar`],
    ["¡Derrota! No tienes cartas para robar", `Victoria de ${opponent}. ${self} no tiene cartas para robar`],
    // Exit
    ["Ya puedes salir de la mesa", "Partida finalizada"],
    // Deck out
    ["¡No puedes robar! Tu mazo está vacío", `¡${self} no puede robar! Mazo vacío`],
    ["El rival no puede robar! Su mazo está vacío", `¡${opponent} no puede robar! Mazo vacío`],
    // Prize (specific first)
    ["El rival tomó un premio por el contraataque", `${opponent} tomó un premio por el contraataque`],
    ["El rival puede tomar un premio", `${opponent} puede tomar un premio`],
    ["El rival tomó un premio", `${opponent} tomó un premio`],
    // takePrize's line (also inside attacks and the checkup since the last Prize is taken on its own)
    ["Tomaste un premio", `${self} tomó un premio`],
    ["¡Puedes tomar un premio!", `${self} puede tomar un premio`],
    // Turn end
    ["Fin de tu turno", `Fin del turno de ${self}`],
    ["Fin del turno del rival", `Fin del turno de ${opponent}`],
    // Card draw
    ["Robaste una carta", `${self} robó una carta`],
    ["El rival robó una carta", `${opponent} robó una carta`],
    // Setup
    ["Tú robas 7 cartas y colocas 6 premios", `${self} roba 7 cartas y coloca 6 premios`],
    ["Rival roba 7 cartas y coloca 6 premios", `${opponent} roba 7 cartas y coloca 6 premios`],
    // Mulligan
    ["Tú hiciste mulligan", `${self} hizo mulligan`],
    ["Rival hizo mulligan", `${opponent} hizo mulligan`],
    // Ready
    ["Tú estás listo", `${self} está listo`],
    ["Rival está listo", `${opponent} está listo`],
    // Game start
    ["Tú empiezas", `${self} empieza`],
    ["Rival empieza", `${opponent} empieza`],
  ];

  // Regex replacements for partial/contextual matches. Base Set / Jungle lines still use these
  // relative forms ("pasa a ser el Pokémon activo del rival", "tu mazo", "Barajaste"...);
  // Fossil / Team Rocket lines are perspective-free in game-core and need none of their own.
  const regexReplacements: [RegExp, string][] = [
    // endTurn writes "Turno 3 - Tu turno" / "Turno 3 - Turno del rival"
    [/\bTu turno$/, `Turno de ${self}`],
    [/\bTurno del rival$/, `Turno de ${opponent}`],
    [/es ahora tu Pokémon activo/g, `es ahora el Pokémon activo de ${self}`],
    [/pasa a ser tu Pokémon activo/g, `pasa a ser el Pokémon activo de ${self}`],
    [/Pokémon activo del rival/g, `Pokémon activo de ${opponent}`],
    [/coloca tus Pokémon básicos/g, `coloca sus Pokémon básicos`],
    [/tu banca/g, `la banca de ${self}`],
    [/tu Pokémon activo/g, `el Pokémon activo de ${self}`],
    [/ \(rival\)/g, ""],
    // Privacy: strip card names from deck search results (Poké Ball, etc.)
    [/Salió cara — encontraste .+ en tu mazo/, `Moneda: [coin:heads]`],
    [/Salió cruz — no se encontró ninguna carta/, `Moneda: [coin:tails]`],
    // Also neutralize remaining "Encontraste X" patterns
    [/Encontraste (.+?) en tu mazo/g, `${self} encontró una carta en su mazo`],
    // Adjuntar energy — "Tú adjuntaste" / "Rival adjuntó"
    [/Tú adjuntaste/g, `${self} adjuntó`],
    [/Rival adjuntó/g, `${opponent} adjuntó`],
    // game-core board actions, Trainers and powers (second person, acting side)
    [/^Colocaste /, `${self} colocó `],
    [/^Adjuntaste /, `${self} adjuntó `],
    [/^Jugaste /, `${self} jugó `],
    [/^Robaste (\d+) carta/, `${self} robó $1 carta`],
    [/^Descartaste /, `${self} descartó `],
    [/^Barajaste /, `${self} barajó `],
    [/^Reordenaste /, `${self} reordenó `],
    [/^El rival barajó /, `${opponent} barajó `],
    [/ de tu mano/g, " de su mano"],
    [/ tu mazo/g, " su mazo"],
    [/^Turno de Jugador$/, `Turno de ${self}`],
    [/^Turno de Rival$/, `Turno de ${opponent}`],
    // game-core's AI executor (adventure rooms) writes the AI's moves as "Rival colocó / jugó …"
    // from the human's view: name it, so masking's opening rule (hideSetupBoard) also hides them
    [/^Rival (?=[a-záéíóú])/, `${opponent} `],
  ];

  const newEvents = [...events];
  for (let i = fromIndex; i < newEvents.length; i++) {
    let msg = newEvents[i].message;

    for (const [search, replace] of replacements) {
      if (msg.includes(search)) {
        msg = msg.replace(search, replace);
      }
    }

    for (const [regex, replace] of regexReplacements) {
      msg = msg.replace(regex, replace);
    }

    if (msg !== newEvents[i].message) {
      newEvents[i] = { ...newEvents[i], message: msg };
    }
  }

  return newEvents;
}

/** What a Lucky Duel player is told when acting before both Actives are revealed. */
export const LUCKY_DUEL_FACE_DOWN_ERROR = "Pulsa Listo: los Pokémon activos se revelan cuando ambos jugadores estén listos";

const FORFEIT_TIMEOUT_MS = 120_000; // 2 minutes
const SETUP_TIMEOUT_MS = 90_000; // 90 seconds for opponent to finish setup
/**
 * Waiting tables survive their creator's lobby socket (reload, another page, a dropped
 * connection). While the creator is online anywhere (any socket, the frontend's presence socket
 * included) the table stays listed and joinable; while they are offline it is hidden and can't be
 * joined, and it closes once they have been offline this long.
 */
export const WAITING_TABLE_OFFLINE_TTL_MS = 30 * 60_000;
/** A waiting table closes this long after it was created or its creator last opened it, even if they stay online. */
export const WAITING_TABLE_IDLE_TTL_MS = 60 * 60_000;
/**
 * A rival sat at a table whose creator wasn't at it (no seat socket): the creator gets the
 * `tableJoined` alert and has this long to open the table (the game starts then). After it the
 * rival may claim the victory (owner rule: a no-show is a forfeit, claimNoShow); until they do
 * (or leave, which reopens the table) the creator can still come in and play.
 */
export const CREATOR_RESPONSE_MS = 90_000;

/** Why the manager closed a waiting table on its own. */
export type TableCloseReason = "offline" | "idle";

/** claimNoShow refused: the rival can't claim (yet). */
export class NoShowClaimError extends Error {
  readonly code = "NO_SHOW_CLAIM_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "NoShowClaimError";
  }
}
/**
 * A finished room lives this long after its game ended, so both players can still chat and send
 * emotes ("gg") from the game-over screen (sweepRooms).
 */
export const FINISHED_ROOM_TTL_MS = 120_000;

type ForfeitCallback = (
  roomId: string,
  winner: "player1" | "player2",
  gameState: GameState,
  reason?: string,
) => void;

/** A room with an open match is dropped without a result (admin close, everybody gone): refund it. */
type AbandonCallback = (room: GameRoom, reason: string) => void;

/**
 * A waiting table the manager closed on its own (TTL, or its creator never answered a rival):
 * refresh the lists and tell the creator (and the waiting rival, if any: `room.player2Id`).
 */
type RoomClosedCallback = (roomId: string, room: GameRoom, reason: TableCloseReason) => void;

/** The rival waiting for an away creator left (leaveRoom / disconnect): the table reopened. */
type JoinCancelledCallback = (room: GameRoom, joinerUserId: string) => void;

/** The away creator's window ended: the waiting rival may claim the victory (claimNoShow). */
type NoShowClaimableCallback = (room: GameRoom) => void;

/** The server answered for a player whose answer clock ran out (`action` = what it sent for them). */
type AutoAnswerCallback = (roomId: string, side: PlayerKey, action: { type: string }, result: ActionResult) => void;

export interface GameRoomManagerOptions {
  /** How long an away creator has to open a table a rival sat at (default CREATOR_RESPONSE_MS). */
  creatorResponseMs?: number;
  /** Whether a user has any socket (default: presence.ts, the main server's sockets). */
  isUserOnline?: (userId: string) => boolean;
  /** Where the server's random picks come from (a timed-out Misty's Duel pick); default CSPRNG. */
  random?: () => number;
}

/** A uniform number in [0, 1) from the CSPRNG. */
function serverRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

export class GameRoomManager {
  private rooms: Map<string, GameRoom> = new Map();
  private socketToRoom: Map<string, string> = new Map();
  private forfeitTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private creatorResponseTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private setupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private setupTimerStartTimes: Map<string, number> = new Map(); // roomId → Date.now()
  private onForfeitCallback: ForfeitCallback | null = null;
  private onAbandonCallback: AbandonCallback | null = null;
  private onRoomClosedCallback: RoomClosedCallback | null = null;
  private onJoinCancelledCallback: JoinCancelledCallback | null = null;
  private onNoShowClaimableCallback: NoShowClaimableCallback | null = null;
  private onAutoAnswerCallback: AutoAnswerCallback | null = null;
  private answerTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly creatorResponseMs: number;
  private readonly isUserOnline: (userId: string) => boolean;

  /** @param flipCoin - where every coin of this manager's games comes from (tests pass a scripted one) */
  constructor(private readonly flipCoin: CoinSource = serverCoin, options: GameRoomManagerOptions = {}) {
    this.creatorResponseMs = options.creatorResponseMs ?? CREATOR_RESPONSE_MS;
    this.isUserOnline = options.isUserOnline ?? isUserOnline;
    this.random = options.random ?? serverRandom;
  }

  private readonly random: () => number;

  /**
   * Set the callback for when a player forfeits due to disconnect timeout.
   */
  setOnForfeit(callback: ForfeitCallback): void {
    this.onForfeitCallback = callback;
  }

  /** Set the callback for rooms dropped while their match is still open (refunds the bets). */
  setOnAbandon(callback: AbandonCallback): void {
    this.onAbandonCallback = callback;
  }

  /** The room goes away without a result: if it had an open match, let the owner refund it. */
  private abandonMatch(room: GameRoom, reason: string): void {
    // Without a match row only a started game matters (a draft round waits for its result).
    // An adventure battle has no match: its run keeps the battle and rebuilds the room on rejoin.
    // A gym battle has none either: gym-room.ts ends it.
    if (hasAISeat(room) || room.resultSettled || (!room.matchId && !room.gameState)) return;
    this.onAbandonCallback?.(room, reason);
  }

  /** Set the callback for answers the server gave for a player out of time (broadcast like an action). */
  setOnAutoAnswer(callback: AutoAnswerCallback): void {
    this.onAutoAnswerCallback = callback;
  }

  /** Set the callback for waiting tables the manager closes on its own (TTL, creator never answered). */
  setOnRoomClosed(callback: RoomClosedCallback): void {
    this.onRoomClosedCallback = callback;
  }

  /** Set the callback for a rival who stopped waiting for an away creator (the table reopened). */
  setOnJoinCancelled(callback: JoinCancelledCallback): void {
    this.onJoinCancelledCallback = callback;
  }

  /** Set the callback for a waiting rival who may now claim the victory (the creator's window ended). */
  setOnNoShowClaimable(callback: NoShowClaimableCallback): void {
    this.onNoShowClaimableCallback = callback;
  }

  /**
   * Whether a waiting table's creator can be reached: at the table (seat socket) or online
   * anywhere else (they get the `tableJoined` alert). Only such tables are listed and joinable.
   */
  isCreatorReachable(room: GameRoom): boolean {
    if (room.player1SocketId) return true;
    return room.player1Id ? this.isUserOnline(room.player1Id) : false;
  }

  /** A lobby table anyone may take the free seat of now (listed in the lobby). */
  isJoinable(room: GameRoom): boolean {
    return room.status === "waiting" && !room.isDraft && !hasAISeat(room) && !!room.player1Id && !room.player2Id && this.isCreatorReachable(room);
  }

  /** The user's waiting tables: the creator was seen online now (offline TTL restarts). */
  markCreatorSeen(userId: string, now = Date.now()): void {
    for (const room of this.findWaitingRoomsByUser(userId)) room.creatorSeenAt = now;
  }

  /**
   * The creator's lobby socket becomes the seat of all their waiting tables (attachMyRooms), like
   * a joinRoom to each: their idle TTL restarts and a rival waiting for them stops waiting (the
   * caller starts that game). The socket maps to a table with a rival, else to any of them.
   */
  attachCreatorSocket(userId: string, socketId: string): GameRoom[] {
    const now = Date.now();
    // Not a table whose game is starting or whose no-show claim is being settled
    const rooms = this.findWaitingRoomsByUser(userId).filter((r) => !r.startPending);
    for (const room of rooms) {
      room.player1SocketId = socketId;
      room.creatorSeenAt = room.touchedAt = now;
      this.cancelCreatorResponseTimer(room.id);
      room.awaitingCreator = undefined;
    }
    const mapped = rooms.find((r) => r.player2Id) ?? rooms[0];
    if (mapped) this.socketToRoom.set(socketId, mapped.id);
    return rooms;
  }

  /** Whose seat in `room` belongs to `userId`, or null. */
  seatOf(room: GameRoom, userId: string): PlayerKey | null {
    if (room.player1Id === userId) return "player1";
    if (room.player2Id === userId) return "player2";
    return null;
  }

  /**
   * The clock clients show (RoomClock): an off-turn answer's while one is pending, else the
   * awaited player's turn clock.
   */
  getClock(room: GameRoom): RoomClock {
    const userOf = (side: PlayerKey): string | null => (side === "player1" ? room.player1Id : room.player2Id);
    const answer = room.status === "playing" ? room.answerClock : undefined;
    if (answer) {
      const turnSide: PlayerKey = room.gameState?.isPlayerTurn ? "player1" : "player2";
      return {
        kind: "answer",
        userId: userOf(answer.side),
        startedAt: answer.startedAt,
        // Not rounded: the turn clock's own duration is reported as is (a timed step's is whole seconds)
        durationSeconds: answer.durationMs / 1000,
        pausedUserId: userOf(turnSide),
        pausedRemainingSeconds: Math.round(answer.turnRemainingMs / 1000),
      };
    }
    return { kind: "turn", userId: this.getAwaitingUserId(room), startedAt: room.turnStartedAt, durationSeconds: room.turnTimerDuration };
  }

  /** userId of the player the game is waiting on (see awaitedSide), or null. */
  getAwaitingUserId(room: GameRoom): string | null {
    const side = room.status === "playing" ? awaitedSide(room.gameState) : null;
    if (side === "player1") return room.player1Id;
    if (side === "player2") return room.player2Id;
    return null;
  }

  /**
   * Create a new room
   */
  createRoom(roomId?: string, config?: Partial<RoomConfig>, creator?: Partial<CreatorInfo>): GameRoom {
    const id = roomId || this.generateRoomId();
    const mode: RoomMode = config?.mode ?? "standard";
    const luckyDuel = mode === "lucky-duel";
    const prizeCount = config?.prizeCount ?? 6;
    const room: GameRoom = {
      id,
      status: "waiting",
      player1Id: null,
      player1SocketId: null,
      player1Ready: false,
      player1DeckId: null,
      player2Id: null,
      player2SocketId: null,
      player2Ready: false,
      player2DeckId: null,
      gameState: null,
      turnStartedAt: null,
      turnTimerDuration: 180,
      spectators: new Map(),
      chat: [],
      config: {
        mode,
        // Lucky Duel: no Prizes (whatever the caller asked)
        prizeCount: luckyDuel ? 0 : prizeCount >= 4 && prizeCount <= 6 ? prizeCount : 6,
        betAmount: config?.betAmount ?? 0,
        reservedUserId: config?.reservedUserId ?? null,
        friendly: config?.friendly ?? false,
      },
      creator: {
        username: creator?.username ?? null,
        avatarId: creator?.avatarId ?? null,
        titleId: creator?.titleId ?? null,
      },
      joiner: {
        username: null,
        avatarId: null,
        titleId: null,
      },
      players: [],
      createdAt: new Date(),
    };
    room.creatorSeenAt = room.touchedAt = room.createdAt.getTime();

    this.rooms.set(id, room);
    return room;
  }

  /**
   * A Modo Aventura battle (adventure-room.ts): already playing, player 1 = the user (reserved:
   * nobody else may join or watch), player 2 = the server's AI (no user, no socket; `rival` is
   * what the player sees as their opponent). Never listed in the lobby.
   */
  createAdventureRoom(input: {
    roomId: string;
    runId: string;
    userId: string;
    rival: CreatorInfo;
    gameState: GameState;
    engineRandom: () => number;
    coinSource: CoinSource;
  }): GameRoom {
    if (this.rooms.has(input.roomId)) throw new Error(`La sala ${input.roomId} ya existe`);
    const room = this.createRoom(input.roomId, { mode: "adventure", friendly: true, reservedUserId: input.userId });
    room.config.prizeCount = input.gameState.playerPrizes.length;
    room.status = "playing";
    room.player1Id = input.userId;
    room.players = [input.userId];
    room.joiner = { ...input.rival };
    room.gameState = input.gameState;
    room.turnStartedAt = Date.now();
    room.adventure = { runId: input.runId, userId: input.userId };
    room.engineRandom = input.engineRandom;
    room.coinSource = input.coinSource;
    return room;
  }

  /** Drop an adventure room from memory (idle, or its battle ended): no callbacks, no settlement. */
  removeAdventureRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room?.adventure) return;
    this.rooms.delete(roomId);
    this.unmapRoomSockets(room);
  }

  /**
   * A Gym Leader battle (gym-room.ts): already playing, player 1 = the challenger (reserved:
   * nobody else may join or watch), player 2 = the leader (the server's AI, no user, no socket).
   * Never listed in the lobby. `turnTimerDuration`: the challenger's clock (gym-room.ts runs it).
   */
  createGymRoom(input: {
    roomId: string;
    leaderId: string;
    mode: "normal" | "expert";
    userId: string;
    deckId: string;
    rival: CreatorInfo;
    gameState: GameState;
    turnTimerSeconds: number;
    engineRandom: () => number;
    coinSource: CoinSource;
  }): GameRoom {
    if (this.rooms.has(input.roomId)) throw new Error(`La sala ${input.roomId} ya existe`);
    const room = this.createRoom(input.roomId, { mode: "gym", friendly: true, reservedUserId: input.userId });
    room.config.prizeCount = input.gameState.playerPrizes.length;
    room.status = "playing";
    room.player1Id = input.userId;
    room.player1DeckId = input.deckId;
    room.players = [input.userId];
    room.joiner = { ...input.rival };
    room.gameState = input.gameState;
    room.turnStartedAt = Date.now();
    room.turnTimerDuration = input.turnTimerSeconds;
    room.gym = { leaderId: input.leaderId, mode: input.mode, userId: input.userId };
    room.engineRandom = input.engineRandom;
    room.coinSource = input.coinSource;
    return room;
  }

  /** Drop a gym room from memory (its battle ended): no callbacks, no settlement. */
  removeGymRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room?.gym) return;
    this.rooms.delete(roomId);
    this.unmapRoomSockets(room);
  }

  /**
   * An action the server takes for a seat (gym battles: the leader's answer to a step of the
   * challenger's Trainer, which the AI driver doesn't cover). Same checks as a player's action.
   */
  async executeServerAction(roomId: string, side: PlayerKey, rawAction: unknown): Promise<ActionResult> {
    return this.runAction(roomId, { side }, rawAction);
  }

  /**
   * Join an existing room: reconnect to your seat, or take the free one. A room that doesn't
   * exist is never created here (RoomNotFoundError): the client asking for it is rejoining a
   * game that is gone (e.g. after an API restart), and rooms only come from createRoom.
   */
  async joinRoom(roomId: string, userId: string, socketId: string, displayInfo?: Partial<CreatorInfo>): Promise<GameRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomNotFoundError();

    // Check reservation (only for new player2 joins, not reconnects)
    if (room.config.reservedUserId && room.player1Id && !room.player2Id && room.config.reservedUserId !== userId && room.player1Id !== userId) {
      throw new Error("Esta mesa está reservada para otro jugador");
    }

    // Reconnecting, also to a waiting room (the creator from another tab): a user never takes both seats
    if (room.player1Id === userId) {
      room.player1SocketId = socketId;
      this.socketToRoom.set(socketId, roomId);
      this.cancelForfeitTimer(roomId, "player1");
      this.cancelCleanupTimer(roomId);
      if (room.status === "waiting" && !room.startPending) {
        // The creator opened their table: its idle TTL restarts, and a rival waiting for them
        // plays now (the caller starts the game: both seats have a socket). Not while a no-show
        // claim is being settled (startPending): that table is lost.
        room.creatorSeenAt = room.touchedAt = Date.now();
        this.cancelCreatorResponseTimer(roomId);
        room.awaitingCreator = undefined;
      }
      return room;
    }
    if (room.player2Id === userId) {
      room.player2SocketId = socketId;
      this.socketToRoom.set(socketId, roomId);
      this.cancelForfeitTimer(roomId, "player2");
      this.cancelCleanupTimer(roomId);
      return room;
    }

    // Check if room is full
    if (room.player1Id && room.player2Id) {
      throw new Error("La mesa está llena");
    }

    // Taking a seat at a lobby table closes your waiting tables, but only if nobody sat at one of
    // them yet: then you are sent to that table instead (checked here, atomically with the join).
    // Draft games seat their players through here too and are left out.
    if (!room.isDraft) {
      for (const other of this.rooms.values()) {
        if (other.id !== roomId && !other.isDraft && !hasAISeat(other) && other.player1Id === userId && other.player2Id && other.status !== "finished") {
          throw new OwnTableTakenError(other.id);
        }
        // Already waiting for another table's creator: one seat at a time
        if (other.id !== roomId && other.awaitingCreator && other.status === "waiting" && other.player2Id === userId) {
          throw new Error("Ya estás esperando al creador de otra mesa");
        }
      }
    }

    // The creator of a waiting table is offline (no socket at all): the table is kept for them
    // but nobody may sit and wait on a ghost
    if (room.status === "waiting" && room.player1Id && !room.isDraft && !this.isCreatorReachable(room)) {
      throw new Error("El creador de la mesa no está conectado");
    }
    if (room.status !== "waiting") {
      throw new Error("La partida ya comenzó");
    }

    // Add player to room
    if (!room.player1Id) {
      room.player1Id = userId;
      room.player1SocketId = socketId;
      room.players.push(userId);
    } else if (!room.player2Id) {
      room.player2Id = userId;
      room.player2SocketId = socketId;
      room.players.push(userId);
      // Store joiner display info
      if (displayInfo) {
        room.joiner = {
          username: displayInfo.username ?? null,
          avatarId: displayInfo.avatarId ?? null,
          titleId: displayInfo.titleId ?? null,
        };
      }
      // The creator isn't at their table (online elsewhere): the game waits for them to open it
      if (!room.isDraft && room.player1Id && !room.player1SocketId) {
        const now = Date.now();
        room.awaitingCreator = { joinedAt: now, expiresAt: now + this.creatorResponseMs };
        this.startCreatorResponseTimer(roomId);
      }
    }

    this.socketToRoom.set(socketId, roomId);
    return room;
  }

  /** A rival sat at this table and waits for its away creator to open it. */
  isAwaitingCreator(room: GameRoom): boolean {
    return room.status === "waiting" && !!room.awaitingCreator && !!room.player2Id;
  }

  private startCreatorResponseTimer(roomId: string): void {
    this.cancelCreatorResponseTimer(roomId);
    const timer = setTimeout(() => this.expireAwaitingCreator(roomId), this.creatorResponseMs);
    timer.unref?.();
    this.creatorResponseTimers.set(roomId, timer);
  }

  private cancelCreatorResponseTimer(roomId: string): void {
    const timer = this.creatorResponseTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.creatorResponseTimers.delete(roomId);
    }
  }

  /**
   * The away creator didn't open their table in time (CREATOR_RESPONSE_MS): the rival may claim
   * the victory now (onNoShowClaimable). Public so tests can end the window without waiting.
   * Returns whether the window ended for a waiting rival.
   */
  expireAwaitingCreator(roomId: string, now = Date.now()): boolean {
    this.cancelCreatorResponseTimer(roomId);
    const room = this.rooms.get(roomId);
    if (!room || !this.isAwaitingCreator(room) || !room.awaitingCreator) return false;
    room.awaitingCreator.expiresAt = Math.min(room.awaitingCreator.expiresAt, now);
    this.onNoShowClaimableCallback?.(room);
    return true;
  }

  /**
   * The rival claims the victory over a creator who didn't come in time (owner rule: a no-show
   * is a forfeit). Only the seated rival, only once the window ended, only while the creator
   * still hasn't opened the table. Marks the room as settling (startPending: the creator's
   * arrival can't start it meanwhile); the caller opens the match, settles it (winner: player 2)
   * and removes the table with finishNoShow.
   */
  claimNoShow(roomId: string, userId: string, now = Date.now()): GameRoom {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== "waiting" || room.isDraft || hasAISeat(room)) throw new NoShowClaimError("La mesa ya no existe");
    if (room.player2Id !== userId) throw new NoShowClaimError("No estás esperando en esta mesa");
    if (!this.isAwaitingCreator(room) || !room.awaitingCreator || room.startPending) throw new NoShowClaimError("El creador ya llegó a la mesa");
    if (now < room.awaitingCreator.expiresAt) throw new NoShowClaimError("Todavía no puedes reclamar la victoria: el creador aún tiene tiempo");
    this.cancelCreatorResponseTimer(roomId);
    room.startPending = true;
    return room;
  }

  /** The no-show was settled: the table is over and goes away (no callbacks). */
  finishNoShow(room: GameRoom): void {
    room.status = "finished";
    room.startPending = false;
    room.awaitingCreator = undefined;
    this.cancelCreatorResponseTimer(room.id);
    this.cancelAnswerTimer(room.id);
    this.unmapRoomSockets(room);
    if (this.rooms.get(room.id) === room) this.rooms.delete(room.id);
  }

  /** Remove a waiting table the manager closes on its own, and report it (onRoomClosed). */
  private closeWaitingTable(room: GameRoom, reason: TableCloseReason): void {
    console.log(`🗑️ Waiting table ${room.id} closed (${reason})`);
    this.cancelCreatorResponseTimer(room.id);
    this.cancelAnswerTimer(room.id);
    this.rooms.delete(room.id);
    this.unmapRoomSockets(room);
    this.onRoomClosedCallback?.(room.id, room, reason);
  }

  /**
   * The rival waiting for an away creator gives up their seat (leaveRoom, disconnect): the table
   * is open again and the creator is told (onJoinCancelled).
   */
  private releaseWaitingJoiner(room: GameRoom): void {
    const joinerUserId = room.player2Id;
    if (room.player2SocketId) this.unmapSocket(room.player2SocketId, room.id);
    room.player2Id = null;
    room.player2SocketId = null;
    room.player2Ready = false;
    room.player2DeckId = null;
    room.players = room.players.filter((id) => id !== joinerUserId);
    room.joiner = { username: null, avatarId: null, titleId: null };
    const wasAwaiting = !!room.awaitingCreator;
    room.awaitingCreator = undefined;
    this.cancelCreatorResponseTimer(room.id);
    if (wasAwaiting && joinerUserId) this.onJoinCancelledCallback?.(room, joinerUserId);
  }

  /**
   * Leave a room
   */
  async leaveRoom(roomId: string, socketId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // Leaving an adventure battle keeps it (the map's "Continuar"): only surrendering loses it.
    // A gym battle too, but its challenger's disconnect grace starts (gym-room.ts seatChanged).
    if (hasAISeat(room)) {
      if (room.player1SocketId === socketId) room.player1SocketId = null;
      this.unmapSocket(socketId, roomId);
      return;
    }

    // Leaving a game in progress is a forfeit: the other player wins (and takes the bet). Before
    // this, a losing player could leave, let the room die and escape the result.
    const leavingSide = room.player1SocketId === socketId ? "player1" : room.player2SocketId === socketId ? "player2" : null;
    if (leavingSide && room.status === "playing" && room.gameState) {
      room.status = "finished";
      this.cancelAnswerTimer(roomId);
      this.cancelSetupTimer(roomId);
      this.onForfeitCallback?.(roomId, leavingSide === "player1" ? "player2" : "player1", room.gameState, "El rival abandonó la partida");
    }

    if (room.player1SocketId === socketId) {
      room.player1Id = null;
      room.player1SocketId = null;
      room.player1Ready = false;
    } else if (room.player2SocketId === socketId) {
      if (room.status === "waiting") {
        // The rival stops waiting (for an away creator, or a bet they can't cover): the table reopens
        this.releaseWaitingJoiner(room);
      } else {
        room.player2Id = null;
        room.player2SocketId = null;
        room.player2Ready = false;
      }
    }

    this.unmapSocket(socketId, roomId);

    // Remove room if empty
    if (!room.player1Id && !room.player2Id) {
      this.abandonMatch(room, "Ambos jugadores abandonaron la mesa");
      this.cancelCreatorResponseTimer(roomId);
      room.status = "finished";
      this.cancelAnswerTimer(roomId);
      this.rooms.delete(roomId);
    }
  }

  /**
   * Set player as ready
   */
  async setPlayerReady(roomId: string, socketId: string): Promise<GameRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomNotFoundError();

    if (room.player1SocketId === socketId) {
      room.player1Ready = true;
    } else if (room.player2SocketId === socketId) {
      room.player2Ready = true;
    } else {
      throw new Error("No juegas en esta mesa");
    }

    return room;
  }

  /**
   * Set player's deck selection
   */
  setPlayerDeck(roomId: string, socketId: string, deckId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomNotFoundError();

    if (room.player1SocketId === socketId) {
      room.player1DeckId = deckId;
    } else if (room.player2SocketId === socketId) {
      room.player2DeckId = deckId;
    }
  }

  /**
   * Start the game.
   *
   * When `resolvedDecks` is provided (pre-resolved GameCard arrays from
   * user database decks) those cards are used directly.  Otherwise the
   * room's deckId values are treated as built-in theme deck IDs.
   */
  async startGame(
    roomId: string,
    resolvedDecks?: { player1Cards: GameCard[]; player2Cards: GameCard[] },
  ): Promise<GameState> {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomNotFoundError();

    if (!room.player1Id || !room.player2Id) {
      throw new Error("Faltan jugadores para empezar la partida");
    }

    room.status = "playing";

    let gameState: GameState;

    if (resolvedDecks) {
      // Use pre-resolved card arrays (user database decks)
      gameState = {
        playerDeck: shuffle(resolvedDecks.player1Cards),
        playerHand: [],
        playerPrizes: [],
        playerDiscard: [],
        playerActivePokemon: null,
        playerBench: [],
        opponentDeck: shuffle(resolvedDecks.player2Cards),
        opponentHand: [],
        opponentPrizes: [],
        opponentDiscard: [],
        opponentActivePokemon: null,
        opponentBench: [],
        selectedDeckId: "custom",
        turnNumber: 0,
        startingPlayer: null,
        isPlayerTurn: false,
        gameStarted: false,
        gamePhase: GamePhase.Mulligan,
        playerReady: false,
        opponentReady: false,
        energyAttachedThisTurn: false,
        retreatedThisTurn: false,
        playerCanTakePrize: false,
        opponentCanTakePrize: false,
        playerNeedsToPromote: false,
        opponentNeedsToPromote: false,
        activeModifiers: [],
        gameResult: null,
        events: [createGameEvent("Partida inicializada", "system")],
      };
      gameState = startGame(gameState);
    } else {
      // Fall back to built-in theme decks
      const player1Deck = getDeckById(room.player1DeckId || "brushfire") || decks[0];
      const player2Deck = getDeckById(room.player2DeckId || "overgrowth") || decks[1];
      gameState = initializeMultiplayerGame(player1Deck, player2Deck);
      gameState = startGame(gameState);
    }

    // Adjust prize count if room is configured for fewer prizes
    const trimCount = 6 - room.config.prizeCount;
    if (trimCount > 0) {
      const excessPlayer = gameState.playerPrizes.splice(-trimCount);
      gameState.playerDeck.push(...excessPlayer);
      const excessOpponent = gameState.opponentPrizes.splice(-trimCount);
      gameState.opponentDeck.push(...excessOpponent);
    }

    // Neutralize initial events (always canonical: Tú=P1, Rival=P2)
    gameState = {
      ...gameState,
      events: neutralizeEvents(gameState.events, 0, "Jugador 1", "Jugador 2"),
    };

    room.gameState = gameState;
    room.turnStartedAt = Date.now();
    return room.gameState;
  }

  /**
   * Start a Lucky Duel table: each seat gets a random Basic Pokémon and a deck built around it
   * (game-core drawLuckyDuel, server RNG), dealt by initializeLuckyDuelGame — both Actives placed
   * face down, 7-card hands, no Prizes. No startGame and no Prize trimming (the engine already
   * dealt); then the usual playerReady ×2 → startPlayingPhase, which reveals the Actives.
   */
  async startLuckyDuelGame(roomId: string): Promise<GameState> {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomNotFoundError();
    if (!room.player1Id || !room.player2Id) {
      throw new Error("Faltan jugadores para empezar la partida");
    }

    room.status = "playing";
    const draw1 = drawLuckyDuel(this.random);
    const draw2 = drawLuckyDuel(this.random);
    room.luckyDuelStarters = { player1: draw1.active.id, player2: draw2.active.id };
    let gameState = initializeLuckyDuelGame(draw1, draw2, this.random);
    gameState = { ...gameState, events: neutralizeEvents(gameState.events, 0, "Jugador 1", "Jugador 2") };

    room.gameState = gameState;
    room.turnStartedAt = Date.now();
    return room.gameState;
  }

  /**
   * Start a game using raw card arrays (for draft matches).
   * Creates a GameState directly from pre-built decks instead of DeckEntry definitions.
   * `prizeCount`: the draft's Prize cards per player (4-6, default 6).
   */
  async startGameWithRawDecks(
    roomId: string,
    player1Cards: GameCard[],
    player2Cards: GameCard[],
    prizeCount = 6,
  ): Promise<GameState> {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomNotFoundError();
    if (!room.player1Id || !room.player2Id) {
      throw new Error("Faltan jugadores para empezar la partida");
    }

    room.status = "playing";

    let gameState: GameState = {
      playerDeck: shuffle(player1Cards),
      playerHand: [],
      playerPrizes: [],
      playerDiscard: [],
      playerActivePokemon: null,
      playerBench: [],
      opponentDeck: shuffle(player2Cards),
      opponentHand: [],
      opponentPrizes: [],
      opponentDiscard: [],
      opponentActivePokemon: null,
      opponentBench: [],
      selectedDeckId: "draft",
      turnNumber: 0,
      startingPlayer: null,
      isPlayerTurn: false,
      gameStarted: false,
      gamePhase: GamePhase.Mulligan,
      playerReady: false,
      opponentReady: false,
      energyAttachedThisTurn: false,
      retreatedThisTurn: false,
      playerCanTakePrize: false,
      opponentCanTakePrize: false,
      playerNeedsToPromote: false,
      opponentNeedsToPromote: false,
      activeModifiers: [],
      gameResult: null,
      events: [createGameEvent("Partida de draft inicializada", "system")],
    };

    gameState = startGame(gameState, { prizeCount });
    room.config.prizeCount = gameState.prizeCount ?? prizeCount;

    gameState = {
      ...gameState,
      events: neutralizeEvents(gameState.events, 0, "Jugador 1", "Jugador 2"),
    };

    room.gameState = gameState;
    room.turnStartedAt = Date.now();
    return room.gameState;
  }

  /**
   * Roll the coins a Trainer (Poké Ball) or activated power (Heal) needs BEFORE the client
   * asks its questions (heads → pick a card...). The coins are game-core's
   * getTrainerCoinFlips / getPowerCoinFlips for that card / Pokémon, and are kept until the
   * action succeeds: asking again returns the same coins (no re-rolls), for a Trainer card
   * for the rest of the game and for a power for the rest of the turn.
   */
  requestCoinFlip(
    roomId: string,
    socketId: string,
    request: CoinFlipRequest,
  ): { success: true; results: Coin[]; result: Coin; flippedBy?: Flipper[] } | { success: false; error: string } {
    return withRoomRandom(this.rooms.get(roomId)?.engineRandom, () => this.requestCoinFlipNow(roomId, socketId, request));
  }

  private requestCoinFlipNow(
    roomId: string,
    socketId: string,
    request: CoinFlipRequest,
  ): { success: true; results: Coin[]; result: Coin; flippedBy?: Flipper[] } | { success: false; error: string } {
    const room = this.rooms.get(roomId);
    if (!room?.gameState) return { success: false, error: "La partida todavía no empezó" };
    if (room.status === "finished" || room.gameState.gamePhase === "GAME_OVER") {
      return { success: false, error: "La partida ya terminó" };
    }
    const key = room.player1SocketId === socketId ? "player1" : room.player2SocketId === socketId ? "player2" : null;
    if (!key) return { success: false, error: "No juegas en esta mesa" };
    if (isLuckyDuelFaceDown(room.gameState)) return { success: false, error: LUCKY_DUEL_FACE_DOWN_ERROR };
    const isMyTurn = key === "player1" ? room.gameState.isPlayerTurn : !room.gameState.isPlayerTurn;
    // Chaos Gym's accepted offer: the offered player flips its Trainer's coins out of turn
    const playsChaosOffer = chaosOfferPlayer(room.gameState) === key && request.purpose === "trainer";
    if (!isMyTurn && !playsChaosOffer) return { success: false, error: "No es tu turno" };
    if (pendingTrainerChoiceOf(room.gameState)) return { success: false, error: "Primero hay que resolver la carta de Entrenador" };

    const view = key === "player1" ? room.gameState : swapSides(room.gameState);
    let coinKey: string;
    let requirement: CoinFlipRequirement;
    try {
      if (request.purpose === "trainer") {
        const reason = canPlayTrainerCard(view, request.cardId);
        if (reason) return { success: false, error: reason };
        requirement = getTrainerCoinFlips(view, request.cardId);
        coinKey = effectCoinKey(key, "trainer", request.cardId);
      } else if (request.purpose === "stadium") {
        // The action of the Stadium in play (none of the Gym Heroes ones flips before its steps)
        const reason = canUseStadiumAction(view);
        if (reason) return { success: false, error: reason };
        requirement = getStadiumActionCoinFlips(view);
        coinKey = effectCoinKey(key, "stadium", view.stadium?.card.id ?? "", view.turnNumber);
      } else {
        const reason = canUsePokemonPower(view, request.pokemonId);
        if (reason) return { success: false, error: reason };
        requirement = getPowerCoinFlips(view, request.pokemonId);
        coinKey = effectCoinKey(key, "power", request.pokemonId, view.turnNumber);
      }
    } catch (error) {
      return { success: false, error: illegalReason(error) ?? "No se pudo lanzar la moneda" };
    }
    if (requirement === 0) return { success: false, error: "Esta carta no lanza monedas" };

    const results = this.effectCoins(room, coinKey, requirement);
    const flippedBy = request.purpose === "trainer"
      ? trainerFlippedBy(view, request.cardId, results.length)
      : request.purpose === "power"
        ? powerFlippedBy(view, request.pokemonId, results.length)
        : undefined; // a Stadium action's coins are its user's
    return { success: true, results, result: results[0], ...(flippedBy ? { flippedBy } : {}) };
  }

  /**
   * Coins for one effect: the ones already rolled for `coinKey` (requestCoinFlip, or an
   * earlier attempt that failed) when they still fit the requirement, else a fresh roll that
   * is stored. Removed by executeAction once the effect resolved.
   */
  private effectCoins(room: GameRoom, coinKey: string, requirement: CoinFlipRequirement): Coin[] {
    if (requirement === 0) return [];
    const store = (room.effectCoins ??= {});
    const turnNumber = room.gameState?.turnNumber ?? 0;
    // Power coins are per turn: forget older ones
    for (const [k, entry] of Object.entries(store)) {
      if (entry.turnNumber !== null && entry.turnNumber !== turnNumber) delete store[k];
    }
    const stored = store[coinKey];
    if (stored && coinsSatisfy(requirement, stored.results)) return stored.results;
    const results = rollCoins(requirement, this.coinsOf(room));
    store[coinKey] = { results, turnNumber: coinKey.includes(":trainer:") ? null : turnNumber };
    return results;
  }

  /**
   * Coins a Trainer flips AFTER its choices (Blaine's Gamble: "discard…, then flip"), rolled now
   * that its answers are in (game-core getTrainerCoinFlips with the selections). Only for a
   * Trainer that flipped nothing before its steps; never cached in room.effectCoins and never
   * offered by requestCoinFlip, so they can't be peeked with dummy answers. `view`: its player's.
   */
  private trainerCoinsAfterSteps(view: GameState, cardId: string, selections: string[][], preCoins: Coin[], flip: CoinSource): Coin[] {
    if (preCoins.length > 0) return [];
    return rollCoins(getTrainerCoinFlips(view, cardId, selections), flip);
  }

  /**
   * Execute a player action. `rawAction` comes straight from the client and is validated
   * against gameActionSchema (schemas.ts) before anything else runs.
   */
  async executeAction(
    roomId: string,
    socketId: string,
    rawAction: unknown
  ): Promise<ActionResult> {
    return this.runAction(roomId, { socketId }, rawAction);
  }

  /**
   * An action from a player's socket, or — `{ side }` — one the server sends for a player
   * (a default answer when their answer clock ran out, autoAnswerTimedOut).
   */
  private async runAction(
    roomId: string,
    from: { socketId: string } | { side: PlayerKey },
    rawAction: unknown
  ): Promise<ActionResult> {
    // Synchronous from here on: a seeded room's engine calls all run inside its Math.random swap
    return withRoomRandom(this.rooms.get(roomId)?.engineRandom, () => this.runActionNow(roomId, from, rawAction));
  }

  /** Where `room`'s coins come from: its own source (adventure rooms) or the manager's. */
  private coinsOf(room: GameRoom): CoinSource {
    return room.coinSource ?? this.flipCoin;
  }

  private runActionNow(
    roomId: string,
    from: { socketId: string } | { side: PlayerKey },
    rawAction: unknown
  ): ActionResult {
    const parsed = parseGameAction(rawAction);
    if (!parsed.ok) return { success: false, error: parsed.error };
    const action = parsed.action;

    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: "La partida ya no existe" };
    if (!room.gameState) return { success: false, error: "La partida todavía no empezó" };
    const flip = this.coinsOf(room);
    // A finished game takes no more actions: no surrender after the end (a second gameOver
    // with the other winner), no promotion of the loser, no farming wins on a dead room. A
    // takePrize here is a double click on the last Prize: answered quietly.
    if (room.status === "finished" || room.gameState.gamePhase === "GAME_OVER") {
      if (action.type === "takePrize") return noPrizeOwed();
      return { success: false, error: "La partida ya terminó" };
    }

    // Determine which player is acting
    const isPlayer1 = "side" in from ? from.side === "player1" : room.player1SocketId === from.socketId;
    const isPlayer2 = "side" in from ? from.side === "player2" : room.player2SocketId === from.socketId;

    if (!isPlayer1 && !isPlayer2) {
      return { success: false, error: "No juegas en esta mesa" };
    }

    // No Prize owed (a double click, a stale board): nothing to do, answered before any
    // pending-state rejection could turn it into an error toast
    if (action.type === "takePrize" && prizesOwed(room.gameState, isPlayer1 ? "player" : "opponent") === 0) {
      return noPrizeOwed();
    }

    // Lucky Duel: while both Actives are face down only getting ready (or surrendering) is
    // accepted, so no engine reason or result can name a face-down card before the reveal
    if (isLuckyDuelFaceDown(room.gameState) && action.type !== "playerReady" && action.type !== "surrender") {
      return { success: false, error: LUCKY_DUEL_FACE_DOWN_ERROR };
    }

    // Validate turn - player1 plays when isPlayerTurn is true
    // During MULLIGAN/SETUP, both players can place Pokemon regardless of turn
    // Pending attack choices (deckSearch, forceSwitch, selfSwitch, skipSwitch, benchDamage) are NOT here:
    // they belong to the attacker, and endTurn() doesn't advance while one is pending, so they
    // require it to be the acting player's turn. Otherwise the opponent could resolve your choice.
    // resolveAttackChoice: only the chooser of the pending attack choice — the attacker, or the
    // other player when the step's chooser is "opponent" (Terror Strike), off-turn included.
    // A Trainer the server runs (startTrainer: Challenge!, Rocket's Sneak Attack): only the
    // player its step asks may answer (the opponent off-turn included); nothing else but
    // surrendering happens meanwhile.
    const pendingTrainerChoice = pendingTrainerChoiceOf(room.gameState);
    if (action.type === "answerTrainerChoice") {
      if (!pendingTrainerChoice || !room.pendingTrainer) return { success: false, error: "No hay ninguna carta de Entrenador esperando una respuesta" };
      const trainerIsPlayer1 = room.pendingTrainer.side === "player1";
      const chooserIsPlayer1 = pendingTrainerChoice.chooser === "opponent" ? !trainerIsPlayer1 : trainerIsPlayer1;
      if (chooserIsPlayer1 !== isPlayer1) return { success: false, error: "No te corresponde elegir" };
    } else if (pendingTrainerChoice && action.type !== "surrender") {
      return { success: false, error: "Primero hay que resolver la carta de Entrenador" };
    }
    // Misty's Duel: both players pick (off-turn included; spectators aren't players); nothing
    // else happens until the duel is decided. game-core rejects a second pick in the same round.
    if (action.type === "duelPick") {
      if (!room.gameState.pendingDuel) return { success: false, error: "No hay ningún duelo en curso" };
    } else if (room.gameState.pendingDuel && !["surrender", "promote", "takePrize"].includes(action.type)) {
      return { success: false, error: "Primero hay que terminar el duelo" };
    }
    // Narrow Gym: each player over the Bench limit returns Benched Pokémon, one after the other
    // (pendingBenchTrim queue, sides in player 1's perspective). Only the player at the head of
    // the queue answers (off-turn included); game-core blocks everything else until it is empty.
    // Checked before the attack / power choices, in the same order as awaitedSide and offTurnAnswerer.
    const benchTrim = room.gameState.pendingBenchTrim?.[0];
    if (action.type === "benchTrim") {
      if (!benchTrim) return { success: false, error: "No hay ninguna Banca que reducir" };
      if ((benchTrim.side === "player") !== isPlayer1) return { success: false, error: "No te corresponde elegir" };
    } else if (benchTrim && !["surrender", "promote", "takePrize"].includes(action.type)) {
      return { success: false, error: "Primero hay que reducir la Banca" };
    }
    if (action.type === "resolveAttackChoice") {
      const pendingChoice = room.gameState.pendingAttackChoice;
      if (!pendingChoice) return { success: false, error: "No hay ninguna elección de ataque pendiente" };
      const attackerIsPlayer1 = room.gameState.isPlayerTurn;
      const chooserIsPlayer1 = pendingChoice.step.chooser === "opponent" ? !attackerIsPlayer1 : attackerIsPlayer1;
      if (chooserIsPlayer1 !== isPlayer1) return { success: false, error: "No te corresponde elegir" };
    } else if (room.gameState.pendingAttackChoice && !["surrender", "promote", "takePrize", "benchTrim"].includes(action.type)) {
      // game-core blocks everything else until the choice is answered (endTurn would be a no-op)
      return { success: false, error: "Primero hay que resolver la elección del ataque" };
    }
    // An on-play power (Summon Minions, Sneak Attack, Reel In): the side whose turn it is
    // answers it (turn check below); game-core blocks everything else until then
    if (action.type === "resolvePowerChoice") {
      if (!room.gameState.pendingPowerChoice) return { success: false, error: "No hay ninguna elección de Poder Pokémon pendiente" };
    } else if (room.gameState.pendingPowerChoice && !["surrender", "promote", "takePrize", "benchTrim"].includes(action.type)) {
      return { success: false, error: "Primero hay que resolver el Poder Pokémon" };
    }
    const turnFreeActions = ["ready", "mulligan", "playerReady", "takePrize", "promote", "surrender", "resolveAttackChoice", "answerTrainerChoice", "benchTrim", "duelPick"];
    const setupActions = ["playBasicToActive", "playBasicToBench"];
    const isSetupPhase = room.gameState.gamePhase === "MULLIGAN" || room.gameState.gamePhase === "SETUP";
    const isMyTurn = isPlayer1 ? room.gameState.isPlayerTurn : !room.gameState.isPlayerTurn;
    // Chaos Gym: the player who accepted the offered Trainer plays it (or gives it up) out of
    // turn; the engine only lets them play that card (canPlayTrainerCard on their own view)
    const playsChaosOffer = chaosOfferPlayer(room.gameState) === (isPlayer1 ? "player1" : "player2")
      && ["playTrainer", "startTrainer", "declineChaosOffer"].includes(action.type);
    if (action.type === "declineChaosOffer" && !playsChaosOffer) {
      return { success: false, error: "No tienes ninguna carta de Chaos Gym por jugar" };
    }

    if (!isMyTurn && !playsChaosOffer && !turnFreeActions.includes(action.type)) {
      // Allow setup actions during MULLIGAN/SETUP phase regardless of turn
      if (!isSetupPhase || !setupActions.includes(action.type)) {
        return { success: false, error: "No es tu turno" };
      }
    }

    // Mulligan and "ready" only belong to the opening (before PLAYING). A mulligan needs a hand
    // without Basic Pokémon (game-core hasBasicPokemon: anything playable as a Basic) and
    // nothing placed yet; ready needs an Active.
    if (action.type === "mulligan" || action.type === "playerReady") {
      if (room.gameState.gamePhase !== "MULLIGAN" && (action.type === "mulligan" || room.gameState.gamePhase !== "SETUP")) {
        return { success: false, error: "La preparación de la partida ya terminó" };
      }
      const alreadyReady = isPlayer1 ? room.gameState.playerReady : room.gameState.opponentReady;
      if (alreadyReady) return { success: false, error: "Ya estás listo" };
      const view = isPlayer1 ? room.gameState : swapSides(room.gameState);
      if (action.type === "mulligan") {
        if (view.playerActivePokemon) return { success: false, error: "Ya colocaste tu Pokémon activo" };
        if (hasBasicPokemon(view.playerHand)) return { success: false, error: "Tienes un Pokémon básico en la mano: no puedes hacer mulligan" };
      } else if (!view.playerActivePokemon) {
        return { success: false, error: "Primero coloca tu Pokémon activo" };
      }
    }

    console.log(`[Room ${roomId}] Action from ${isPlayer1 ? "P1" : "P2"}: ${action.type}`, action.payload);

    // Track event count for neutralization
    const eventCountBefore = room.gameState.events.length;
    // mulligan/playerReady/surrender work on player 1's perspective; everything else as the actor
    const actsAsActor = action.type !== "mulligan" && action.type !== "playerReady" && action.type !== "surrender";
    let eventsNeutralizedTo = eventCountBefore;

    // The game state is stored in player 1's perspective and game-core always acts for
    // "player": player 2's actions run on a swapped copy (game-core's swapSides, which also
    // swaps the starting player, PlusPower/Defender owner and result) that is swapped back.
    // Pending choices are not swapped: they belong to the side whose turn it is.
    const toActor = (state: GameState): GameState => (isPlayer1 ? state : swapSides(state));
    const fromActor = toActor; // the swap is its own inverse
    const actorView = toActor(room.gameState);
    const actorKey: PlayerKey = isPlayer1 ? "player1" : "player2";

    // For game-core functions: swap perspective for player2, call function, swap back
    const executeForPlayer = (fn: (state: GameState) => GameState, from: GameState = room.gameState!): GameState =>
      fromActor(fn(toActor(from)));

    // Coins shown to both players (attacks, confusion) / only to the opponent and spectators
    // (trainer and power coins: the acting client already showed them from requestCoinFlip)
    let actionCoinFlipInfo: CoinFlipInfo | undefined;
    // A confused attacker's heads, shown before the attack's own coins
    let confusionCoinFlipInfo: CoinFlipInfo | undefined;
    let opponentCoinFlipInfo: CoinFlipInfo | undefined;
    let coinsShownTo: PlayerKey | undefined;
    // Effect coins to forget once the action succeeded
    let consumedCoinKey: string | undefined;
    // room.pendingTrainer after the action: undefined = unchanged, null = cleared
    let nextPendingTrainer: PendingTrainerRecord | null | undefined;
    // The attack stopped at a mid-attack question (ActionResult.attackPaused)
    let attackPaused = false;
    // A Trainer / power / Stadium action that ends the turn (Minion of Team Rocket's tails,
    // Tickling Machine) runs with skipEndTurn on its player's view; the turn is ended here, from
    // that side's view once swapped back (finishTurnAfter), so the log speaks for the right side.
    const endTurnIfEffectEndedIt = (after: GameState, side: PlayerKey): GameState => {
      if (room.gameState!.attackedThisTurn || !after.attackedThisTurn) return after;
      const finished = this.finishTurnAfter(after, eventsNeutralizedTo, side);
      eventsNeutralizedTo = finished.eventsNeutralizedTo;
      return finished.state;
    };

    try {
      let newState = room.gameState;

      switch (action.type) {
        case "attack": {
          const attackIndex = action.payload.attackIndex;
          const metronomePayload = action.payload.metronomeAttack;
          // Porygon's Conversion 1/2: the chosen type goes to the engine (ExecuteAttackOptions
          // .chosenType), which applies it only for an attack with that effect
          const chosenType = action.payload.conversionType as EnergyType | undefined;
          // Vermilion City Gym: the attacker opted into the Stadium's coin (Lt. Surge's Pokémon)
          const vermilionCoin = action.payload.vermilionCoin === true;
          const attacker = actorView.playerActivePokemon;
          // The attacks it may choose (game-core getAvailableAttacks): a transformed Ditto's copied
          // card's, then — after Recall — the attacks of the cards under it (indices after its own)
          const ownAttack = attacker
            ? getAvailableAttacks(actorView, attacker).find((available) => available.index === attackIndex)?.attack
            : undefined;

          // ── Which attack, and is it legal? Checked BEFORE any coin (confusion included):
          // energy cost, Asleep/Paralyzed, Leer, one attack per turn, nothing pending...
          let attackToUse: number | Attack = attackIndex;
          let attackName = ownAttack?.name ?? "";
          if (metronomePayload) {
            if (!ownAttack?.effects?.some((e) => e.type === AttackEffectType.CopyAttack)) {
              return { success: false, error: "Ese ataque no puede copiar ataques" };
            }
            const opponentActive = actorView.opponentActivePokemon;
            const copiedAttack = opponentActive
              ? getEffectivePokemonCard(actorView, opponentActive)?.attacks[metronomePayload.index]
              : undefined;
            if (!copiedAttack) return { success: false, error: "El Pokémon defensor no tiene ese ataque" };
            const reason = canExecuteMetronome(actorView, copiedAttack);
            if (reason) return { success: false, error: reason };
            attackToUse = copiedAttack;
            attackName = copiedAttack.name;
          } else {
            const reason = canExecuteAttack(actorView, attackIndex);
            if (reason) return { success: false, error: reason };
          }
          if (vermilionCoin) {
            const reason = canUseVermilionCoin(actorView, attackIndex);
            if (reason) return { success: false, error: reason };
          }

          // ── Confusion: the server flips (never the client). Tails: the attack fails, the
          // engine applies the self-damage / KO / end of turn. Heads: the attack proceeds.
          let beforeAttack = room.gameState;
          if (attacker?.statusConditions?.includes("confused")) {
            const confusionCoin = flip();
            let canAttack = true as boolean;
            const afterFlip = executeForPlayer((state) => {
              const resolved = resolveConfusionFlip(state, confusionCoin === "heads");
              canAttack = resolved.canAttack;
              return resolved.state;
            });
            if (!canAttack) {
              newState = afterFlip;
              actionCoinFlipInfo = { attackName: "Confusión", results: [confusionCoin] };
              break;
            }
            beforeAttack = afterFlip; // heads: continue the attack from the flipped state
            confusionCoinFlipInfo = { attackName: "Confusión", results: [confusionCoin] };
          }

          // ── Attack (or Metronome copying the Defending Pokémon's attack) ──
          // The server flips exactly the coins of game-core's plan (getAttackCoinPlan:
          // Smokescreen/Sand-attack coin, the attack's own — Stone Barrage until tails —, then
          // the Defending Haunter's Transparency coin) and passes them in; the engine resolves
          // every coin effect, the KO/prize flow, attack choices and the end of the turn.
          // skipDefenderPromotion: the defender picks its new active (`promote`), which then
          // ends the attacker's turn.
          // Vermilion City Gym's opt-in coin goes in the plan (and the engine) only when asked for.
          const coinOptions = vermilionCoin ? { vermilionCoin: true } : {};
          // Koga's Ninja Trick (Gym Challenge): the defender is asked BEFORE any coin of the attack
          // (they depend on the Pokémon that defends). No coin now: the engine pauses the attack
          // (pendingAttackChoice.reaction, chooser "opponent") and resolveAttackChoice flips
          // getAttackChoiceCoinPlan(state, answer) — the plan against the Pokémon that defends.
          if (getAttackPreReaction(toActor(beforeAttack), attackToUse)) {
            const pauseOptions = { coinResults: [], skipDefenderPromotion: true, ...coinOptions, ...(chosenType ? { chosenType } : {}) };
            newState = executeForPlayer((state) =>
              typeof attackToUse === "number"
                ? executeAttack(state, attackToUse, pauseOptions)
                : executeMetronome(state, attackToUse, pauseOptions),
            beforeAttack);
            attackPaused = newState.pendingAttackChoice?.reaction !== undefined;
            break;
          }
          const coinPlan = getAttackCoinPlan(toActor(beforeAttack), attackToUse, coinOptions);
          const coinResults = flipAttackCoins(coinPlan, flip);
          const attackOptions = { coinResults, skipDefenderPromotion: true, ...coinOptions, ...(chosenType ? { chosenType } : {}) };
          newState = executeForPlayer((state) =>
            typeof attackToUse === "number"
              ? executeAttack(state, attackToUse, attackOptions)
              : executeMetronome(state, attackToUse, attackOptions),
          beforeAttack);
          // A question in the middle of the attack (Flee, Bench Guard, Sabrina's ESP, Charity):
          // the engine returned the state it was given plus pendingAttackChoice.reaction. The attack
          // hasn't happened (attackedThisTurn stays false, the turn goes on); resolveAttackChoice
          // resumes it with the answer (the coins rolled here are kept in the reaction).
          attackPaused = newState.pendingAttackChoice?.reaction !== undefined;

          // Both clients animate the real coins (showCoinFlip) as soon as they are rolled, also
          // when the attack paused (Sabrina's ESP asks once its coins are known)
          if (coinResults.length > 0) actionCoinFlipInfo = attackCoinInfo(attackName, coinPlan, coinResults);
          break;
        }

        case "endTurn":
          newState = executeForPlayer((state) => endTurn(state, true));
          break;

        case "retreat": {
          const energyIds = action.payload.energyIdsToDiscard;
          const benchIdx = action.payload.benchIndex;
          // Sinkhole (Dark Dugtrio): one coin per working Sinkhole of the opponent, flipped by
          // the retreating player. Always passed (the engine would use Math.random otherwise).
          const sinkholes = getRetreatDamageSources(actorView, "player");
          // executeRetreat reports an illegal retreat as an info event instead of throwing:
          // probe it with harmless coins so no coin is flipped (or shown) for a rejected retreat
          const probe = executeRetreat(actorView, energyIds, benchIdx, { coinResults: sinkholes.map(() => "heads" as const) });
          if (probe.playerActivePokemon?.pokemon.id === actorView.playerActivePokemon?.pokemon.id) {
            return { success: false, error: probe.events[probe.events.length - 1]?.message ?? "No puedes retirarte ahora" };
          }
          const coinResults = sinkholes.map(() => flip());
          newState = executeForPlayer((state) => executeRetreat(state, energyIds, benchIdx, { coinResults }));
          if (coinResults.length > 0) {
            const source = sinkholes[0].pokemon;
            const powerName = isPokemonCard(source) ? source.power?.name : undefined;
            actionCoinFlipInfo = { attackName: powerName ?? "Socavón", results: coinResults };
          }
          break;
        }

        // ── Board actions: game-core validates and applies them (IllegalActionError otherwise) ──
        // Rocket's Minefield Gym (a Basic onto the Bench) / Chaos Gym (a Trainer played as a
        // Basic): game-core's getPlayBasicCoinFlips coin, flipped here only for a legal play and
        // always passed in (omitted, the engine would use Math.random); both clients animate it.
        case "playBasicToActive":
        case "playBasicToBench": {
          const cardId = action.payload.cardId;
          const position = action.type === "playBasicToActive" ? "active" : "bench";
          const reason = canPlayBasicPokemon(actorView, cardId, position);
          if (reason) return { success: false, error: reason };
          const coinResults = Array.from({ length: getPlayBasicCoinFlips(actorView, cardId, position) }, () => flip());
          newState = executeForPlayer((state) => playBasicPokemon(state, cardId, position, { coinResults }));
          if (coinResults.length > 0) {
            actionCoinFlipInfo = { attackName: actorView.stadium?.card.name ?? "Estadio", results: coinResults };
          }
          break;
        }

        case "attachEnergy": {
          // Rain Dance (and any future attach power) is applied by the engine when it applies
          const { cardId, pokemonId } = action.payload;
          newState = executeForPlayer((state) => attachEnergyCard(state, cardId, pokemonId));
          break;
        }

        case "evolve": {
          const { cardId } = action.payload;
          const targetPokemonId = action.payload.targetPokemonId ?? pokemonIdAt(actorView, action.payload.targetIndex);
          if (!targetPokemonId) return { success: false, error: "Debes elegir uno de tus Pokémon en juego" };
          newState = executeForPlayer((state) => evolvePokemonCard(state, cardId, targetPokemonId));
          break;
        }

        case "takePrize": {
          const prizeIndex = action.payload.prizeIndex;
          // Prizes owed are a count: one per takePrize until it is 0 (checked above too)
          if (prizesOwed(actorView, "player") === 0) return noPrizeOwed();
          // A stale index (a Prize the board still showed): the engine would ignore it silently
          if (prizeIndex >= actorView.playerPrizes.length) return { success: false, error: "Ese premio ya no está: elige otro" };
          newState = executeForPlayer((state) => takePrize(state, prizeIndex, true, false));
          // Taking the last thing the paused turn waited for ends it (finishPausedTurn)
          ({ state: newState, eventsNeutralizedTo } = this.finishTurnAfter(newState, eventsNeutralizedTo, actorKey));
          break;
        }

        case "promote": {
          // Whoever must promote (playerNeedsToPromote in their view) may, on either turn: the
          // defender after a Knock Out, or mid-turn after a Curse Knock Out (opponent), a
          // discarded Active Mysterious Fossil or Cowardice (the side whose turn it is).
          const benchIndex = action.payload.benchIndex;
          if (!actorView.playerNeedsToPromote) {
            return { success: false, error: "No necesitas promover un Pokémon" };
          }
          newState = executeForPlayer((state) => promoteActivePokemon(state, benchIndex));
          // After an attack (or the between-turns checkup) the turn ends once both Actives are
          // back; a promotion in the middle of a turn leaves that turn going.
          ({ state: newState, eventsNeutralizedTo } = this.finishTurnAfter(newState, eventsNeutralizedTo, actorKey));
          break;
        }

        case "discardFromPlay": {
          // Mysterious Fossil / Clefairy Doll: the engine checks it (own turn, before attacking,
          // not the last Pokémon). An Active one leaves the player promoting (`promote`) mid-turn.
          const { pokemonId } = action.payload;
          newState = executeForPlayer((state) => discardFromPlay(state, pokemonId));
          break;
        }

        // ── Gym Challenge ──
        // Lt. Surge's Secret Plan: the owner flips one of their face-down Benched cards (game-core
        // canFlipFaceDown / flipFaceDown: own turn only)
        case "flipFaceDown": {
          const { pokemonId } = action.payload;
          newState = executeForPlayer((state) => flipFaceDown(state, pokemonId));
          break;
        }

        // Sabrina's Psychic Control: the player gives up the Trainer it borrowed from the
        // opponent's discard pile (state.pendingBorrowedTrainer, acting side only)
        case "declineBorrowedTrainer": {
          if (!actorView.pendingBorrowedTrainer) return { success: false, error: "No tienes ninguna carta prestada por jugar" };
          newState = executeForPlayer((state) => declineBorrowedTrainer(state));
          break;
        }

        // Chaos Gym came up heads (state.pendingChaosGymPlay) but the player won't finish the
        // card: it is discarded without effect
        case "forfeitChaosGymPlay": {
          if (!actorView.pendingChaosGymPlay) return { success: false, error: "No tienes ninguna carta de Chaos Gym por jugar" };
          newState = executeForPlayer((state) => forfeitChaosGymPlay(state));
          break;
        }

        // Chaos Gym's offered card, accepted: the offered player gives it up instead of playing it
        // (checked above: only that player; also the default when their answer clock runs out)
        case "declineChaosOffer": {
          newState = executeForPlayer((state) => declineChaosGymOffer(state));
          break;
        }

        case "resolveAttackChoice": {
          // Answered by the chooser (checked above) but always applied on the ATTACKING side's
          // view, as game-core requires; the turn then ends unless another choice follows or a
          // promotion / Prize is pending (finished by promote / takePrize).
          // A mid-attack question (pendingAttackChoice.reaction: Flee, Bench Guard, Sabrina's ESP,
          // Charity) resumes the paused attack the same way; it may ask the next one.
          const { selection } = action.payload;
          const attackerIsPlayer1 = room.gameState.isPlayerTurn;
          const asAttacker = (state: GameState): GameState => (attackerIsPlayer1 ? state : swapSides(state));
          const attackerView = asAttacker(room.gameState);
          // Sabrina's ESP "reflip": the server flips the attack's own coins again (game-core's
          // getAttackChoiceCoinPlan) and every client animates them. Never coins from the client
          // (the schema rejects them).
          const reflipPlan = getAttackChoiceCoinPlan(attackerView, selection);
          const reflipCoins = reflipPlan ? flipAttackCoins(reflipPlan, flip) : undefined;
          // Adventure: the AI's attack is finished by its driver (finishAttack step: its own choices,
          // promotion, the end of its turn), never here
          const aiFinishesAttack = hasAISeat(room) && !attackerIsPlayer1;
          newState = asAttacker((() => {
            const resolved = resolveAttackChoice(attackerView, selection, { skipEndTurn: true, ...(reflipCoins ? { coinResults: reflipCoins } : {}) });
            return resolved.pendingAttackChoice || resolved.gameResult !== null || aiFinishesAttack ? resolved : endTurn(resolved, true);
          })());
          if (reflipPlan && reflipCoins && reflipCoins.length > 0) {
            actionCoinFlipInfo = attackCoinInfo(pausedAttackName(attackerView) ?? "Sabrina's ESP", reflipPlan, reflipCoins);
          }
          attackPaused = newState.pendingAttackChoice?.reaction !== undefined;
          // Events speak for the attacker ("tu" = attacker), whoever answered
          const attackerName = attackerIsPlayer1 ? "Jugador 1" : "Jugador 2";
          const defenderName = attackerIsPlayer1 ? "Jugador 2" : "Jugador 1";
          newState = { ...newState, events: neutralizeEvents(newState.events, eventsNeutralizedTo, attackerName, defenderName) };
          eventsNeutralizedTo = newState.events.length;
          break;
        }

        case "resolvePowerChoice": {
          // Summon Minions / Sneak Attack / Reel In: answered on the acting side's view (the
          // side whose turn it is, checked above); game-core checks the selection
          const { selection } = action.payload;
          newState = executeForPlayer((state) => resolvePowerChoice(state, selection));
          break;
        }

        case "deckSearch": {
          const selectedCardId = action.payload.cardId;
          newState = executeForPlayer((state) => executeDeckSearch(state, selectedCardId));
          break;
        }

        case "forceSwitch": {
          const benchIndex = action.payload.benchIndex;
          newState = executeForPlayer((state) => applyForceSwitch(state, benchIndex));
          break;
        }

        case "selfSwitch": {
          const benchIndex = action.payload.benchIndex;
          newState = executeForPlayer((state) => applySelfSwitch(state, benchIndex));
          break;
        }

        case "skipSwitch": {
          newState = executeForPlayer((state) => skipPendingSwitch(state));
          break;
        }

        case "benchDamage": {
          const selectedPokemonIds = action.payload.selectedPokemonIds;
          newState = executeForPlayer((state) => executeBenchDamage(state, selectedPokemonIds));
          break;
        }

        case "clearPeek": {
          // Only the side that peeked (whose turn it is) owns pendingPeek
          if (!actorView.isPlayerTurn) return { success: false, error: "No es tu turno" };
          newState = executeForPlayer((state) => clearPendingPeek(state));
          break;
        }

        case "mulligan": {
          // Mulligan: shuffle hand back into deck and draw 7 new cards
          // isPlayer1 = true means player1's perspective, so isPlayer = true
          newState = doMulligan(room.gameState, isPlayer1);
          break;
        }

        case "playerReady": {
          // Mark player as ready (after mulligan check or setup)
          newState = setPlayerReady(room.gameState, isPlayer1);

          // Check if both players are ready to start the game
          const p1Ready = isPlayer1 ? true : newState.playerReady;
          const p2Ready = isPlayer1 ? newState.opponentReady : true;

          if (p1Ready && p2Ready && newState.gamePhase === "MULLIGAN") {
            // Both players ready - cancel setup timer and start the game. The engine draws the
            // starting player's first card (classic rule): nothing to draw here.
            this.cancelSetupTimer(roomId);
            const coinFlipResult = flip();
            newState = startPlayingPhase(newState, coinFlipResult);
          } else if ((p1Ready || p2Ready) && !(p1Ready && p2Ready)) {
            // Only one player is ready — start setup timer for the opponent
            this.startSetupTimer(roomId, isPlayer1 ? "player1" : "player2");
          }
          break;
        }

        // ── Activated Pokémon Powers through game-core's effect registry ──
        // { pokemonId, selections }: the engine checks the power (owner, status, once per turn,
        // Toxic Gas...) and every selection against its own steps. Coins (Heal) are rolled here.
        case "usePower": {
          const { pokemonId, selections } = action.payload;
          const reason = canUsePokemonPower(actorView, pokemonId);
          if (reason) return { success: false, error: reason };
          const requirement = getPowerCoinFlips(actorView, pokemonId);
          const coinKey = effectCoinKey(actorKey, "power", pokemonId, actorView.turnNumber);
          const coinResults = this.effectCoins(room, coinKey, requirement);
          // No answer may stand in for another player's or need hidden cards (isServerStep)
          walkClientSteps((answered) => getPowerSteps(actorView, pokemonId, answered, coinResults.length > 0 ? coinResults : undefined), selections);
          newState = executeForPlayer((state) => usePokemonPower(state, pokemonId, selections, { coinResults, skipEndTurn: true }));
          newState = endTurnIfEffectEndedIt(newState, actorKey);
          if (coinResults.length > 0) {
            consumedCoinKey = coinKey;
            opponentCoinFlipInfo = powerCoinInfo(actorView, pokemonId, coinResults);
          }
          break;
        }

        // ── Trainers through game-core's effect registry ──
        // { cardId, selections }: the card that runs is the one in the hand with that id; the
        // engine validates the selections against the card's steps. Coins (Poké Ball) are rolled
        // here, never taken from the client: before the steps (requestCoinFlip), or — for a Trainer
        // that flips after its choices (Blaine's Gamble) — here, once its answers arrived.
        case "playTrainer": {
          const { cardId, selections, trainerName } = action.payload;
          const card = actorView.playerHand.find((c) => c.id === cardId);
          if (card && trainerName !== undefined && card.name !== trainerName) {
            return { success: false, error: "La carta no coincide con el entrenador indicado" };
          }
          const reason = canPlayTrainerCard(actorView, cardId);
          if (reason) return { success: false, error: reason };
          const requirement = getTrainerCoinFlips(actorView, cardId);
          const coinKey = effectCoinKey(actorKey, "trainer", cardId);
          const preCoins = this.effectCoins(room, coinKey, requirement);
          // A client can't answer for the opponent (Challenge!) or pick from cards it can't see
          // (Rocket's Sneak Attack): those cards go through startTrainer
          const pendingStep = walkClientSteps((answered) => getTrainerSteps(actorView, cardId, answered, preCoins.length > 0 ? preCoins : undefined), selections);
          // The next question is the other player's (Erika, Treaty, Blaine's Quiz) or needs hidden cards
          if (pendingStep && isServerStep(pendingStep)) throw new IllegalActionError("Esta elección la pide el servidor: juega la carta con startTrainer");
          const postCoins = this.trainerCoinsAfterSteps(actorView, cardId, selections, preCoins, flip);
          const coinCaption = trainerCoinCaption(actorView, cardId, card?.name);
          newState = executeForPlayer((state) =>
            playTrainerCard(state, cardId, selections, {
              coinResults: preCoins.length > 0 ? preCoins : postCoins,
              skipEndTurn: true,
              ...borrowedContext(actorView, cardId),
            }));
          newState = endTurnIfEffectEndedIt(newState, actorKey);
          if (preCoins.length > 0) {
            consumedCoinKey = coinKey;
            opponentCoinFlipInfo = trainerCoinInfo(actorView, cardId, coinCaption, preCoins);
          }
          // Nobody has seen coins flipped after the steps: every client animates them
          if (postCoins.length > 0) actionCoinFlipInfo = trainerCoinInfo(actorView, cardId, coinCaption, postCoins);
          break;
        }

        // ── Trainers with server-run steps (TR contract §3) ──
        // startTrainer { cardId, selections }: the client answered what it could; the server
        // checks those answers, then asks the next step itself, built from the real (unmasked)
        // state: a step for the opponent (Challenge!) or with revealed cards (Rocket's Sneak
        // Attack's whole opposing hand). Answers are kept in room.pendingTrainer, never sent.
        case "startTrainer": {
          const { cardId, selections } = action.payload;
          const card = actorView.playerHand.find((c) => c.id === cardId);
          const reason = canPlayTrainerCard(actorView, cardId);
          if (reason) return { success: false, error: reason };
          const coinKey = effectCoinKey(actorKey, "trainer", cardId);
          const preCoins = this.effectCoins(room, coinKey, getTrainerCoinFlips(actorView, cardId));
          const coinArg = preCoins.length > 0 ? preCoins : undefined;
          const next = walkClientSteps((answered) => getTrainerSteps(actorView, cardId, answered, coinArg), selections);
          const coinCaption = trainerCoinCaption(actorView, cardId, card?.name);
          if (next) {
            newState = withTrainerChoice(room.gameState, {
              cardId,
              trainerName: trainerDisplayName(actorView, cardId, card?.name),
              step: next,
              // Chaos Gym's offered card: its player is not the side whose turn it is
              ...(isMyTurn ? {} : { playedOffTurn: true as const }),
            });
            nextPendingTrainer = { side: actorKey, cardId, selections, coinKey };
            break;
          }
          // Nothing left to ask (e.g. Sneak Attack against an empty hand): played at once
          const postCoins = this.trainerCoinsAfterSteps(actorView, cardId, selections, preCoins, flip);
          newState = executeForPlayer((state) =>
            playTrainerCard(state, cardId, selections, {
              coinResults: preCoins.length > 0 ? preCoins : postCoins,
              skipEndTurn: true,
              ...borrowedContext(actorView, cardId),
            }));
          newState = endTurnIfEffectEndedIt(newState, actorKey);
          if (preCoins.length > 0) {
            consumedCoinKey = coinKey;
            opponentCoinFlipInfo = trainerCoinInfo(actorView, cardId, coinCaption, preCoins);
          }
          if (postCoins.length > 0) actionCoinFlipInfo = trainerCoinInfo(actorView, cardId, coinCaption, postCoins);
          break;
        }

        // answerTrainerChoice { selection }: from the player the pending step asks (checked
        // above). Next step, or the Trainer is played on its player's view once all are answered.
        case "answerTrainerChoice": {
          const pendingRecord = room.pendingTrainer!;
          const pending = pendingTrainerChoiceOf(room.gameState)!;
          checkSelection(pending.step, action.payload.selection);
          const selections = [...pendingRecord.selections, action.payload.selection];
          const trainerIsPlayer1 = pendingRecord.side === "player1";
          const asTrainer = (state: GameState): GameState => (trainerIsPlayer1 ? state : swapSides(state));
          const trainerView = asTrainer(withoutTrainerChoice(room.gameState));
          // Chaos Gym's offer question: the offered player accepts or declines (on the view of the
          // side whose turn it is, game-core answerChaosGymOffer); "accept" lets them play it now
          if (pendingRecord.kind === "chaosOffer") {
            newState = asTrainer(answerChaosGymOffer(trainerView, action.payload.selection));
            nextPendingTrainer = null;
            const ownerName = trainerIsPlayer1 ? "Jugador 1" : "Jugador 2";
            newState = { ...newState, events: neutralizeEvents(newState.events, eventsNeutralizedTo, ownerName, trainerIsPlayer1 ? "Jugador 2" : "Jugador 1") };
            eventsNeutralizedTo = newState.events.length;
            break;
          }
          const preCoins = room.effectCoins?.[pendingRecord.coinKey]?.results ?? [];
          const next = getTrainerSteps(trainerView, pendingRecord.cardId, selections, preCoins.length > 0 ? preCoins : undefined);
          if (next) {
            newState = withTrainerChoice(room.gameState, {
              cardId: pending.cardId,
              trainerName: pending.trainerName,
              step: next,
              ...(pending.playedOffTurn ? { playedOffTurn: true as const } : {}),
            });
            nextPendingTrainer = { ...pendingRecord, selections };
            break;
          }
          const postCoins = this.trainerCoinsAfterSteps(trainerView, pendingRecord.cardId, selections, preCoins, flip);
          newState = asTrainer(playTrainerCard(trainerView, pendingRecord.cardId, selections, {
            coinResults: preCoins.length > 0 ? preCoins : postCoins,
            skipEndTurn: true,
            ...borrowedContext(trainerView, pendingRecord.cardId),
          }));
          nextPendingTrainer = null;
          // Events speak for the Trainer's player, whoever answered last
          const trainerName = trainerIsPlayer1 ? "Jugador 1" : "Jugador 2";
          const otherName = trainerIsPlayer1 ? "Jugador 2" : "Jugador 1";
          newState = { ...newState, events: neutralizeEvents(newState.events, eventsNeutralizedTo, trainerName, otherName) };
          eventsNeutralizedTo = newState.events.length;
          newState = endTurnIfEffectEndedIt(newState, pendingRecord.side);
          if (preCoins.length > 0) {
            consumedCoinKey = pendingRecord.coinKey;
            opponentCoinFlipInfo = trainerCoinInfo(trainerView, pendingRecord.cardId, pending.trainerName, preCoins);
            coinsShownTo = pendingRecord.side;
          }
          if (postCoins.length > 0) actionCoinFlipInfo = trainerCoinInfo(trainerView, pendingRecord.cardId, pending.trainerName, postCoins);
          break;
        }

        // ── The action of the Stadium in play (Celadon City Gym) ──
        // stadiumAction { selections }: for the player whose turn it is, whoever played the
        // Stadium; the engine checks it and every answer (getStadiumActionSteps). Coins, if any,
        // are rolled here (before the steps: requestCoinFlip { purpose: "stadium" }).
        case "stadiumAction": {
          const { selections } = action.payload;
          const reason = canUseStadiumAction(actorView);
          if (reason) return { success: false, error: reason };
          const stadiumName = actorView.stadium?.card.name ?? "Estadio";
          const coinKey = effectCoinKey(actorKey, "stadium", actorView.stadium?.card.id ?? "", actorView.turnNumber);
          const preCoins = this.effectCoins(room, coinKey, getStadiumActionCoinFlips(actorView));
          walkClientSteps((answered) => getStadiumActionSteps(actorView, answered, preCoins.length > 0 ? preCoins : undefined), selections);
          const postCoins = preCoins.length > 0 ? [] : rollCoins(getStadiumActionCoinFlips(actorView, selections), flip);
          newState = executeForPlayer((state) =>
            useStadiumAction(state, selections, { coinResults: preCoins.length > 0 ? preCoins : postCoins, skipEndTurn: true }));
          newState = endTurnIfEffectEndedIt(newState, actorKey);
          if (preCoins.length > 0) {
            consumedCoinKey = coinKey;
            opponentCoinFlipInfo = { attackName: stadiumName, results: preCoins };
          }
          if (postCoins.length > 0) actionCoinFlipInfo = { attackName: stadiumName, results: postCoins };
          break;
        }

        // ── Narrow Gym: the player at the head of pendingBenchTrim (checked above, off-turn
        // included) returns that many Benched Pokémon to the hand (game-core resolveBenchTrim) ──
        // ── Misty's Duel: this player's Rock-Paper-Scissors pick (game-core submitDuelPick), on
        // their own view so the winner's redraw is logged for the right side. The pick is never
        // in any event or response before the round resolves (masking hides it: maskDuelFor).
        case "duelPick": {
          const choice = action.payload.choice as RpsChoice;
          newState = executeForPlayer((state) => submitDuelPick(state, "player", choice));
          break;
        }

        case "benchTrim": {
          const { discardIds } = action.payload;
          newState = executeForPlayer((state) => resolveBenchTrim(state, discardIds));
          break;
        }

        case "surrender": {
          // Player surrenders — opponent wins
          const surrendererName = isPlayer1
            ? (room.creator.username || "Jugador 1")
            : (room.joiner.username || "Jugador 2");
          newState = {
            ...room.gameState!,
            gamePhase: GamePhase.GameOver,
            gameResult: isPlayer1 ? "defeat" : "victory", // From player1 perspective
            events: [
              ...room.gameState!.events,
              createGameEvent(`${surrendererName} se ha rendido`, "system"),
            ],
          };
          break;
        }

        default: {
          // Unreachable: parseGameAction only lets known action types through.
          const unknownType: never = action;
          return { success: false, error: `Acción desconocida: ${(unknownType as { type: string }).type}` };
        }
      }

      // Neutralize perspective-specific events for multiplayer
      {
        const selfName = actsAsActor && !isPlayer1 ? "Jugador 2" : "Jugador 1";
        const opponentName = selfName === "Jugador 1" ? "Jugador 2" : "Jugador 1";
        newState = {
          ...newState,
          events: neutralizeEvents(newState.events, eventsNeutralizedTo, selfName, opponentName),
        };
      }

      // Chaos Gym came up tails for a Trainer the other player could use: the offer is asked to
      // that player through pendingTrainerChoice (off-turn, answer clock, default "decline")
      const chaosOffer = newState.pendingChaosOffer;
      if (chaosOffer && !chaosOffer.accepted && !pendingTrainerChoiceOf(newState)) {
        const turnSide: PlayerKey = newState.isPlayerTurn ? "player1" : "player2";
        const step = getChaosGymOfferStep(turnSide === "player1" ? newState : swapSides(newState));
        if (step) {
          newState = withTrainerChoice(newState, { cardId: chaosOffer.cardId, trainerName: chaosOffer.cardName, step });
          nextPendingTrainer = { side: turnSide, cardId: chaosOffer.cardId, selections: [], coinKey: "", kind: "chaosOffer" };
        }
      }

      room.gameState = newState;
      if (consumedCoinKey && room.effectCoins) delete room.effectCoins[consumedCoinKey];
      if (nextPendingTrainer === null) delete room.pendingTrainer;
      else if (nextPendingTrainer) room.pendingTrainer = nextPendingTrainer;

      // Clocks: the awaited player's turn clock restarts, or an off-turn answer's clock runs
      // while the turn clock is paused (updateClocks)
      this.updateClocks(room);

      // Check for game over
      const gameOver = newState.gamePhase === "GAME_OVER";
      let winner: "player1" | "player2" | undefined;
      let winReason: string | undefined;
      const draw = gameOver && newState.gameResult === "draw";

      if (gameOver) {
        room.status = "finished";
        this.cancelAnswerTimer(roomId);
        if (draw) {
          // Lucky Duel: both Actives Knocked Out at once (game-core settleLuckyDuelDraw)
          winReason = "Empate";
        } else {
          // From player1's perspective: victory = player1 wins
          winner = newState.gameResult === "victory" ? "player1" : "player2";
          winReason = newState.gameResult === "victory"
            ? "Player 1 wins!"
            : "Player 2 wins!";
        }
      }

      // Include setup timer info if timer is active
      const setupTimerStarted = this.setupTimerStartTimes.get(roomId);

      return {
        success: true,
        gameState: room.gameState,
        gameOver,
        winner,
        ...(draw ? { draw } : {}),
        winReason,
        ...(confusionCoinFlipInfo ? { confusionCoinFlipInfo } : {}),
        ...(actionCoinFlipInfo ? { coinFlipInfo: actionCoinFlipInfo } : {}),
        ...(opponentCoinFlipInfo ? { opponentCoinFlipInfo, coinsShownTo: coinsShownTo ?? actorKey } : {}),
        ...(setupTimerStarted ? { setupTimerStarted } : {}),
        ...(attackPaused ? { attackPaused } : {}),
      };
    } catch (error) {
      // An illegal move (game-core's canX said no): reject it, the stored state is untouched
      const reason = illegalReason(error);
      if (reason) {
        console.log(`[Room ${roomId}] Rejected ${action.type}: ${reason}`);
        return { success: false, error: reason };
      }
      console.error(`[Room ${roomId}] Action error:`, error);
      return { success: false, error: isProgrammingError(error) ? ACTION_FAILED : (error as Error).message };
    }
  }

  /**
   * After a promotion or a Prize: if the side whose turn it is was only waiting for it (it
   * already attacked, or endTurn paused after the between-turns checkup), both Actives are
   * back and nothing else is pending, end that turn. Mid-turn promotions (Curse, Cowardice,
   * a discarded Mysterious Fossil) leave the turn going. Events so far speak for `actor`;
   * endTurn's speak for the side whose turn it is. `state` is in player 1's perspective.
   */
  private finishTurnAfter(state: GameState, neutralizedTo: number, actor: PlayerKey): { state: GameState; eventsNeutralizedTo: number } {
    const turnDone = state.attackedThisTurn === true || state.checkupDoneOnTurn === state.turnNumber;
    const waiting = state.playerCanTakePrize || state.opponentCanTakePrize || state.playerNeedsToPromote || state.opponentNeedsToPromote;
    if (!turnDone || waiting || state.gamePhase === "GAME_OVER" || !state.playerActivePokemon || !state.opponentActivePokemon) {
      return { state, eventsNeutralizedTo: neutralizedTo };
    }
    const actorName = actor === "player1" ? "Jugador 1" : "Jugador 2";
    const otherName = actor === "player1" ? "Jugador 2" : "Jugador 1";
    let next: GameState = { ...state, events: neutralizeEvents(state.events, neutralizedTo, actorName, otherName) };
    const from = next.events.length;
    const turnIsPlayer1 = next.isPlayerTurn;
    next = turnIsPlayer1 ? endTurn(next, true) : swapSides(endTurn(swapSides(next), true));
    const turnName = turnIsPlayer1 ? "Jugador 1" : "Jugador 2";
    const waitingName = turnIsPlayer1 ? "Jugador 2" : "Jugador 1";
    next = { ...next, events: neutralizeEvents(next.events, from, turnName, waitingName) };
    return { state: next, eventsNeutralizedTo: next.events.length };
  }

  /**
   * After every action. While a player owes an answer off-turn (offTurnAnswerer: Challenge!,
   * Erika, a Flee / Bench Guard reaction, Terror Strike, a Bench trim...) THEIR clock runs
   * (room.turnStartedAt = when it started, room.answerClock) and the turn clock is paused; when it
   * runs out the server answers for them by default (autoAnswerTimedOut), never a forfeit for the
   * player whose turn it is. Once nothing is owed off-turn, control and the paused turn clock
   * return to the player whose turn it is. Otherwise (as before) the awaited player's clock
   * restarts with every action.
   */
  private updateClocks(room: GameRoom): void {
    const now = Date.now();
    // Adventure battles have no clocks (the AI never runs out of time, the human may take theirs)
    if (room.adventure) {
      room.turnStartedAt = now;
      return;
    }
    // Gym battles: gym-room.ts runs the challenger's turn clock (per turn, not per action)
    if (room.gym) return;
    const durationMs = room.turnTimerDuration * 1000;
    const answerer = room.status === "playing" ? offTurnAnswerer(room.gameState) : null;
    if (answerer) {
      // The turn clock pauses with the time it had after its player's last action (every action
      // restarts the awaited player's clock): a full turn clock, kept across several answers
      const turnRemainingMs = room.answerClock?.turnRemainingMs ?? durationMs;
      // A timed step (the Blaine's Quiz guesses) gets only its own limit, plus a grace for the
      // network before the server answers by default
      const limitMs = stepAnswerTimeLimitMs(room.gameState);
      const answerMs = limitMs !== undefined ? Math.min(limitMs, durationMs) : durationMs;
      room.answerClock = { side: answerer, startedAt: now, durationMs: answerMs, turnRemainingMs };
      room.turnStartedAt = now;
      this.scheduleAutoAnswer(room, limitMs !== undefined ? answerMs + TIMED_ANSWER_GRACE_MS : answerMs);
      return;
    }
    this.cancelAnswerTimer(room.id);
    if (room.answerClock) {
      // Back to the player whose turn it is: their clock resumes where it was paused
      room.turnStartedAt = now - (durationMs - room.answerClock.turnRemainingMs);
      delete room.answerClock;
      return;
    }
    room.turnStartedAt = now;
  }

  private scheduleAutoAnswer(room: GameRoom, delayMs: number): void {
    this.cancelAnswerTimer(room.id);
    const timer = setTimeout(() => {
      this.answerTimers.delete(room.id);
      this.autoAnswerTimedOut(room.id).catch((error) => {
        // Never an unhandled rejection: the game goes on and the answerer may be kicked instead
        console.error("[answer-clock]", error);
        const current = this.rooms.get(room.id);
        if (current?.answerClock) current.answerClock.autoAnswerFailed = true;
      });
    }, delayMs);
    timer.unref?.();
    this.answerTimers.set(room.id, timer);
  }

  private cancelAnswerTimer(roomId: string): void {
    const timer = this.answerTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.answerTimers.delete(roomId);
    }
  }

  /**
   * The off-turn answerer ran out of time: the server answers for them with the default answer
   * (defaultSelection: the step's first option(s), Erika "0", no reaction; the engine's pick for a
   * Bench trim) and reports it (setOnAutoAnswer) to be broadcast like an action. Returns the
   * result, or null when nothing is owed any more (answered meanwhile, game over).
   */
  async autoAnswerTimedOut(roomId: string): Promise<ActionResult | null> {
    const room = this.rooms.get(roomId);
    if (!room?.gameState || room.status !== "playing" || !room.answerClock) return null;
    const side = offTurnAnswerer(room.gameState);
    if (!side || side !== room.answerClock.side) return null;
    // Misty's Duel: the server picks (aiDuelPick, server randomness) for every side still missing
    const pickers = duelPickers(room.gameState);
    if (pickers.length > 0) {
      let last: ActionResult | null = null;
      for (const picker of pickers) {
        const pickAction = { type: "duelPick", payload: { choice: aiDuelPick(this.random) } };
        last = await this.runAction(roomId, { side: picker }, pickAction);
        if (!last.success) {
          if (room.answerClock) room.answerClock.autoAnswerFailed = true;
          console.error(`[Room ${roomId}] Default duel pick for ${picker} failed: ${last.error}`);
          return last;
        }
        console.log(`[Room ${roomId}] ${picker} ran out of time: Misty's Duel pick by default`);
        this.onAutoAnswerCallback?.(roomId, picker, { type: pickAction.type }, last);
      }
      return last;
    }
    const action = defaultAnswerAction(room.gameState, side);
    const result: ActionResult = action
      ? await this.runAction(roomId, { side }, action)
      : { success: false, error: "No hay una respuesta por defecto" };
    if (!result.success) {
      // Keep the game going: the waiting player may ask to kick the answerer instead (requestKick)
      if (room.answerClock) room.answerClock.autoAnswerFailed = true;
      console.error(`[Room ${roomId}] Default answer for ${side} failed: ${result.error}`);
      return result;
    }
    console.log(`[Room ${roomId}] ${side} ran out of time: answered ${action!.type} by default`);
    this.onAutoAnswerCallback?.(roomId, side, action!, result);
    return result;
  }

  /**
   * Handle player disconnect
   */
  async handleDisconnect(socketId: string): Promise<string | null> {
    // A spectator's socket: the handler calls removeSpectatorSocket first (it tells those rooms)
    this.removeSpectatorSocket(socketId);

    const roomId = this.socketToRoom.get(socketId);
    // A creator may have one waiting table per mode on the same socket (socketToRoom keeps only
    // one of them): every other one loses that socket too (the tables stay, see below)
    let otherWaiting: string | null = null;
    for (const other of this.rooms.values()) {
      if (other.id !== roomId && other.status === "waiting" && other.player1SocketId === socketId) {
        other.player1SocketId = null;
        other.creatorSeenAt = Date.now();
        otherWaiting ??= other.id;
      }
    }
    if (!roomId) return otherWaiting;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Mark player as disconnected but don't remove yet (allow reconnect)
    let disconnectedSide: "player1" | "player2" | null = null;
    if (room.player1SocketId === socketId) {
      room.player1SocketId = null;
      disconnectedSide = "player1";
    } else if (room.player2SocketId === socketId) {
      room.player2SocketId = null;
      disconnectedSide = "player2";
    }

    this.socketToRoom.delete(socketId);

    // An adventure battle never forfeits nor expires here: adventure-room.ts evicts an idle one
    // from memory (its run keeps the snapshot and the room is rebuilt on rejoin)
    // A gym battle: gym-room.ts runs the challenger's disconnect grace (seatChanged)
    if (hasAISeat(room)) return roomId;

    // The creator left the lobby (reloaded, went to another page, lost the connection) while
    // waiting for an opponent: the table stays. Listed and joinable while they are online
    // anywhere (a rival who sits then waits for them: awaitingCreator), hidden while they are
    // offline; closed by the sweep after WAITING_TABLE_OFFLINE_TTL_MS offline.
    if (disconnectedSide === "player1" && room.status === "waiting") {
      room.creatorSeenAt = Date.now();
    }
    // The rival waiting for an away creator left: the seat is free again (not while the game
    // is starting or their no-show claim is being settled)
    if (disconnectedSide === "player2" && room.status === "waiting" && room.player2Id && !room.startPending) {
      this.releaseWaitingJoiner(room);
    }

    // Start forfeit timer if game is in progress
    if (disconnectedSide && room.status === "playing" && room.gameState) {
      this.startForfeitTimer(roomId, disconnectedSide);
    }

    // If both players are disconnected from a playing room, start cleanup timer
    if (room.status === "playing" && !room.player1SocketId && !room.player2SocketId) {
      this.startCleanupTimer(roomId);
    }

    return roomId;
  }

  /**
   * A game started for players who may not be connected (draft rounds are created server-side):
   * whoever has no socket gets the usual forfeit timer, so an absent player can't block the
   * game (and the draft round) forever.
   */
  ensureForfeitTimers(roomId: string, timeoutMs = FORFEIT_TIMEOUT_MS): void {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== "playing") return;
    room.checkIn = true;
    if (!room.player1SocketId) {
      room.player1SocketId = null;
      this.startForfeitTimer(roomId, "player1", timeoutMs);
    }
    if (!room.player2SocketId) {
      room.player2SocketId = null;
      this.startForfeitTimer(roomId, "player2", timeoutMs);
    }
  }

  /**
   * Start a forfeit timer for a disconnected player.
   */
  private startForfeitTimer(
    roomId: string,
    disconnectedSide: "player1" | "player2",
    timeoutMs = FORFEIT_TIMEOUT_MS,
  ): void {
    const timerKey = `${roomId}:${disconnectedSide}`;

    // Don't start if already running
    if (this.forfeitTimers.has(timerKey)) return;

    console.log(
      `⏱️ Forfeit timer started for ${disconnectedSide} in room ${roomId} (${timeoutMs / 1000}s)`,
    );

    const timer = setTimeout(() => {
      this.handleForfeitTimeout(roomId, disconnectedSide);
    }, timeoutMs);

    this.forfeitTimers.set(timerKey, timer);
  }

  /**
   * Cancel a forfeit timer (player reconnected).
   */
  private cancelForfeitTimer(
    roomId: string,
    side: "player1" | "player2",
  ): void {
    const timerKey = `${roomId}:${side}`;
    const timer = this.forfeitTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.forfeitTimers.delete(timerKey);
      console.log(
        `⏱️ Forfeit timer cancelled for ${side} in room ${roomId} (reconnected)`,
      );
    }
  }

  /**
   * Handle forfeit timeout — player didn't reconnect in time.
   */
  private handleForfeitTimeout(
    roomId: string,
    disconnectedSide: "player1" | "player2",
  ): void {
    const timerKey = `${roomId}:${disconnectedSide}`;
    this.forfeitTimers.delete(timerKey);

    const room = this.rooms.get(roomId);
    if (!room || !room.gameState || room.status !== "playing") return;

    // Check if still disconnected
    const isStillDisconnected =
      disconnectedSide === "player1"
        ? room.player1SocketId === null
        : room.player2SocketId === null;

    if (!isStillDisconnected) return;

    console.log(
      `⏱️ Forfeit timeout for ${disconnectedSide} in room ${roomId}`,
    );

    room.status = "finished";
    this.cancelAnswerTimer(roomId);
    const winner = disconnectedSide === "player1" ? "player2" : "player1";

    // A game created for absent players (draft round) where neither showed up: nobody wins
    const isWinnerAbsent = winner === "player1" ? room.player1SocketId === null : room.player2SocketId === null;
    if (room.checkIn && isWinnerAbsent) {
      this.cancelForfeitTimer(roomId, winner);
      this.abandonMatch(room, "Ningún jugador se presentó a la partida");
      return;
    }

    if (this.onForfeitCallback) {
      this.onForfeitCallback(roomId, winner, room.gameState);
    }
  }

  /**
   * Start a setup timer when the first player clicks ready.
   * If the opponent doesn't click ready within SETUP_TIMEOUT_MS, the ready player wins.
   */
  startSetupTimer(roomId: string, readySide: "player1" | "player2"): void {
    // Don't start if already running; adventure battles have no setup deadline
    const target = this.rooms.get(roomId);
    if (this.setupTimers.has(roomId) || (target && hasAISeat(target))) return;

    const startTime = Date.now();
    console.log(
      `⏱️ Setup timer started in room ${roomId} — ${readySide} is ready (${SETUP_TIMEOUT_MS / 1000}s)`,
    );

    const timer = setTimeout(() => {
      this.handleSetupTimeout(roomId, readySide);
    }, SETUP_TIMEOUT_MS);

    this.setupTimers.set(roomId, timer);
    this.setupTimerStartTimes.set(roomId, startTime);
  }

  /**
   * Get the setup timer start time for a room (if active).
   */
  getSetupTimerStart(roomId: string): number | null {
    return this.setupTimerStartTimes.get(roomId) ?? null;
  }

  /**
   * Cancel the setup timer (both players are ready).
   */
  private cancelSetupTimer(roomId: string): void {
    const timer = this.setupTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.setupTimers.delete(roomId);
      this.setupTimerStartTimes.delete(roomId);
      console.log(`⏱️ Setup timer cancelled for room ${roomId} (both ready)`);
    }
  }

  /**
   * Handle setup timeout — opponent didn't click ready in time.
   */
  private handleSetupTimeout(
    roomId: string,
    readySide: "player1" | "player2",
  ): void {
    this.setupTimers.delete(roomId);

    const room = this.rooms.get(roomId);
    if (!room || !room.gameState || room.status !== "playing") return;

    // Check that only one player is ready (the other isn't)
    const p1Ready = room.gameState.playerReady;
    const p2Ready = room.gameState.opponentReady;
    if (p1Ready && p2Ready) return; // Both ready, game should have started

    console.log(
      `⏱️ Setup timeout in room ${roomId} — ${readySide} wins (opponent not ready)`,
    );

    room.status = "finished";
    this.cancelAnswerTimer(roomId);
    const winner = readySide;

    if (this.onForfeitCallback) {
      this.onForfeitCallback(roomId, winner, room.gameState, "Rival no completó la preparación a tiempo");
    }
  }

  /**
   * Start a cleanup timer for rooms where both players disconnected.
   */
  private startCleanupTimer(roomId: string): void {
    if (this.cleanupTimers.has(roomId)) return;

    console.log(`🧹 Cleanup timer started for room ${roomId} (5 min)`);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(roomId);
      const room = this.rooms.get(roomId);
      if (!room) return;
      // Only clean up if still both disconnected
      if (!room.player1SocketId && !room.player2SocketId) {
        console.log(`🧹 Cleaning up abandoned room ${roomId}`);
        if (room.status === "playing") this.abandonMatch(room, "Ambos jugadores se desconectaron");
        room.status = "finished";
        this.cancelAnswerTimer(roomId);
        this.rooms.delete(roomId);
      }
    }, 300_000); // 5 minutes

    this.cleanupTimers.set(roomId, timer);
  }

  /**
   * Cancel cleanup timer (a player reconnected).
   */
  private cancelCleanupTimer(roomId: string): void {
    const timer = this.cleanupTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(roomId);
      console.log(`🧹 Cleanup timer cancelled for room ${roomId} (player reconnected)`);
    }
  }

  /**
   * Start periodic cleanup of stale rooms (call once at server start).
   */
  startPeriodicCleanup(): void {
    setInterval(() => this.sweepRooms(), 60_000); // Run every minute
  }

  /**
   * One cleanup pass. A finished room is kept FINISHED_ROOM_TTL_MS after its game ended (stamped
   * here the first time it is seen finished, whatever the end path), not after the room was
   * created: before, a game longer than 5 minutes lost its room within a minute of the game
   * over, cutting the players' chat and emotes ("gg"). Waiting lobby tables close (onRoomClosed)
   * once their creator has been offline WAITING_TABLE_OFFLINE_TTL_MS ("offline"), or
   * WAITING_TABLE_IDLE_TTL_MS after they were created / last opened by the creator ("idle"). A
   * table with a rival waiting for its creator is spared during the creator's window; after it
   * (the rival may claim the victory) the same TTLs apply, releasing that rival.
   */
  sweepRooms(now = Date.now()): void {
    for (const [id, room] of this.rooms.entries()) {
      if (room.status === "finished") {
        room.finishedAt ??= now;
        if (now - room.finishedAt >= FINISHED_ROOM_TTL_MS) {
          this.cancelAnswerTimer(id);
          this.rooms.delete(id);
        }
        continue;
      }
      if (room.status !== "waiting" || room.isDraft || hasAISeat(room) || room.startPending) continue;
      if (room.awaitingCreator && now < room.awaitingCreator.expiresAt) continue;
      if (!room.player1Id) {
        // Nobody holds it (shouldn't happen: leaveRoom deletes empty rooms)
        this.closeWaitingTable(room, "idle");
        continue;
      }
      const created = room.createdAt.getTime();
      if (this.isCreatorReachable(room)) room.creatorSeenAt = now;
      if (now - (room.creatorSeenAt ?? created) >= WAITING_TABLE_OFFLINE_TTL_MS) {
        this.closeWaitingTable(room, "offline");
      } else if (now - (room.touchedAt ?? created) >= WAITING_TABLE_IDLE_TTL_MS) {
        this.closeWaitingTable(room, "idle");
      }
    }
  }

  /**
   * Get all rooms (for admin panel).
   */
  getAllRooms(): Map<string, GameRoom> {
    return this.rooms;
  }

  /**
   * Get a room by ID
   */
  getRoom(roomId: string): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Lobby tables waiting for a rival that can be joined now (isJoinable: the creator is at the
   * table or online elsewhere).
   */
  getAvailableRooms(): GameRoom[] {
    const rooms: GameRoom[] = [];
    for (const room of this.rooms.values()) {
      if (this.isJoinable(room)) rooms.push(room);
    }
    return rooms;
  }

  /**
   * The lobby list: joinable waiting tables (not those of an offline creator, nor one whose
   * rival is waiting for its creator) and games being played.
   */
  getActiveRooms(): GameRoom[] {
    const rooms: GameRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.isDraft || hasAISeat(room)) continue;
      if (room.status === "playing" || this.isJoinable(room)) rooms.push(room);
    }
    return rooms;
  }

  /**
   * Delete a room before its game starts. Only its creator (player 1, by user id: they may
   * come back from another socket / a reloaded lobby) can. A rival waiting for them is released
   * (the caller tells them: `room.player2Id`).
   */
  deleteRoom(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    // Only player 1 (creator) can delete the room
    if (!room.player1Id || room.player1Id !== userId) {
      return false;
    }

    // Can only delete if game hasn't started (nor is starting / settling a no-show claim)
    if (room.status !== "waiting" || room.startPending) {
      return false;
    }

    this.cancelCreatorResponseTimer(roomId);
    this.cancelAnswerTimer(roomId);
    this.rooms.delete(roomId);
    this.unmapRoomSockets(room);
    return true;
  }

  /**
   * Force-delete a room (used by system for auto-cleanup, bypasses creator check).
   */
  forceDeleteRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    // A game in progress closed by an admin has no result: refund its bets
    if (room.status === "playing") this.abandonMatch(room, "Mesa cerrada por un administrador");
    room.status = "finished";
    this.cancelAnswerTimer(roomId);
    // Clean up timers and socket mappings
    this.cancelSetupTimer(roomId);
    this.cancelCreatorResponseTimer(roomId);
    this.unmapRoomSockets(room);
    this.cancelAnswerTimer(roomId);
    this.rooms.delete(roomId);
    return true;
  }

  /**
   * Request to kick a player whose turn has timed out.
   * Returns the winner side if successful.
   */
  requestKick(roomId: string, socketId: string): { success: boolean; winner?: "player1" | "player2"; error?: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: "La partida ya no existe" };
    if (room.adventure) return { success: false, error: "No hay tiempo límite en el Modo Aventura" };
    if (room.gym) return { success: false, error: "No se puede expulsar a un Líder de Gimnasio" };
    if (room.status !== "playing" || !room.gameState) {
      return { success: false, error: "La partida no está en curso" };
    }

    // Determine which player is requesting the kick
    const isPlayer1 = room.player1SocketId === socketId;
    const isPlayer2 = room.player2SocketId === socketId;
    if (!isPlayer1 && !isPlayer2) {
      return { success: false, error: "No juegas en esta mesa" };
    }

    // Only the player the game is waiting on can be kicked (awaitedSide): the side whose turn
    // it is, or whoever owes a pending promotion / Prize / off-turn answer (Challenge!, Terror
    // Strike, promoting after a Knock Out). Never the player who is waiting.
    const awaited = awaitedSide(room.gameState);
    if (!awaited || awaited === (isPlayer1 ? "player1" : "player2")) {
      return { success: false, error: "Solo puedes expulsar al rival cuando la partida lo está esperando" };
    }
    // An off-turn answer is never a forfeit: when its clock runs out the server answers by
    // default (autoAnswerTimedOut); a kick only if no default answer worked
    if (room.answerClock && !room.answerClock.autoAnswerFailed && offTurnAnswerer(room.gameState)) {
      return { success: false, error: "El rival está respondiendo: si se le acaba el tiempo se elige una respuesta por defecto" };
    }

    // Check if turn timer has expired
    if (!room.turnStartedAt) {
      return { success: false, error: "El reloj de la partida no está listo" };
    }
    const elapsed = (Date.now() - room.turnStartedAt) / 1000;
    if (elapsed < room.turnTimerDuration) {
      return { success: false, error: "El rival aún tiene tiempo" };
    }

    // Kick is valid — the requesting player wins
    room.status = "finished";
    this.cancelAnswerTimer(roomId);
    const winner: "player1" | "player2" = isPlayer1 ? "player1" : "player2";
    console.log(`⏱️ Kick: ${winner} wins in room ${roomId} (opponent turn timed out after ${Math.floor(elapsed)}s)`);

    return { success: true, winner };
  }

  /**
   * Watch a game in progress (status "playing"): the spectator gets the neutral masked state
   * (no hands, decks or prizes) and the room chat, and may only chat. A player of the room
   * can't watch it (SeatedSpectatorError: they rejoin their seat instead), nor anyone a private
   * table (PrivateTableError: friendly / reserved). Returns null when the room doesn't exist or
   * isn't being played.
   */
  addSpectator(roomId: string, socketId: string, userId: string): GameRoom | null {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== "playing") return null;
    if (this.seatOf(room, userId)) throw new SeatedSpectatorError();
    if (!isPublicTable(room)) throw new PrivateTableError();
    room.spectators.set(socketId, userId);
    return room;
  }

  /** Stop watching a room. Returns the room when the socket was watching it. */
  removeSpectator(roomId: string, socketId: string): GameRoom | null {
    const room = this.rooms.get(roomId);
    if (!room?.spectators.delete(socketId)) return null;
    return room;
  }

  /** A socket went away: drop it from every room it watched. Returns those rooms' ids. */
  removeSpectatorSocket(socketId: string): string[] {
    const roomIds: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.spectators.delete(socketId)) roomIds.push(room.id);
    }
    return roomIds;
  }

  /** Whether a socket watches a room (spectators never act: they only chat). */
  isSpectator(roomId: string, socketId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.spectators.has(socketId) ?? false;
  }

  /** People watching a room (users, not tabs). */
  spectatorCount(room: GameRoom): number {
    return new Set(room.spectators.values()).size;
  }

  /** Whether the user holds a seat in a room that isn't over (waiting, ready or playing). */
  isUserSeated(userId: string): boolean {
    for (const room of this.rooms.values()) {
      if (room.status === "finished") continue;
      if (room.player1Id === userId || room.player2Id === userId) return true;
    }
    return false;
  }

  /**
   * Find an active ("playing") room where the given user is a player.
   */
  getActiveRoomForUser(userId: string): GameRoom | null {
    for (const room of this.rooms.values()) {
      // Adventure battles resume from the adventure map (GET /adventure/runs/active), not the lobby
      if (room.adventure) continue;
      if (room.status === "playing" && (room.player1Id === userId || room.player2Id === userId)) {
        return room;
      }
    }
    return null;
  }

  /**
   * Close the waiting tables of these users except `keepRoomId` (a user plays one game at a
   * time: their table got a rival, or they take a seat elsewhere). Nothing was escrowed yet (bets
   * are charged when a game starts). Returns the closed rooms (the caller notifies their sockets).
   * The kept room's seats become their sockets' room again (a socket maps to one room).
   */
  closeWaitingRoomsOf(userIds: (string | null)[], keepRoomId: string): GameRoom[] {
    const closed: GameRoom[] = [];
    for (const userId of new Set(userIds)) {
      if (!userId) continue;
      for (const room of this.findWaitingRoomsByUser(userId)) {
        if (room.id === keepRoomId) continue;
        this.forceDeleteRoom(room.id);
        closed.push(room);
      }
    }
    const kept = this.rooms.get(keepRoomId);
    if (kept?.player1SocketId) this.socketToRoom.set(kept.player1SocketId, kept.id);
    if (kept?.player2SocketId) this.socketToRoom.set(kept.player2SocketId, kept.id);
    return closed;
  }

  /** Forget a socket's room only if it is this one (a creator's socket may hold several tables). */
  private unmapSocket(socketId: string, roomId: string): void {
    if (this.socketToRoom.get(socketId) === roomId) this.socketToRoom.delete(socketId);
  }

  private unmapRoomSockets(room: GameRoom): void {
    if (room.player1SocketId) this.unmapSocket(room.player1SocketId, room.id);
    if (room.player2SocketId) this.unmapSocket(room.player2SocketId, room.id);
  }

  /**
   * The lobby tables the user created that wait for a rival (player 1, not draft games): at most
   * one per mode (createRoom). Also the ones whose creator left the lobby (grace period).
   */
  findWaitingRoomsByUser(userId: string): GameRoom[] {
    const rooms: GameRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.status === "waiting" && !room.isDraft && room.player1Id === userId) rooms.push(room);
    }
    return rooms;
  }

  /**
   * Check if both players are ready to start
   */
  isRoomReady(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.player1Id !== null && room.player2Id !== null;
  }

  /**
   * Generate a unique room ID
   */
  private generateRoomId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}
