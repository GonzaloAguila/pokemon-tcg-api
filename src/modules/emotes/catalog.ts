/**
 * Battle emotes: the catalog every acquisition path (market, prizes, battle pass, admin grants,
 * draft prizes) and the in-game emote wheel draw from. Mirrored by the frontend's
 * src/domain/emotes/catalog.ts (same ids, names and rarities; images in public/emotes/battle/).
 *
 * Starters are owned by every account without a UserEmote row (like the free Eevee coin) and are
 * the default loadout (User.emoteLoadout's column default).
 */

export type EmoteRarity = "common" | "uncommon" | "rare";

export interface BattleEmote {
  id: string;
  name: string;
  rarity: EmoteRarity;
  /** Animated WebP (always rare). */
  animated: boolean;
  /** Owned by every player and equipped by default. */
  starter?: boolean;
}

/** Emotes a player can take into a game at once. */
export const EMOTE_LOADOUT_SIZE = 5;

export const BATTLE_EMOTES: readonly BattleEmote[] = [
  { id: "pikachu-giggle", name: "Pikachu riéndose", rarity: "common", animated: false, starter: true },
  { id: "eevee-cool", name: "Eevee con lentes", rarity: "common", animated: false, starter: true },
  { id: "psyduck-stressed", name: "Psyduck estresado", rarity: "common", animated: false, starter: true },
  { id: "charizard-think", name: "Charizard pensativo", rarity: "common", animated: false, starter: true },
  { id: "bulbasaur-drink", name: "Bulbasaur con su bebida", rarity: "common", animated: false, starter: true },
  { id: "espeon-love", name: "Espeon enamorado", rarity: "common", animated: false },
  { id: "mudkip-shades", name: "Mudkip con lentes de sol", rarity: "common", animated: false },
  { id: "charmander-derp", name: "Charmander despistado", rarity: "common", animated: false },
  { id: "piplup-angry", name: "Piplup enojado", rarity: "common", animated: false },
  { id: "pikachu-pout", name: "Pikachu haciendo puchero", rarity: "common", animated: false },
  { id: "glaceon-blush", name: "Glaceon sonrojado", rarity: "common", animated: false },
  { id: "sylveon-cute", name: "Sylveon tierno", rarity: "common", animated: false },
  { id: "mew-giggle", name: "Mew risueño", rarity: "common", animated: false },
  { id: "pikachu-angry", name: "Pikachu enojado", rarity: "common", animated: false },
  { id: "pikachu-facepalm", name: "Pikachu sin palabras", rarity: "common", animated: false },
  { id: "fuecoco-hi", name: "Fuecoco saluda", rarity: "common", animated: false },
  { id: "pikachu-thinking", name: "Pikachu pensando", rarity: "common", animated: false },
  { id: "lucario-wtf", name: "Lucario desconcertado", rarity: "uncommon", animated: false },
  { id: "vulpix-cry", name: "Vulpix de Alola llorando", rarity: "uncommon", animated: false },
  { id: "eevee-shiny", name: "Eevee shiny", rarity: "uncommon", animated: false },
  { id: "sylveon-smug", name: "Sylveon presumido", rarity: "uncommon", animated: false },
  { id: "pikachu-grumpy", name: "Pikachu furioso", rarity: "uncommon", animated: false },
  { id: "pikachu-sulk", name: "Pikachu ofendido", rarity: "uncommon", animated: false },
  { id: "pikachu-arms-crossed", name: "Pikachu de brazos cruzados", rarity: "uncommon", animated: false },
  { id: "pikachu-grin", name: "Pikachu pícaro", rarity: "uncommon", animated: false },
  { id: "meowscarada-laugh", name: "Meowscarada se burla", rarity: "uncommon", animated: false },
  { id: "pikachu-side-eye", name: "Pikachu de reojo", rarity: "uncommon", animated: false },
  { id: "sylveon-kiss", name: "Sylveon beso", rarity: "rare", animated: true },
  { id: "leafeon-money", name: "Leafeon millonario", rarity: "rare", animated: true },
  { id: "umbreon-run", name: "Umbreon shiny corriendo", rarity: "rare", animated: true },
  { id: "leafeon-giggle", name: "Leafeon risueño", rarity: "rare", animated: true },
  { id: "shaymin-sip", name: "Shaymin tomando té", rarity: "rare", animated: true },
  { id: "sylveon-typing", name: "Sylveon tecleando", rarity: "rare", animated: true },
  { id: "cubone-cry", name: "Cubone llorando", rarity: "rare", animated: true },
  { id: "cubone-bonk", name: "Cubone dando golpes", rarity: "rare", animated: true },
  { id: "pachirisu-dance", name: "Pachirisu bailando", rarity: "rare", animated: true },
  { id: "squirtle-cool", name: "Squirtle con estilo", rarity: "rare", animated: true },
  { id: "pikachu-shocked", name: "Pikachu sorprendido", rarity: "rare", animated: true },
];

export const EMOTE_BY_ID: ReadonlyMap<string, BattleEmote> = new Map(BATTLE_EMOTES.map((e) => [e.id, e]));

export const STARTER_EMOTE_IDS: readonly string[] = BATTLE_EMOTES.filter((e) => e.starter).map((e) => e.id);
const STARTER_SET: ReadonlySet<string> = new Set(STARTER_EMOTE_IDS);

/** Emotes that can be bought, won or granted (every emote but the starters). */
export const COLLECTIBLE_EMOTES: readonly BattleEmote[] = BATTLE_EMOTES.filter((e) => !e.starter);

export function isStarterEmote(emoteId: string): boolean {
  return STARTER_SET.has(emoteId);
}

export function emoteImageUrl(emoteId: string): string {
  return `/emotes/battle/${emoteId}.webp`;
}
