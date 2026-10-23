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
  `/play/gym/battle/<roomId>` (frontend route) and emits `joinRoom { roomId }` as usual; the
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

## API as built (feat/gym-leaders) — clarifications, no contract change

Event names and payload shapes are exactly the contract above. Details the contract left open:

- **`gymQueue.position`**: 1 = next in line while `status: "waiting"`; **0** while the user's own
  battle is `ready` or `playing` (then `roomId` is set; `readyExpiresAt` only while `ready`).
  `gymQueue` is sent to the user's sockets on every change of their own state, including `null`
  when they leave, are skipped (ready window expired, deck no longer valid) or their battle ends.
  Order: `gymBattleReady` goes out before the matching `gymQueue`.
  Queue membership is per user: a socket disconnecting (leaving `/lobby`) never drops anyone from a
  queue; only `leaveGymQueue`, the 60 s ready window running out, a deck that fails the re-check, or
  the battle ending does. Every per-user event (`gymQueue`, `gymBattleReady`, `gymBattleResult`) goes
  to the user's room (`user:<id>`), so all their sockets get it. `getGymTables` always answers with
  both `gymTables` and the caller's `gymQueue` (ack `{ ok: true }`, optional).
- **Entering the battle**: `joinRoom { roomId }` (no deck: the battle uses the deck the user queued
  with, re-checked now). Errors on that `joinRoom` (the usual `error` event): `ROOM_NOT_FOUND`
  (not your ready battle, expired, or the API restarted), `GYM_DECK_INVALID` (the deck no longer
  passes: the user is skipped, `message` says why), `GYM_BATTLE_FAILED` (server error: skipped).
  Reconnecting to a battle in progress is the same `joinRoom` (any tab) → `gameStart` with `gym`.
  `checkActiveGame` also returns a gym battle in progress (`activeGame.roomId`).
- **`gameStart`** for a gym room: `mode: "gym"`, `isPlayer1: true` (the challenger is always
  player 1), `opponentInfo = { username: "Brock", avatarId: "gym-brock", titleId: null }`,
  `opponentCosmetics = { playmatId: "playmat-ciudad-plateada", coinId: "golem", cardBackId:
  "cardback-brock" }`, `opponentVariantMap: {}`, the challenger's own cosmetics/variants as usual,
  `gym = { leaderId, name, title, mode, medalId, avatarId }`.
- **Clock**: `turnTimerDuration` = 180 and `gameState.clock` (`kind: "turn"`, `userId` = the
  challenger while the battle waits on them, `startedAt`, `durationSeconds`) as in table games. One
  clock per turn of the challenger (the opening counts as one; an answer they owe during Brock's
  turn — a promotion, Terror Strike… — gets its own), not restarted by each action. Running out:
  the state ends (`GAME_OVER`, log line "Jugador 1 se quedó sin tiempo"), `gameOver { winner:
  "player2", reason: "Se acabó tu tiempo" }`, then `gymBattleResult { victory: false }`.
  `requestKick` in a gym room answers "No se puede expulsar a un Líder de Gimnasio".
- **Away from the battle** (socket disconnected, or `leaveRoom` during the battle: the battle stays
  and can be re-entered): after 2 minutes without a seat socket the battle is lost — log "Jugador 1
  abandonó la batalla", `gameOver { winner: "player2", reason: "Abandonaste la batalla
  (desconexión)" }`, `gymBattleResult { victory: false }`. Surrender is the normal `surrender`
  action.
- **End**: `gameOver` first, then `gymBattleResult` to the user's sockets (`user:<id>` room). The
  medal is written before `gymBattleResult` is sent (so `/api/users/me` already lists it), and
  only on a victory in a played battle; `medalGranted` is true only the first
  time (`grantMedal` → `UserMedal`, read by `/api/users/me` `medals`). No match row, coins, XP,
  stats, missions or achievements. The finished room stays 2 minutes (game-over screen), then is
  dropped.
- **Brock's side**: the game-core smart AI (`nextAIStep`/`applyAIStep`, same driver as Modo
  Aventura: `src/socket/ai-seat.ts`). He never plays a Trainer whose steps the challenger answers.
  When the challenger plays one whose step Brock answers (Erika, Challenge!, Blaine's Quiz, Lt.
  Surge's Treaty, a Chaos Gym offer…), the server answers with game-core's AI answer (Chaos Gym
  offers: declined) and broadcasts it like an action (`opponentAction { type:
  "answerTrainerChoice" }` + `gameState`).
- **Privacy**: gym rooms are never in `roomList`, `spectateRoom` answers `PRIVATE_TABLE`,
  `chatMessage` is ignored, nobody else can `joinRoom` them (`ROOM_NOT_FOUND` before the battle is
  built, reserved after). They appear in the backoffice `GET /api/admin/rooms` with `mode: "gym"`;
  closing one there (`DELETE /api/admin/rooms/:roomId`) ends it without a result and the queue
  moves on.
- **Persistence**: none. An API restart closes every gym and drops queues and battles.

### Admin (as built)

Permission `users:economy` (no new permission; superadmin always). All under `/api`:

- `GET /admin/gyms` → `{ gyms: [{ leaderId, name, title, avatarId, mode: "normal", modes: ["normal"],
  status: "closed" | "open" | "closing", openedAt, closesAt, queueLength, queue: [{ userId, username, mode, position, joinedAt }],
  current: { userId, username, mode, status: "ready" | "playing", roomId, readyExpiresAt } | null,
  inBattle, schedule: { enabled, nextOpenAt, minGapMinutes, maxGapMinutes, openMinutes } }] }`.
- `POST /admin/gyms/:leaderId/open { minutes?: 1–1440 }` (default 45) → `{ gym }` (same row). Also
  reopens / extends a gym that is open or closing.
- `POST /admin/gyms/:leaderId/close` → `{ gym }`: no new challengers; queued users still play
  (`closing`), an empty gym is `closed` at once.
- Unknown leader → 404; bad `minutes` → 400.

### Scheduler

`src/modules/gym/gym.config.ts` `GYM_SCHEDULE` (`enabled: false`, 2–6 h gap, 45 min open) and
`GYM_TIMING` (ready window 60 s, turn clock 3 min, disconnect grace 2 min). Turning the scheduler on
is a one-line change + API deploy (no env var).

## Deck tuning (Brock, normal)

Re-run: `npx tsx scripts/gym-deck-sim.ts --games 200 --deck original,shipped` (~3 min per deck;
`--deck all` runs every candidate kept in the script, `--print --deck <name>` prints a list).
Smart AI vs smart AI on both seats (`policyPair("smart")`), games through game-core's headless
runner on `createAdventureGame` with no modifiers (`playAdventureAIGame`: 6 Prizes, 7-card hand —
the exact game creation the gym rooms use; same runner as `playAIGame`, which takes theme-deck
`Deck`s instead of card lists), fixed seeds (`hashSeed("gym:<opponent>:<i>")`), Brock on side A
in even games and side B in odd ones, 0 engine failures. Opponents: every game-core theme deck
(classic + Gym Leaders, Brock's excluded) without Grass/Water Pokémon or basic Energy (the 20/20/20
rule is ignored for them): 9 decks.

| Opponent | Before (gym-heroes-brock) | After (shipped) |
|---|---|---|
| zap | 82% | 86% |
| haymaker | 17% | 39% |
| damage-swap | 77% | 88% |
| fire-fighting | 24% | 48% |
| thunderstorm | 96% | 98% |
| colorless | 54% | 70% |
| gym-heroes-lt-surge | 76% | 77% |
| gym-heroes-sabrina | 49% | 56% |
| gym-heroes-blaine | 51% | 61% |
| **Overall (1,800 games)** | **58.3%** | **68.9%** |

200 games per pairing. What changed: the same 22 Brock's Pokémon; out went Good Manners ×2, Secret
Mission, Recall, The Rocket's Trap and 6 Fighting Energy (26 → 20); in came Energy Removal ×4,
Super Energy Removal, Gust of Wind ×2, PlusPower, Bill ×2 and Professor Oak (all played well by the
smart AI). Tried and dropped (100 games per pairing): a hard-hitter list with Gym Challenge's
Diglett/Dugtrio and Mankey/Primeape (54.8%), swapping the Sandshrew line for Diglett/Dugtrio
(49.6%), Brock's Protection instead of Brock (61.0%), bigger Basics (62.6%). Energy denial is what
moves the numbers; Haymaker (4 Energy Removal + 3 Super Energy Removal of its own, Hitmonchan) and
Fire-Fighting (Machamp, Charizard) remain the hard matchups. Players build better decks than the
theme decks, so these rates are an upper bound for Brock against strong players.
