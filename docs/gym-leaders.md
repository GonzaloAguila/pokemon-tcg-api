# Líderes de Gimnasio (v1: Brock) — design + API/frontend contract

Owner request (2026-10-22): the 8 Kanto Gym Leaders are independent AIs that play to win. Every so
often a leader's table **appears suddenly** in the lobby; challengers **queue** and play one at a
time; the table **can't be spectated**. Each leader has **deck rules** for the challenger's deck and
**two versions** (normal deck, then expert). Start with **Brock** (normal deck only), with his own
avatar, card back, playmat and coin. Beating him gives the **Medalla Roca**.

Branches: API `feat/gym-leaders` (this repo), frontend `feat/gym-leaders` (pokemon-tcg). No
game-core change: the leader's deck and rules are API data, like adventure content; battles use the
game-core smart AI through `nextAIStep` / `applyAIStep`, exactly as adventure rooms do.

## Decisions (controller's calls, owner can change)

- **Brock's rules for the challenger's deck** = what the profile Medals tab already shows
  (`KANTO_MEDALS` / `GYM_DECK_RULE` in the frontend): no Grass or Water **Pokémon** (any of its
  `types`) and no Grass or Water **basic Energy**; and exactly **20 Pokémon, 20 Trainers, 20 Energy**
  (Trainers that are played as Basics, e.g. Mysterious Fossil, count as Trainers; Energy = basic +
  special). Plus the normal deck rules (`checkDeckPlayable`: 60 cards, 4 copies, owned cards…).
  Theme decks (non-UUID ids) are allowed only if they pass the same gym rules.
- **Reward:** first victory against Brock (normal) grants UserMedal `boulder` (`grantMedal`, idempotent).
  The Medals tab already reads `user.medals` and celebrates new medals. The 2 extra challenges
  (coin `golem`, card back) are NOT in v1.
- **No economy:** gym battles give no coins/XP, no match row, no bets (like adventure).
- **Appearance:** a scheduler opens a leader's gym at random moments for a while. v1 ships with the
  scheduler **disabled** (`GYM_SCHEDULE.enabled = false`) so nothing appears in prod until the owner
  turns it on; an admin endpoint/button opens and closes a gym on demand for testing.
  Defaults when enabled: next opening 2–6 h after the last one closed (random), open for 45 min.
- **Queue:** one battle at a time per leader. Joining requires a deck that passes the rules (checked
  when joining and again when the battle starts). When the gym closes, nobody new can queue; people
  already queued still get their battle. When it's your turn you get `gymBattleReady`; you must enter
  within 60 s or you're skipped. During the battle the challenger has a **3-minute clock per turn**
  (and a 2-minute disconnect grace); running out = loss, so the queue keeps moving.
- **Expert mode:** the leader data has `decks: { normal, expert? }` and every table/queue/battle
  payload carries `mode: "normal" | "expert"`; v1 only has `normal` (expert later).
- **Leader cosmetics:** Brock's side uses avatar `gym-brock` (`/gym-leaders/brock/brock.png`), card back
  `cardback-brock` (`/gym-leaders/brock/brock_bkc.png`, new catalog entry, not grantable in v1),
  playmat `playmat-ciudad-plateada` and coin `golem` (both exist). The AI seat's cosmetics are fixed
  in `room.cosmetics.player2` (not loaded from a user).
- **AI strength:** the game-core smart AI is the only AI (no difficulty knob). "Play to win" in v1 =
  smart AI + a tuned deck. Brock's normal deck starts from game-core `gym-heroes-brock` and is tuned
  with simulations (`playAIGame`) against rule-legal theme decks; avoid Trainers the AI doesn't play.

## Data: `src/modules/gym/content/` (API)

```ts
interface GymLeaderDef {
  id: "brock";                       // later misty, lt-surge, …
  name: "Brock";
  title: "Líder del Gimnasio de Ciudad Plateada";
  medalId: "boulder";                // UserMedal id, matches frontend KANTO_MEDALS
  avatarId: "gym-brock";
  cosmetics: { playmatId: "playmat-ciudad-plateada"; coinId: "golem"; cardBackId: "cardback-brock" };
  rules: { bannedTypes: EnergyType[]; composition?: { pokemon: number; trainer: number; energy: number } };
  decks: { normal: CardEntry[]; expert?: CardEntry[] };   // CardEntry = { cardId, qty }
}
```

## Socket contract (API ⇄ frontend)

All events on the existing lobby/game socket (same auth as rooms).

Server → client:
- `gymTables` — broadcast to everyone whenever anything changes (open/close, queue length, battle
  start/end), and in reply to `getGymTables`. Payload: `GymTable[]` (only open gyms or gyms still
  serving their queue):
  ```ts
  interface GymTable {
    leaderId: string; name: string; title: string; avatarId: string; medalId: string;
    mode: "normal" | "expert";
    rules: { bannedTypes: string[]; composition: { pokemon: number; trainer: number; energy: number } | null };
    status: "open" | "closing";      // closing = no new joins, still serving the queue
    closesAt: number;                // epoch ms (when new joins stop)
    queueLength: number;             // waiting, not counting the one playing
    inBattle: boolean;
  }
  ```
- `gymQueue` — to one user, whenever their own queue state changes, and in reply to `getGymTables`:
  `{ leaderId, mode, position, status: "waiting" | "ready" | "playing", roomId?, readyExpiresAt? } | null`
  (`position` 1 = next; `null` = not queued).
- `gymBattleReady` — to one user: `{ leaderId, mode, roomId, expiresAt }`. The client navigates to
  `/multiplayer/<roomId>?gym=1` (or a dedicated route) and emits `joinRoom { roomId }` as usual; the
  server answers with the normal `gameStart` (+ `gym: GymGameStartInfo`).
- `gymBattleResult` — to one user after the battle: `{ leaderId, mode, victory, medalId, medalGranted }`
  (`medalGranted` = first time).

Client → server (with ack `{ ok: true } | { ok: false, error: string }`, Spanish error text):
- `getGymTables {}`
- `joinGymQueue { leaderId, mode, deckId }` — errors e.g. "El gimnasio está cerrado", "Tu mazo no
  puede tener Pokémon de tipo Agua", "Tu mazo debe tener exactamente 20 Pokémon (tiene 18)",
  "Ya estás en la fila".
- `leaveGymQueue { leaderId }`

`gameStart` for a gym room = the normal payload (`opponentInfo.username = "Brock"`, `avatarId =
"gym-brock"`, `opponentCosmetics` = Brock's fixed cosmetics) plus
`gym: { leaderId, name, title, mode, medalId, avatarId }`. Gym rooms: id prefix `gym-`, never in
`roomList`, not watchable, no chat, no bets, no settlement.

Admin (REST, permission `users:economy` or a new `gyms:manage`, superadmin always):
- `GET /api/admin/gyms` → leaders with status (open/closed/closing, closesAt, queue, inBattle, schedule).
- `POST /api/admin/gyms/:leaderId/open { minutes?: number }` (default 45) and `POST …/close`.

## Frontend

- Lobby "Batallas": an open gym renders as a distinct card at the top of the list (leader avatar,
  name/title, "Gimnasio abierto", countdown to close, rules in plain Spanish, queue length, "En batalla"
  when someone plays, never "Mirar"). Button "Hacer fila" → pick a deck (reuse the deck picker of
  "Crear mesa") → `joinGymQueue`; the ack error goes to a toast. When queued: "Tu lugar en la fila: N"
  + "Salir de la fila". On `gymBattleReady`: a modal/toast "¡Brock te espera!" with "Entrar" (and
  auto-navigate) before `expiresAt`.
- Battle: `MultiplayerGamePage` with a `gym` context (like `adventure`): no chat, no spectating,
  rival name/avatar/cosmetics from `gameStart`; game over shows the medal when `gymBattleResult.victory`;
  exit back to the lobby.
- Catalog entries: avatar `gym-brock` (exclusive, not selectable/ownable by players) and card back
  `cardback-brock` (`/gym-leaders/brock/brock_bkc.png`).
- Admin backoffice: open/close a gym (button per leader, minutes) in the rooms tab.
