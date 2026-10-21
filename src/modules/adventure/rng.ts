/**
 * Seeds for adventure randomness (treasure offers; battle RNG in the adventure rooms). `hashSeed`
 * is a local copy of game-core 0.10.0's (FNV-1a, 32 bits) until the API moves to that version.
 */
import { mulberry32 } from "@gonzaloaguila/game-core";

/** FNV-1a 32-bit hash of a string (UTF-16 code units), as an unsigned integer. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

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
