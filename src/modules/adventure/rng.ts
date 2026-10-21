/**
 * Seeded shuffles for adventure randomness (treasure offers), with game-core's hashSeed
 * (FNV-1a, 32 bits) and mulberry32 — the same generator the battle rooms use.
 */
import { hashSeed, mulberry32 } from "@gonzaloaguila/game-core";

export { hashSeed };

/** Fisher–Yates shuffle (new array) driven by mulberry32(hashSeed(seedText)). */
export function seededShuffle<T>(items: readonly T[], seedText: string): T[] {
  const next = mulberry32(hashSeed(seedText));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
