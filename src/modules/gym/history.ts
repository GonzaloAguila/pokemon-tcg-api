import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { MatchChallengeData } from "../../socket/challenge-tracker.js";
import type { GymMode } from "./content/types.js";
import type { GymScore } from "./gym.service.js";

/** How a gym game ended, for its match row: the game's own result, or the series cut it short. */
export type GymGameOutcome = "victory" | "defeat" | "draw" | "timeout" | "disconnect" | "error" | "admin";

/** `Match.gym` (admin match history). */
export interface GymMatchInfo {
  leaderId: string;
  leaderName: string;
  mode: GymMode;
  game: number;
  bestOf: number;
  /** The series' score after this game. */
  score: GymScore;
}

/** `Match.winReason` of a gym game. */
export function gymWinReason(outcome: GymGameOutcome, leaderName: string): string {
  switch (outcome) {
    case "victory":
      return "Ganó el retador";
    case "defeat":
      return `Ganó ${leaderName}`;
    case "draw":
      return "Empate";
    case "timeout":
      return "Al retador se le acabó el tiempo";
    case "disconnect":
      return "El retador abandonó la batalla";
    case "error":
      return "La batalla se interrumpió por un error";
    case "admin":
      return "Cerrada por un admin";
  }
}

const asJson = (value: object): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * One game of a gym series, as a match row of the admin's match history: mode "gym", player 1 the
 * challenger, player 2 empty (the leader's AI, named in `gym`), settled at once with nothing paid
 * (counted false, no XP; the series' entry cost and rewards live in their own tables). With
 * `challenge` (the room's challenge tracker) it also keeps both decks as played, how the game
 * ended and each seat's feats, which the challenge achievements read (achievements/challenges.ts).
 */
export async function recordGymGame(input: {
  roomId: string;
  userId: string;
  outcome: GymGameOutcome;
  finalTurn: number;
  startedAt: Date;
  info: GymMatchInfo;
  challenge?: MatchChallengeData;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const abandoned = input.outcome === "disconnect" || input.outcome === "error" || input.outcome === "admin";
  const { challenge } = input;
  await prisma.match.create({
    data: {
      ...(challenge
        ? {
            player1Deck: asJson(challenge.player1Deck),
            player2Deck: asJson(challenge.player2Deck),
            endKind: challenge.endKind,
            feats: asJson(challenge.feats),
          }
        : {}),
      mode: "gym",
      gameMode: "standard",
      status: abandoned ? "abandoned" : "finished",
      roomId: input.roomId,
      player1Id: input.userId,
      winnerId: input.outcome === "victory" ? input.userId : null,
      winReason: gymWinReason(input.outcome, input.info.leaderName),
      finalTurn: input.finalTurn,
      gym: { ...input.info, score: { ...input.info.score } },
      counted: false,
      startedAt: input.startedAt,
      finishedAt: now,
      settledAt: now,
    },
  });
}
