# Líderes de Gimnasio (v2.2: Brock normal + EXPERT, best of 3, 2 attempts a day) — design + API/frontend contract

Owner request (2026-10-22): the 8 Kanto Gym Leaders are independent AIs that play to win. Every so
often a leader's table **appears suddenly** in the lobby; one challenger at a time plays it; the
table **can't be spectated**. Each leader has **deck rules** for the challenger's deck and **two
versions** (normal and EXPERT). Start with **Brock**, with his own avatar, card back, playmat, coin
and emotes.

v2 (owner feedback 2026-10-23, after testing v1): **no queue** — a table is free (anyone may
challenge it) or in battle (nobody can); **first-victory rewards** per version; Brock's **EXPERT**
deck and table (both versions open at once, each opened and closed on its own); admins **edit the
leaders' decks**; a **public catalog** of every leader.

v2.1 (owner's rules for Brock, same day): **Pewter City Gym always in play**; no Grass, Psychic or
Fighting Pokémon, none of Brock's own Pokémon, no Stadium cards, at most 20 Trainers, at most 2
copies of each Trainer (1 in EXPERT; Pokémon and Energy keep the normal 4 — owner, 2026-10-23,
replacing "2 copies of every card" and 25 Trainers); a challenge is a **best of 3** series and
costs **100 coins**. (The v1/v2 20/20/20 composition, the Grass/Water Energy ban and the separate
Trainer / special Energy copy limits are gone.)

v2.2 (owner, same day): **2 challenges a day** per user per leader (normal and EXPERT together).

Branches: API `feat/gym-leaders` (this repo), frontend `feat/gym-leaders` (pokemon-tcg). No
game-core change: the leader's decks, rules and rewards are API data, like adventure content;
battles use the game-core smart AI through `nextAIStep` / `applyAIStep`, exactly as adventure rooms do.

## Decisions (controller's calls, owner can change)

- **A table = a leader's version** (leader × mode): "Brock" and "Brock EXPERT" are two tables, each
  `closed` / `open` / `closing`, each with at most one series. A free open table is challenged with a
  deck that passes the rules (and 100 coins); the first game's room is built at once; the table is
  in battle for the whole series, then free again. Two challenges at once: the first wins, the other
  gets the in-battle error. A user plays one gym series at a time (any table).
- **Best of 3**: up to 3 games, same decks, first to 2 wins. Each game is its own `gym-…` room; when a
  game ends undecided the server builds the next one and tells the challenger (`gymSeries` `next`).
  A game lost on time (or surrendered) is a lost game; the disconnect grace running out (also never
  entering a game) forfeits the series. A drawn game counts for nobody (a series still undecided
  after 5 games goes to the score, a tie to the leader).
- **Brock's rules for the challenger's deck** (both versions): no **Pokémon** with type Grass, Psychic
  or Fighting (Energy is not restricted by type); no Pokémon of Brock (`ownerOf`: every "Brock's …");
  no Stadium cards; at most **20 Trainers** (Trainers played as Basics count); at most **2 copies of
  each Trainer by name** (EXPERT: **1**); Pokémon and Energy keep the normal 4. Plus the normal deck rules
  (`checkDeckPlayable`: 60 cards, 4 copies, owned cards…). Theme decks (non-UUID ids) only if they
  pass the same rules. The rules never apply to the leader's own deck — but neither deck has a
  Stadium: **Pewter City Gym** is in play from the start of every game (set on the created state as
  game-core stores a played Stadium, `state.stadium`, played by the leader; no card in our sets
  discards a Stadium, so it stays all game).
- **Entry cost**: 100 coins (both versions), charged with `spendCoins` (conditional debit,
  transaction `gym_entry`, "Reto a Brock: -100 monedas" / "Reto a Brock EXPERT: -100 monedas") when the
  series is created; refunded (`gym_entry_refund`, with the day's attempt) only if the series ends
  without a winner (the game broke, an admin closed it, its first game couldn't be built). Not refunded on a loss. An API
  restart drops the series without a refund (nothing is persisted).
- **Daily attempts**: `attemptsPerDay` (Brock: 2) series per user per leader per **economy day**
  (`ECONOMY.timeZone`, 00:00 Argentina = 03:00 UTC, economy-time.ts — the wheel's reset), both
  versions on one counter. One attempt = one series started (`challengeGym` ok); losing, timing out
  or forfeiting uses it; a series refunded for an error gives it back. Persisted: one `GymAttempt`
  row per series started (`day` = its economy day, `refunded`), so an API restart keeps the count.
  Taken while the user's table reservation is held (no second series of the same user can race it).
- **Rewards (first series victory per version, once):** normal = medal `boulder` + coin `golem`
  ("Moneda de Brock") + card back `cardback-brock` + **1500 coins**; EXPERT = **3000 coins** + card back
  `cardback-brock-expert` ("Brock EXPERT", `/gym-leaders/brock/brock_bkc_expert.jpg`). A later
  victory gives nothing. Coins through `creditBalance` (transaction `gym_reward`, "Victoria contra
  Brock: +1500 monedas"). "First" = the version's marker row was created now (normal: the medal;
  EXPERT: the EXPERT card back), all in one transaction.
- **No other economy:** no XP, stats, missions, bets or settlement (like adventure). Each game is a
  match row of the admin's match history (`modules/gym/history.ts` `recordGymGame`: `mode: "gym"`,
  player 1 the challenger, no player 2, `counted: false`, settled at once with nothing paid).
- **Challenge achievements (owner 2026-10-24, "que cuente para Brock también"):** gym games count
  for EVERY challenge achievement (`modules/achievements/challenges.ts`), like a counted normal
  game. The room has a challenge tracker (`socket/challenge-tracker.ts`, created in `buildGame`,
  deck source "user" for a DB deck, "theme" for a theme deck; the AI seat driver observes the
  leader's steps too), and the match row keeps `player1Deck` / `player2Deck` / `endKind` / `feats` /
  `finalTurn`. `loadChallengeGames` reads `mode: "gym"` rows with `status: "finished"` (not the
  abandoned ones: disconnect, error, admin close) despite `counted: false`; the usual rules apply
  (a played win: Prizes / no Pokémon / deck out; a surrender, a lost clock or the leader's win
  never). Recording a game re-checks the challenger's challenges in the background. Gym rows
  recorded before this have no deck snapshot and can't count. Still not "Leyenda Viviente",
  stats, XP or anything else.
- **Appearance:** a scheduler opens each table at random moments for a while. It ships **disabled**
  (`GYM_SCHEDULE.enabled = false`); admins open and close each version on demand.
  Defaults when enabled: next opening 2–6 h after that table last closed (random), open for 45 min.
- **Leader cosmetics:** Brock's side (both versions) uses avatar `gym-brock`, card back
  `cardback-brock`, playmat `playmat-ciudad-plateada`, coin `golem`; fixed in `room.cosmetics.player2`.
- **AI strength:** the game-core smart AI is the only AI. "Play to win" = smart AI + tuned decks
  ("Deck tuning" below). EXPERT must beat the normal deck's win rate.

## Data: `src/modules/gym/content/` (API)

```ts
interface GymLeaderDef {
  id: "brock"; name: "Brock"; title: "Líder del Gimnasio de Ciudad Plateada";
  medalId: "boulder";                // the leader's medal (tables show it)
  avatarId: "gym-brock";
  entryCost: 100;                    // coins per challenge (both versions)
  attemptsPerDay: 2;                 // series per user per economy day (both versions together)
  cosmetics: { playmatId; coinId; cardBackId };        // the AI seat's
  emotes?: { battleStart?; knockOut?; victory? };     // frontend LEADER_EMOTES ids
  rules:   { normal: GymRules;   expert?: GymRules };  // internal: bannedPokemonTypes, bannedOwners, noStadiums, maxTrainers?, maxTrainerCopies?, fixedStadiumId?
  rewards: { normal: GymRewards; expert?: GymRewards };
  decks:   { normal: CardEntry[]; expert?: CardEntry[] };   // content defaults (CardEntry = { cardId, qty })
}
```
A version exists when it has rules, rewards and a deck. The deck a game plays is the version's
saved deck (`GymLeaderDeck` row, backoffice) if any and still valid, else the content default.
`GYM_BEST_OF = 3` (`gym.config.ts`).

## Socket contract (API ⇄ frontend)

All events on the existing lobby/game socket (same auth as rooms).

Server → client:
- `gymTables` — broadcast to everyone whenever a table changes (open/close, series start, each game,
  series end), and in reply to `getGymTables`. Payload `GymTable[]`, one per open table and per
  closing table whose series still runs (a closing table without one is closed and gone), in
  content order (normal before expert):
  ```ts
  interface GymRules {
    bannedPokemonTypes: string[];          // Pokémon only
    bannedOwners: string[];                // "Brock" = no "Brock's …" Pokémon
    noStadiums: boolean;
    maxTrainers: number | null;            // total, Trainers played as Basics count
    maxTrainerCopies: number | null;       // per Trainer name; null = the normal 4 (Pokémon and Energy always 4)
    fixedStadium: { cardId: string; name: string } | null;   // in play every game
  }
  interface GymRewards { medalId: string | null; coins: number; coinId: string | null; cardBackId: string | null }
  interface GymTable {
    leaderId: string; name: string; title: string; avatarId: string; medalId: string;
    mode: "normal" | "expert";
    rules: GymRules;                 // this version's
    rewards: GymRewards;             // this version's first series victory
    entryCost: number;               // 100
    bestOf: number;                  // 3
    status: "open" | "closing";      // closing = no new challenges
    closesAt: number;                // epoch ms (when new challenges stop)
    inBattle: boolean;               // the whole series
    challenger: { username: string; avatarId: string | null } | null;
    series: { game: number; score: { challenger: number; leader: number } } | null;
  }
  ```
- `gymSeries` — to one user (all their sockets, room `user:<id>`) whenever their series changes:
  `{ leaderId, mode, game: 1|2|3, score: { challenger, leader }, roomId, status }` — `playing` (the
  first game's room was built, or the challenger entered the next one: `roomId` is the game in
  progress), `next` (a game ended undecided: `roomId` is the NEXT game, not entered yet — show the
  score and "Siguiente partida" → `/play/gym/battle/<roomId>` + `joinRoom`), `finished` (the series is
  over, `roomId` = its last game; sent right before `gymBattleResult`, also when an admin closed the
  game). Never sent as `null`.
- `gymAttempts` — to one user whenever their attempts change (a series started, a refund):
  `Record<leaderId, { used: number; perDay: number; resetsAt: number /* epoch ms, next 00:00 Argentina */ }>`
  (every leader). Not part of the broadcast `gymTables`; nothing is sent at midnight (use `resetsAt`).
- `gymBattleResult` — once, when the series ends with a result:
  `{ leaderId, mode, victory, medalId, medalGranted, rewards: GymRewards | null, score }` — `victory` =
  won the series; `rewards` = what was granted now (first series victory of that version only; an
  item the user already had, e.g. from the backoffice, is `null` inside it); `medalGranted` =
  `rewards?.medalId != null`; `medalId` is the leader's medal (also on EXPERT, where it isn't
  granted). Not sent when an admin closed the game (no result; the entry cost goes back).

Client → server:
- `getGymTables {}` (or `emit("getGymTables", ack)`) → emits `gymTables` (+ `gymSeries` when the user
  has a series); ack `{ ok: true, tables: GymTable[], mySeries: GymSeries | null, myAttempts }`
  (`status` `playing` / `next`; `myAttempts` = the `gymAttempts` record, `{}` signed out).
- `challengeGym { leaderId, mode, deckId }` (`mode` missing = "normal") → ack
  `{ ok: true, roomId } | { ok: false, error }`. Errors (Spanish): "El gimnasio está cerrado" (closed
  or closing), "Brock está en batalla: esperá a que termine", "Ya estás en una batalla de gimnasio",
  "Ya usaste tus 2 intentos de hoy contra Brock. Vuelve mañana." (checked after the table's state,
  before the coins and the deck), "Necesitás 100 monedas para retar a Brock", "Ese gimnasio no existe", "Ese desafío todavía no está
  disponible" (a version the leader doesn't have), the normal deck errors (`checkDeckPlayable`), the
  leader's rules ("Tu mazo no puede tener Pokémon de tipo Psíquico (Abra)", "Tu mazo no puede tener
  Pokémon de Brock (Brock's Onix)", "Tu mazo no puede tener cartas de Estadio (Pewter City Gym)", "Tu
  mazo no puede tener más de 25 Entrenadores (tiene 28)", "Tu mazo no puede tener más de 2 copias de
  Bill (tiene 4)" — the card's `name`, as the deck builder shows it), "No se pudo empezar la
  batalla". Nothing is charged (nor an attempt used) on a refusal. On ok an attempt is used
  (`gymAttempts`), the 100 coins are spent and the first game's room
  exists (reserved for the challenger, in `MULLIGAN`, the leader's opening played, Pewter City Gym in
  play): navigate to `/play/gym/battle/<roomId>` and emit `joinRoom { roomId }` → the normal
  `gameStart` (+ `gym`). Each game's disconnect grace (2 min without a seat socket) runs from its
  creation.

`gameStart` for a gym room = the normal payload plus `gym: { leaderId, name, title, mode, medalId,
avatarId, game, bestOf, score }` (`game` / `bestOf` / `score` are additions to the contract: the
series at that moment): `mode: "gym"`, `isPlayer1: true` (the challenger is always player 1),
`opponentInfo = { username: "Brock", avatarId: "gym-brock", titleId: null }`, `opponentCosmetics` =
Brock's fixed cosmetics, `opponentVariantMap: {}`, the challenger's own cosmetics/variants as usual;
`gameState.stadium = { card: Pewter City Gym, playedBy: "opponent" }`. Re-entering a game in
progress is the same `joinRoom` (any tab); `checkActiveGame` also returns it.

### As built — details

- **Clock**: `turnTimerDuration` = 180 and `gameState.clock` (`kind: "turn"`, `userId` = the
  challenger while the game waits on them, `startedAt`, `durationSeconds`) as in table games. One
  clock per turn of the challenger (the opening counts as one, and runs from the game's creation; an
  answer they owe during Brock's turn — a promotion, Terror Strike… — gets its own), not restarted by
  each action. Running out: the game ends (`GAME_OVER`, log "Jugador 1 se quedó sin tiempo"),
  `gameOver { winner: "player2", reason: "Se acabó tu tiempo" }`, a point for Brock, the series goes
  on. `requestKick` answers "No se puede expulsar a un Líder de Gimnasio".
- **Away from a game** (never entered, socket disconnected, or `leaveRoom`: the game stays and can be
  re-entered): after 2 minutes without a seat socket the series is lost — log "Jugador 1 abandonó la
  batalla", `gameOver { winner: "player2", reason: "Abandonaste la batalla (desconexión)" }`,
  `gymSeries` finished, `gymBattleResult { victory: false }`. Surrender is the normal `surrender`
  action (a lost game).
- **End of a game**: `gameOver` (the normal one); undecided → the next room, `gymSeries` `next`,
  `gymTables`. **End of the series**: `gymSeries` finished, the rewards written (one transaction),
  then `gymBattleResult`, then the table is free (`gymTables`). A finished game's room stays 2
  minutes (game-over screen), then is dropped.
- **Brock's side**: the game-core smart AI (`src/socket/ai-seat.ts`, shared with Modo Aventura). He
  never plays a Trainer whose steps the challenger answers. A step of the challenger's Trainer that
  Brock answers (Erika, Challenge!, Blaine's Quiz, Lt. Surge's Treaty, a Chaos Gym offer…) is answered
  with game-core's AI answer (Chaos Gym offers: declined) and broadcast like an action
  (`opponentAction { type: "answerTrainerChoice" }` + `gameState`). His emotes (`emote`, side
  `player2`, `userId: "gym:brock"`, 1.2 s later): battle start in the first game only, one after
  each Prize he takes, victory when he wins the series (in its last game's room).
- **Privacy (no spectators)**: gym rooms are never in `roomList` (neither "Mesas" nor "En curso"),
  `spectateRoom` answers `PRIVATE_TABLE` (the room manager refuses spectators in any server-AI room,
  whatever its config), `chatMessage` is ignored, and `joinRoom` by anyone but the challenger answers
  `ROOM_NOT_FOUND` (with or without a deck). Locked by `test/gym-battle.test.ts`. They appear in the
  backoffice `GET /api/admin/rooms` with `mode: "gym"`; closing one there (`DELETE
  /api/admin/rooms/:roomId`) ends the series without a result (entry cost back) and frees the table.
- **Persistence**: tables and series are in memory: an API restart closes every table and drops its
  series (no refund: its attempt stays used). The leaders' saved decks (`gym_leader_decks`) and the
  daily attempts (`gym_attempts`) are in the DB.

## REST

Public (no auth):
- `GET /api/gyms` → `{ leaders: [{ leaderId, name, title, avatarId, medalId, entryCost, attemptsPerDay,
  bestOf, modes: [{ mode, rules: GymRules, rewards: GymRewards }] }] }` — every leader in content,
  open or not (`entryCost` / `bestOf` are additions to the contract).

Backoffice (permission `users:economy`; superadmin always). All under `/api`; `mode` missing = "normal":
- `GET /admin/gyms` → `{ gyms: Row[] }`, **one row per leader and version**: `{ leaderId, name, title,
  avatarId, mode, modes: ["normal","expert"], status: "closed"|"open"|"closing", openedAt, closesAt,
  inBattle, current: { userId, username, roomId, startedAt, game, score } | null, schedule: { enabled,
  nextOpenAt, minGapMinutes, maxGapMinutes, openMinutes }, deck: { isDefault, updatedAt: ISO | null } }`.
- `POST /admin/gyms/:leaderId/open { mode?, minutes?: 1–1440 }` (default 45) → `{ gym: Row }`. Also
  reopens / extends a table that is open or closing.
- `POST /admin/gyms/:leaderId/close { mode? }` → `{ gym: Row }`: no new challengers; a series on ends
  normally (`closing`), an empty table is `closed` at once.
- `GET /admin/gyms/:leaderId/decks/:mode` → `{ cards: { cardId, qty }[], isDefault, updatedAt }`.
- `PUT /admin/gyms/:leaderId/decks/:mode { cards }` → same: every id must exist in game-core
  (`findCardById`), qty integer ≥ 1, exactly 60 cards (the same card twice is summed); 400 with a
  Spanish `error.message` otherwise ("Carta desconocida: …", "El mazo debe tener exactamente 60
  cartas (tiene 59)"). The challenger's rules don't apply (a Stadium in it would be a dead card: it
  can't replace the fixed one). Games that start afterwards play it.
- `DELETE /admin/gyms/:leaderId/decks/:mode` → same, back to the content default.
- Unknown leader → 404; a version it doesn't have → 404; bad `mode` / `minutes` → 400.

A saved deck that stops being valid (a card removed from game-core) is ignored (the default plays,
logged); the admin GET then shows `isDefault: true`.

## Scheduler

`src/modules/gym/gym.config.ts` `GYM_SCHEDULE` (`enabled: false`, 2–6 h gap, 45 min open, per table),
`GYM_BEST_OF` (3) and `GYM_TIMING` (turn clock 3 min, disconnect grace 2 min, emote delay 1.2 s).
Turning the scheduler on is a one-line change + API deploy (no env var).

## Deploy

Migrations `20261023120000_gym_leader_decks` (table `gym_leader_decks`) and
`20261023180000_gym_attempts` (table `gym_attempts`, FK to users with cascade), new tables only:
`npx prisma migrate deploy` on the VPS before restarting the API. No env var.

## Deck tuning

Re-run: `npx tsx scripts/gym-deck-sim.ts --games 200 --deck shipped,expert` (~2.5 min per deck;
`--deck all` runs every candidate kept in the script, `--print --deck <name>` prints a list,
`--v1-field` the pre-v2.1 field without the fixed Stadium). Smart AI vs smart AI on both seats
(`policyPair("smart")`), single games (not series) through game-core's headless runner on
`createAdventureGame` with no modifiers (`playAdventureAIGame`: 6 Prizes, 7-card hand — the gym
rooms' game creation), Pewter City Gym in play from the start (the script wraps game-core's
`createAdventureGame` export with the rooms' `withFixedStadium`), fixed seeds
(`hashSeed("gym:<opponent>:<i>")`), the leader on side A in even games and side B in odd ones, 0
engine failures.

### v2.1 (shipped)

Opponents: every game-core theme deck (classic + Gym Leaders, Brock's excluded) without Grass,
Psychic, Fighting or Brock's Pokémon, their Stadium cards swapped for their main basic Energy (the
Trainer-count and copy rules are ignored for them): raindance, thunderstorm, colorless, Misty, Lt.
Surge, Blaine — 6 decks, 200 games per pairing.

| Opponent | Normal (shipped, N3) | EXPERT (shipped, E14) |
|---|---|---|
| raindance | 63% | 86% |
| thunderstorm | 99% | 99% |
| colorless | 79% | 90% |
| gym-heroes-misty | 57% | 67% |
| gym-heroes-lt-surge | 91% | 90% |
| gym-heroes-blaine | 62% | 85% |
| **Overall (1,200 games)** | **74.8%** | **85.9%** |

Per game. A best-of-3 series amplifies it: with independent games a challenger winning 25% of the
games (normal) takes ~16% of the series, at 14% (EXPERT) ~5%. Players build better decks than the
theme decks, so these rates are an upper bound for Brock against strong players.

Normal: the v2 deck (below) with its 2 Pewter City Gym swapped for a Bill and a Professor Oak (N3;
for 2 Fighting Energy N1 73.2%, for Gust + Super Energy Removal N2 74.3% at 200 games / 75.7% at 100).
EXPERT: unchanged from v2 (it had no Stadium), still well above the normal deck.

### Normal (v1, before v2.1: no fixed Stadium, Grass / Water banned, 9 opponents)

| Opponent | Before (gym-heroes-brock) | After |
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

What changed from `gym-heroes-brock`: the same 22 Brock's Pokémon; out went Good Manners ×2, Secret
Mission, Recall, The Rocket's Trap and 6 Fighting Energy (26 → 20); in came Energy Removal ×4, Super
Energy Removal, Gust of Wind ×2, PlusPower, Bill ×2 and Professor Oak. Tried and dropped (100 games
per pairing): Diglett/Dugtrio + Mankey/Primeape (54.8%), Diglett/Dugtrio for the Sandshrew line
(49.6%), Brock's Protection for Brock (61.0%), bigger Basics (62.6%).

### EXPERT (v2, same field as v1)

| Opponent | Normal | EXPERT (E14) |
|---|---|---|
| zap | 86% | 82% |
| haymaker | 39% | 61% |
| damage-swap | 88% | 89% |
| fire-fighting | 48% | 81% |
| thunderstorm | 98% | 97% |
| colorless | 70% | 94% |
| gym-heroes-lt-surge | 77% | 83% |
| gym-heroes-sabrina | 56% | 55% |
| gym-heroes-blaine | 61% | 75% |
| **Overall (1,800 games)** | **68.9%** | **79.4%** |

The EXPERT list (21 Pokémon, 19 Trainers, 20 Energy): Brock's Rhyhorn #70 ×4, Brock's Rhyhorn #22,
Brock's Rhydon ×3, Brock's Onix #69 ×4, Brock's Lickitung, Hitmonchan (Base Set) ×4, Rocket's
Hitmonchan ×4; Brock ×2, Brock's Training Method, Energy Removal ×4, Super Energy Removal ×3, Gust of
Wind ×3, PlusPower ×2, Bill ×2, Professor Oak ×2; Fighting Energy ×18, Double Colorless Energy ×2.
Path (100 games per pairing, normal = 69.7% on those seeds): Super Energy Removal for Pewter City Gym
alone 68.0% (E1); Hitmonchan for the Sandshrew line 69.0% (E2), both 72.4% (E3); the Golem line out
for Rocket's Hitmonchan / Rhyhorn / Rhydon / Onix and a Gust 75.7% (E9); Geodude out for Onix /
Rocket's Hitmonchan 77.2% (E12; 76.1% at 200 games); Training Method ×2 out for Oak / PlusPower
(E13, 75.0%) plus 2 Double Colorless 79.1% (E14). Dropped: a hard-hitter list with Diglett / Dugtrio
(67.1%), PlusPower for Brock (71.1%), 4 Double Colorless (77.9%), a 3rd Training Method (74.7%).
