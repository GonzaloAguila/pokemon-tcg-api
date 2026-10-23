/**
 * A gym's fixed Stadium (docs/gym-leaders.md, v2.1: Pewter City Gym is always in play in Brock's
 * battles). Set on the created state the way game-core stores a played Stadium (`state.stadium`);
 * no card in our sets discards a Stadium and neither deck may hold one, so it stays all game.
 */
import { createGameEvent, findCardById, type GameState } from "@gonzaloaguila/game-core";

/**
 * The state with the Stadium in play, played by the leader ("opponent": the challenger is
 * "player"), and a log line. Unchanged when there is none (or an unknown id).
 */
export function withFixedStadium(state: GameState, stadiumId: string | undefined, idPrefix: string): GameState {
  const card = stadiumId ? findCardById(stadiumId) : undefined;
  if (!card) return state;
  return {
    ...state,
    stadium: { card: { ...card, id: `${idPrefix}-stadium` }, playedBy: "opponent" },
    events: [...state.events, createGameEvent(`${card.name} está en juego durante toda la batalla`, "info")],
  };
}
