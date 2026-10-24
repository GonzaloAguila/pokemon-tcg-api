/**
 * Adventures are data: `content/adventures/<id>.json` at the repo root, read once and validated
 * (validate.ts). An invalid file stops the server at boot (index.ts calls `getAdventures()` before
 * listening) with every problem listed.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateAdventure, type Adventure } from "./validate.js";

export { validateAdventure, type Adventure } from "./validate.js";

/** <repo>/content/adventures, from src/… (tsx, vitest) and from dist/… (production). */
export const ADVENTURES_DIR = path.resolve(__dirname, "../../../../content/adventures");

export class AdventureContentError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Contenido de aventuras inválido:\n- ${problems.join("\n- ")}`);
    this.name = "AdventureContentError";
  }
}

export function loadAdventures(dir: string = ADVENTURES_DIR): ReadonlyMap<string, Adventure> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const adventures = new Map<string, Adventure>();
  const problems: string[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      problems.push(`${file}: JSON inválido (${(err as Error).message})`);
      continue;
    }
    const result = validateAdventure(raw);
    if (!result.ok) {
      problems.push(...result.problems.map((p) => `${file}: ${p}`));
      continue;
    }
    const { adventure } = result;
    if (`${adventure.id}.json` !== file) problems.push(`${file}: el id "${adventure.id}" no coincide con el nombre del archivo`);
    adventures.set(adventure.id, adventure);
  }
  const byOrder = new Map<number, string>();
  for (const adventure of adventures.values()) {
    const other = byOrder.get(adventure.order);
    if (other) problems.push(`order ${adventure.order} repetido en ${other} y ${adventure.id}`);
    byOrder.set(adventure.order, adventure.id);
  }
  if (problems.length > 0) throw new AdventureContentError(problems);
  return new Map([...adventures].sort(([, a], [, b]) => a.order - b.order));
}

let cache: ReadonlyMap<string, Adventure> | null = null;

/** Every adventure, loaded and validated on the first call. */
export function getAdventures(): ReadonlyMap<string, Adventure> {
  cache ??= loadAdventures();
  return cache;
}

export function getAdventure(id: string): Adventure | undefined {
  return getAdventures().get(id);
}
