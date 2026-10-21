/**
 * Seeded randomness for adventure offers, with game-core's hashSeed (FNV-1a, 32 bits) and
 * mulberry32 — the same generator the battle rooms use.
 */
import { hashSeed, mulberry32 } from "@gonzaloaguila/game-core";

export { hashSeed };

/** A [0, 1) generator that always yields the same sequence for the same text. */
export function seededRandom(seedText: string): () => number {
  return mulberry32(hashSeed(seedText));
}
