# Economy v2 — frontend contract

Branch `feat/economy-v2` (API), built on `fix/alpha-xp-bets-accents`, with the production hotfix
(`fix/critical-bugs`, 2026-10-14) merged in (section 10). Source of the design: the
economy analysis of 2026-10-14 (section 4). **Not built on purpose:** dust/crafting for duplicates
("Polvo") and the "new rare" pity guarantee. Out of scope: 1st Edition / Shadowless variants, draft
prizes, tournaments, trading, level rewards, DB-backed pack config, crypto RNG for packs.

All numbers live in one module, `src/modules/economy/config.ts` (`ECONOMY`), and are served by
`GET /api/economy/config`. **Never hard-code them in the UI**: read the config (or the status /
odds endpoints).

Conventions (unchanged):

- Base URL `/api`. Auth = `Authorization: Bearer <accessToken>` (the existing `apiClient`).
- Errors: `{ "error": { "message": "<Spanish, show it as a toast>", "code": "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" | "VALIDATION_ERROR" | "UNAUTHORIZED" | "GONE" | "EMAIL_NOT_VERIFIED" | ... } }`
  with HTTP 400 / 409 / 404 / 422 / 401 / 410 / 403.
- **403 `EMAIL_NOT_VERIFIED`** (`{ "error": { "code": "EMAIL_NOT_VERIFIED", "message": "Verificá tu email para continuar" }, "code": "EMAIL_NOT_VERIFIED", "message": "..." }`):
  every economy action of a local account whose email isn't verified (section 11). Show a
  "Verificá tu email" state, not a generic error toast.
- Every reward is decided and granted by the server. The client never sends amounts, prizes,
  results or rewards (extra fields are ignored).

---

## 1. The economy day (reset rule)

- Every daily thing resets at **00:00 Argentina time (America/Argentina/Buenos_Aires) = 03:00 UTC**:
  daily pack, daily missions, daily market offers and purchases, the battle-pass step of the day,
  check-in, daily caps (match coins, XP, AI games), daily free wheel/slot stamps.
- Weeks start **Monday 00:00 Argentina** (weekly mission, Rare Candy → coins limit).
- Months (battle pass) follow the economy day: the October pass ends on Nov 1st 03:00 UTC.
- Endpoints return the next reset instants (`resetsAt`, `weekResetsAt`, ISO UTC). Show countdowns
  from those; don't compute resets in the browser's time zone.

---

## 2. What the frontend must do

1. **On every app load after auth** (session restore included): `POST /api/economy/check-in`. It is
   idempotent per economy day; the first call of the day returns what it granted (show a toast /
   modal: first-steps pack, calendar reward, battle-pass step).
2. **Home card "Sobre diario"**: `GET /api/economy/status` → `dailyPack.available`. Let the player
   pick the set (the 4 boosters) and call `POST /api/economy/daily-pack { packId }`; animate the
   returned pack like a normal pack opening.
3. **"Mis sobres" (unopened packs)**: `GET /api/economy/packs`; open with
   `POST /api/economy/packs/:id/open` (`{ packId }` when `chooseSet: true`). New accounts start
   with 4 (one per set).
4. **Missions panel**: `status.missions` (daily list + weekly). Missions complete and pay
   automatically; show `missionsCompleted` from the responses / `matchSettled` as toasts.
5. **Battle pass**: steps by activity (section 7). Remove calendar-day logic and "claim all past days"
   assumptions; a step is claimable only when `step <= enrollment.steps`.
6. **Collection milestones** (new section, e.g. in Colección or Logros): `GET /api/economy/milestones`
   + claim button.
7. **Fichas de canje**: show the balance (`profile.exchangeTokens`) and a "Canjear" flow (pick any
   card ≤ rare for 1 ficha, holo for 2) → `POST /api/economy/exchange`.
8. **Achievements**: read definitions from `GET /api/achievements` (descriptions, status, targets);
   show `retired` as such (only if claimed) and `unavailable` as "Próximamente".
9. **Odds panel** in Sobres, Ruleta and Tragamonedas: `GET /api/economy/odds`.
10. **Single player**: call `POST /api/matches/ai` when a game vs AI starts and
    `POST /api/matches/ai/:matchId/finish { result, turnNumber }` when it ends; toast the rewards.
11. **Lobby**: table bets are **off**. Hide the bet selector (the server forces 0). Keep the code
    behind `config.tableBets.enabled` / `status.tableBetsEnabled`.
12. **Unverified email** (section 11): `status.emailVerified === false` → show "Verificá tu email"
    on the daily pack, missions, battle pass, unopened packs, Fichas de canje and milestones
    instead of their actions; treat a 403 `EMAIL_NOT_VERIFIED` from any economy call the same way.
    The check-in answers 200 `emailVerified: false` with nothing granted (no toast).
13. Remove every call to `POST /api/users/me/claim-daily-coins` (now 410) and the dead
    `ECONOMY_REWARDS` constant (Victoria 100 / Login 50).
14. Market: Trainers and special Energy can now appear in the daily cards; the mystery card is
    bought by its listed id `"mystery"` (no change if you send `offer.cardDefId`).
15. Rare Candy → coins: max 2 per week; show `status.rareCandy` and the error toast.
16. Profile: new fields `exchangeTokens`, `loginDays`.
17. New cosmetics ids to add to the frontend catalogs: card backs `set-base-set`, `set-jungle`,
    `set-fossil`, `set-team-rocket` (75% milestone) and medals/titles `title-maestro-base-set`,
    `title-maestro-jungle`, `title-maestro-fossil`, `title-maestro-team-rocket`,
    `title-maestro-coleccionista` (they arrive in `profile.medals[].medalId`). The 100% holo
    variants are existing skin ids (`charizard-holo-sparkle`, `scyther-holo-sparkle`,
    `dragonite-holo-sparkle`, `dark-dragonite-holo-sparkle`).

---

## 3. Numbers (config defaults)

| Item | Value |
|---|---|
| Welcome (new accounts only) | 1.000 coins + 100 coupons + 4 unopened packs (one per set) + starter deck (existing flow) |
| Daily free pack | 1 per economy day, player picks the set |
| Primeros pasos | +1 pack (choose set) on each of the first 7 login days — only accounts created with the v2 welcome |
| Login calendar | every 7 login days (not consecutive, never resets): +1 pack + 10 coupons |
| Daily missions | Abre tu sobre diario (1) → 25 · Juega 2 partidas (IA u online) → 50 · Gana 1 partida → 50 |
| Weekly mission | complete 15 daily missions in the week → 1 pack + 1 Ficha de canje |
| Match coins | online (normal/draft) win 25 / loss 10 · vs AI win 10 / loss 5 · cap 75 per economy day |
| Counted game | turn ≥ 3 and ≥ 2 min (AI: ≥ 3 min, first 10 AI games per day); max 3 counted wins per day vs the same opponent; friendly tables never count |
| Battle pass | 1 step per login day (max 30 / month length). Free: 50 coins per step, pack at 10 and 20, unowned holo at 30. Premium (2 Rare Candies): cosmetics + 4 packs + 1.000 coins |
| Set milestones | 50% → 100 coins · 75% → 250 coins + set card back · 100% → 500 coins + title + holo variant; whole catalog → title "Maestro Coleccionista" |
| Fichas de canje | common / uncommon / rare (incl. Trainers, special Energy) = 1 · holo = 2 · basic Energy not redeemable |
| Packs | 200 coins every booster (the 5-card Base "Theme Pack" was retired) |
| Daily market cards | rare (rare ∪ holo) 150 · uncommon 50 · common 20 · mystery 100 — any card but basic Energy |
| Rare Candy | 1 → 2.000 coins (max 2 per week) or 50 coupons (no limit) |
| Table bets | off |

---

## 4. Endpoints — economy (`src/modules/economy`)

### GET /api/economy/config (public)

Returns the config as JSON (no functions). Shape (abridged):

```json
{
  "timeZone": "America/Argentina/Buenos_Aires",
  "resetHourLocal": 0,
  "weekStartsOn": "monday",
  "welcome": { "coins": 1000, "coupons": 100, "onePackPerSet": true },
  "dailyPack": { "perDay": 1 },
  "firstSteps": { "days": 7, "packsPerDay": 1 },
  "loginCalendar": { "everyDays": 7, "packs": 1, "coupons": 10 },
  "missions": {
    "daily": [{ "id": "open_daily_pack", "title": "Abre tu sobre diario", "target": 1, "rewardCoins": 25, "event": "daily_pack_opened" }, ...],
    "weekly": { "id": "weekly_missions", "title": "Completa 15 misiones esta semana", "target": 15, "rewardPacks": 1, "rewardExchangeTokens": 1 }
  },
  "matchCoins": { "online": { "win": 25, "loss": 10 }, "ai": { "win": 10, "loss": 5 }, "dailyCap": 75 },
  "antiFarming": { "minTurn": 3, "minDurationMs": 120000, "maxCountedWinsPerOpponentPerDay": 3, "aiMinDurationMs": 180000, "aiDailyCountedGames": 10 },
  "battlePass": { "maxSteps": 30, "premiumPriceRareCandy": 2, "standardCoinsPerStep": 50, "standardPackSteps": [10, 20], "premium": [{ "step": 1, "rewardType": "coins", "amount": 100, "label": "100 Monedas" }, ...] },
  "setMilestones": {
    "tiers": [{ "percent": 50, "coins": 100 }, { "percent": 75, "coins": 250, "cardBack": true }, { "percent": 100, "coins": 500, "title": true, "holoVariant": true }],
    "sets": [{ "setId": "base-set", "cardBackId": "set-base-set", "titleMedalId": "title-maestro-base-set", "holoVariantSkinId": "charizard-holo-sparkle" }, ...],
    "collectorMedalId": "title-maestro-coleccionista"
  },
  "exchangeTokens": { "costByRarity": { "common": 1, "uncommon": 1, "rare": 1, "rare-holo": 2 } },
  "market": { "cardPrices": { "rare": 150, "uncommon": 50, "common": 20, "mystery": 100 } },
  "packs": { "price": 200, "boosterIds": ["base-set-booster", "jungle-booster", "fossil-booster", "team-rocket-booster"] },
  "rareCandy": { "toCoins": 2000, "toCoupons": 50, "maxCoinConversionsPerWeek": 2 },
  "tableBets": { "enabled": false, "minOnlineGames": 20, "requireVerifiedEmail": true, "maxBetsPerDayPerOpponent": 3, "minTurnForPayout": 3 }
}
```

### GET /api/economy/status (auth)

```json
{
  "timeZone": "America/Argentina/Buenos_Aires",
  "economyDay": "2026-10-14",
  "resetsAt": "2026-10-15T03:00:00.000Z",
  "economyWeek": "2026-10-12",
  "weekResetsAt": "2026-10-19T03:00:00.000Z",
  "emailVerified": true,
  "checkIn": {
    "checkedInToday": true,
    "loginDays": 3,
    "calendar": { "everyDays": 7, "nextRewardInDays": 4, "packs": 1, "coupons": 10 },
    "firstSteps": { "eligible": true, "daysLeft": 4, "packsPerDay": 1 }
  },
  "dailyPack": { "available": false },
  "missions": {
    "day": "2026-10-14",
    "resetsAt": "2026-10-15T03:00:00.000Z",
    "daily": [
      { "id": "open_daily_pack", "title": "Abre tu sobre diario", "target": 1, "progress": 1, "completed": true, "rewardCoins": 25 },
      { "id": "play_games", "title": "Juega 2 partidas (IA u online)", "target": 2, "progress": 1, "completed": false, "rewardCoins": 50 },
      { "id": "win_game", "title": "Gana 1 partida", "target": 1, "progress": 0, "completed": false, "rewardCoins": 50 }
    ],
    "weekly": { "id": "weekly_missions", "title": "Completa 15 misiones esta semana", "week": "2026-10-12", "target": 15, "progress": 4, "completed": false, "rewardPacks": 1, "rewardExchangeTokens": 1, "resetsAt": "2026-10-19T03:00:00.000Z" }
  },
  "matchCoins": { "earnedToday": 35, "dailyCap": 75 },
  "rareCandy": { "coinConversionsThisWeek": 1, "maxCoinConversionsPerWeek": 2 },
  "exchangeTokens": 0,
  "unopenedPacks": 2,
  "tableBetsEnabled": false
}
```

`emailVerified`: false for a local account whose email isn't verified (section 11); every economy
action then answers 403 `EMAIL_NOT_VERIFIED`.
`firstSteps.daysLeft` = login days still granting a pack (0 for accounts from before v2).
`calendar.nextRewardInDays` = login days until the next calendar reward (7 right after one).

### POST /api/economy/check-in (auth, no body)

Records today's login day. Call it on app load. First call of the economy day:

```json
{
  "alreadyCheckedIn": false,
  "emailVerified": true,
  "economyDay": "2026-10-14",
  "loginDays": 7,
  "granted": {
    "firstStepsPacks": 1,
    "calendar": { "packs": 1, "coupons": 10 },
    "battlePassStep": 7
  }
}
```

Later calls the same day: `alreadyCheckedIn: true` and `granted` all zero/null. `calendar` is null
except every 7th login day; `battlePassStep` is the new step count or null (already stepped today /
month's steps exhausted). Granted packs go to the pack inventory (section "packs").

Unverified account: `{ "alreadyCheckedIn": false, "emailVerified": false, "loginDays": <unchanged>, "granted": { all zero/null } }`.
Nothing is recorded (no login day, no first-steps/calendar pack, no coupons, no battle-pass step) and
the day stays open: the first check-in after verifying the email (same day) grants it normally.

### POST /api/economy/daily-pack (auth)

Body `{ "packId": "base-set-booster" | "jungle-booster" | "fossil-booster" | "team-rocket-booster" }`.
Opens today's free pack (cards added to the collection) and also checks the user in.

```json
{
  "pack": { "packId": "jungle-booster", "packName": "Jungle Booster", "openedAt": "...", "cards": [{ "card": { "id": "jungle-010-scyther", "name": "Scyther", ... }, "slotType": "rare-holo", "isHolo": true }, ...] },
  "missionsCompleted": [{ "missionId": "open_daily_pack", "title": "Abre tu sobre diario", "kind": "daily", "rewardCoins": 25, "rewardPacks": 0, "rewardExchangeTokens": 0 }],
  "checkIn": { ...same shape as POST /check-in... }
}
```

Errors: 403 `EMAIL_NOT_VERIFIED` · 422 missing/invalid body · 400 `Sobre inválido` (not a standard booster) · 409 `Ya abriste tu sobre diario de hoy`.

### GET /api/economy/packs (auth)

Unopened packs, oldest first:

```json
{ "packs": [
  { "id": "uuid", "packId": "fossil-booster", "packName": "Fossil Booster", "chooseSet": false, "source": "welcome", "sourceLabel": "Bienvenida", "createdAt": "..." },
  { "id": "uuid", "packId": null, "packName": null, "chooseSet": true, "source": "login_calendar", "sourceLabel": "Calendario de visitas", "createdAt": "..." }
] }
```

`source`: `welcome` (Bienvenida) · `first_steps` (Primeros pasos) · `login_calendar` (Calendario de
visitas) · `weekly_mission` (Misión semanal) · `battle_pass` (Pase de batalla).

### POST /api/economy/packs/:id/open (auth)

Body `{ "packId"?: "<booster id>" }` — required when the pack has `chooseSet: true`, must match (or
be omitted) for a fixed pack. Response `{ "pack": PackOpeningResult, "unopenedPacks": 3 }`.
Errors: 403 `EMAIL_NOT_VERIFIED` · 404 `Sobre not found` (bad id / not yours) · 400 `Elige el set del sobre` · 400 `Sobre inválido`
· 400 `Este sobre es de otro set` · 409 `Este sobre ya fue abierto`.

### POST /api/economy/exchange (auth)

Body `{ "cardDefId": "base-set-071-computer-search" }`. Spends Fichas de canje (1 for common /
uncommon / rare, 2 for rare-holo; Trainers and special Energy included) and adds the card.

```json
{ "cardDefId": "base-set-071-computer-search", "cardName": "Computer Search", "cost": 1, "exchangeTokens": 0, "quantity": 2 }
```

Errors: 403 `EMAIL_NOT_VERIFIED` · 404 `Carta not found` · 400 `Esta carta no se puede canjear` (basic Energy) · 400 `No tienes
suficientes Fichas de canje`. Rare Candy can't be turned into fichas.

### GET /api/economy/milestones (auth)

```json
{
  "sets": [
    { "setId": "jungle", "setName": "Jungle", "owned": 30, "total": 48, "percent": 62,
      "tiers": [
        { "percent": 50, "cardsNeeded": 24, "reached": true, "claimed": true, "reward": { "coins": 100, "cardBackId": null, "titleMedalId": null, "skinId": null } },
        { "percent": 75, "cardsNeeded": 36, "reached": false, "claimed": false, "reward": { "coins": 250, "cardBackId": "set-jungle", "titleMedalId": null, "skinId": null } },
        { "percent": 100, "cardsNeeded": 48, "reached": false, "claimed": false, "reward": { "coins": 500, "cardBackId": null, "titleMedalId": "title-maestro-jungle", "skinId": "scyther-holo-sparkle" } }
      ] }
  ],
  "collector": { "setId": "all", "setName": "Colección completa", "owned": 120, "total": 263, "percent": 45, "tiers": [{ "percent": 100, "cardsNeeded": 263, "reached": false, "claimed": false, "reward": { "coins": 0, "cardBackId": null, "titleMedalId": "title-maestro-coleccionista", "skinId": null } }] }
}
```

A set's cards are all its registry cards (Base includes its basic Energy). Owned = distinct cards with
quantity > 0.

### POST /api/economy/milestones/claim (auth)

Body `{ "setId": "jungle" | ... | "all", "percent": 50 | 75 | 100 }` (`"all"` only with 100).
Response `{ "setId", "percent", "coins", "cardBackId", "titleMedalId", "skinId" }`.
Errors: 403 `EMAIL_NOT_VERIFIED` · 422 bad body · 404 `Hito not found` · 400 `Todavía no tienes el 75% de Jungle` · 409 `Ya reclamaste este hito`.

### GET /api/economy/odds (public)

Computed from the real generators (same slot definitions and pools).

```json
{
  "packs": [{
    "packId": "base-set-booster", "name": "Booster Pack", "setId": "base-set", "price": 200, "cardCount": 11,
    "holoChance": 0.67,
    "rarities": [
      { "rarity": "rare-holo", "cards": 16, "chancePerCard": 0.042461, "chanceAtLeastOne": 0.67, "expectedPerPack": 0.68 },
      { "rarity": "rare", "cards": 16, "chancePerCard": 0.021855, "chanceAtLeastOne": 0.344925, "expectedPerPack": 0.35 },
      { "rarity": "uncommon", ... }, { "rarity": "common", ... }, { "rarity": "basic-energy", ... }
    ],
    "cardChances": { "base-set-071-computer-search": 0.021855, ... }
  }, ...],
  "wheel": { "cost": 100, "segments": [{ "id": "card-common-1", "probability": 0.108527, "prize": "Carta Pokémon común" }, ...] },
  "slots": { "cost": 50, "patterns": [
    { "pattern": "full_grid", "probability": 0.005, "prize": "Mega jackpot: ..." },
    { "pattern": "horizontal", "probability": 0.15, "prize": "Según el símbolo de la línea", "bySymbol": [{ "symbol": "coins", "probability": 0.340909, "prize": "75, 100 o 150 monedas" }, ...] },
    ...
  ] }
}
```

Slots `vertical` (a column) is the basic line: coins, card backs and playmats pay their own prize,
but a column of `card` or `overlay` symbols pays a card back or a collectible coin (50/50), never a
card or a variant; its `bySymbol[].prize` texts say so ("…; en columna no da carta" / "…no da variante").

All probabilities are 0–1 (multiply by 100 for %). `chancePerCard` / `cardChances` = chance of at least
one copy of that card in one pack. Wheel `segments[].id` are the existing segment ids.

---

## 5. Changed endpoints

### Signup (POST /api/auth/register, Google/Discord OAuth)

- New accounts get the welcome package (section 3) instead of 2.000 coins; the welcome system
  message lists it. Existing accounts are untouched.
- `register` with `starterColor` now grants the starter deck right away (cards + active deck), same
  as `POST /api/users/me/starter` (P15). Without it, the existing starter-picker flow still applies.

### GET /api/users/me (and the login/register profile)

New fields: `exchangeTokens: number` (Fichas de canje), `loginDays: number`. New medals in
`medals[]` from milestones (ids in section 2.17).

### POST /api/users/me/claim-daily-coins — retired

Always `410 { error: { message: "Las monedas diarias se reemplazaron por el sobre diario y las misiones", code: "GONE" } }`.
`GET /api/users/me/rewards` keeps `wheelSpinAvailable` / `slotSpinAvailable` (now per economy day) and
returns `dailyCoinsAvailable: false` always.

### Battle pass (`/api/battle-pass/...`)

Same routes. `:day` in `POST /api/battle-pass/:id/claim/:day` is now the **step** (1–30).

- `GET /api/battle-pass/current` → `rewards[]` built from the config: `{ day /*step*/, track, rewardType, amount?, rewardId?, label }`.
  New `rewardType` values: `pack` (goes to the pack inventory, player picks the set) and
  `unowned_holo` (a holo the user doesn't own; any holo if they own all).
  `enrollment` gains `steps`, `maxSteps`, `steppedToday`; `currentDay` is now an alias of `steps`
  (deprecated). `daysRemaining` = days left in the economy month.
- Claim: allowed only when `step <= enrollment.steps` (400 `Todavía no llegaste a este paso: avanzas
  un paso por cada día que entras`), premium track needs premium (400), once per step+track (409 `Ya
  reclamaste esta recompensa`). Response `{ day, step, track, rewardType, label, granted }` where
  `granted` is one of `{ type: "coins", amount, newBalance }`, `{ type: "pack", amount: 1, toInventory: true }`,
  `{ type: "card", cardDefId, cardName }` (holo), `{ type: "card_back", cardBackId }`,
  `{ type: "profile_coin", coinId }`, `{ type: "avatar", avatarId }`, `{ type: "playmat", playmatId }`,
  `{ type: "card_skin", skinId }`.
- Premium still costs 2 Rare Candies (`POST /api/battle-pass/:id/upgrade`); buying it later in the
  month unlocks the premium rewards of the steps already reached.
- In months shorter than 30 days the step-30 rewards move to the month's last step.
- `GET /api/battle-pass` list items gain `steps`, `maxSteps` (`currentDay` = steps).

### Achievements

- **New** `GET /api/achievements` (auth) →
  `{ achievements: [{ id, name, description, tier, status, progressTarget, progress, claimed, claimedAt, claimable, reward: { coins, coupons } }] }`.
  `status`: `active` (works), `retired` (replaced by set milestones: `gold-30` Colección 75%,
  `legend-48` Colección Completa, `gold-35` Rica Colección, `platinum-43` Millonario — no longer
  progress or pay; show only if `claimed`), `unavailable` (30 "manual" achievements that need in-game
  tracking that doesn't exist yet → "Próximamente", not counted anywhere).
- Use the API `description`s (fixed: wins/games/streaks say "online"; "Leyenda Viviente" = claim all
  other *active* achievements, target 15 instead of 49).
- `POST /api/achievements/claim/:id` on a retired/unavailable one → 400 (`Este logro fue retirado` /
  `Este logro todavía no está disponible`), 409 if it was already claimed before.
- Win/game/streak achievements, the ranking and titles only count **counted** online games.

### Market

- `GET /api/market/daily-offers`: `cardOffers[].kind` is now `"pokemon" | "trainer" | "energy"`
  (special Energy), and `"mystery"` for the mystery card, whose `cardDefId` is the literal
  `"mystery"` (`name: "???"`, `number: 0`, `set: "unknown"`, `isMystery: true`). The "rare" offer
  comes from rare ∪ holo, so `rarity` is `"rare"` or `"rare-holo"`. Offers rotate at 00:00 Argentina.
- `POST /api/market/buy-card { cardDefId }`: send `"mystery"` for the mystery card. Response
  `{ cardDefId, name, number, set, revealed }` (`revealed: true` + the real card for the mystery).
  `purchasedToday` contains `"card:mystery"` after buying it.
- `POST /api/market/convert-candy { target: "coins" }`: max 2 per economy week → 400 `Solo puedes
  convertir 2 Caramelos Raros en monedas por semana` (the candy is not spent). Response adds
  `coinConversionsLeftThisWeek`. `target: "coupons"` unchanged and unlimited.

### Packs

- `GET /api/packs`: four boosters, all `price: 200`. `base-set-theme-pack` no longer exists (404 on open).
- No daily pack limit (the old in-memory `DAILY_PACK_LIMIT` was never enforced and is removed:
  income is bounded by the capped faucets and the weekly Rare Candy limit).

### Single player vs AI

- `POST /api/matches/ai` → `{ matchId }` (unchanged; call it when the game starts).
- `POST /api/matches/ai/:matchId/finish` body `{ result: "victory" | "defeat", turnNumber: number }`
  (**turnNumber is now required**, integer ≥ 0, the last turn the game reached). Response:

```json
{
  "matchId": "uuid", "counted": true,
  "xpGained": 50, "xpCapped": false, "levelsGained": 0, "level": 1, "experience": 50,
  "rewardCoins": 10, "rewardCoinsCapped": false, "coins": 1060,
  "missionsCompleted": [{ "missionId": "win_game", "title": "Gana 1 partida", "kind": "daily", "rewardCoins": 50, "rewardPacks": 0, "rewardExchangeTokens": 0 }],
  "emailVerified": true
}
```

`counted: false` (no XP/coins/missions) when the game lasted < 3 min, ended before turn 3 or the
user already had 10 counted AI games today. `emailVerified: false` (section 11): XP only, `rewardCoins: 0`,
no missions. Errors: 404 (not yours / unknown), 409 already reported,
422 bad body.

---

## 6. Socket events

### `createRoom` / `joinRoom`

`betAmount` is accepted but **forced to 0** while bets are off; no error. (When re-enabled:
creator and joiner need a verified email and 20 counted online games; errors `Necesitas verificar tu
email para apostar` / `Necesitas 20 partidas online para apostar`; max 3 bet tables per day against
the same opponent — beyond that the table is played without a bet; the pot is paid only if the game
reached turn 3, otherwise both stakes are refunded.)

### `matchSettled` (to each player's user room, after any game end)

```json
{
  "roomId": "...", "mode": "normal" | "draft" | "friendly",
  "betAmount": 0,
  "outcome": "win" | "loss" | "none",
  "counted": true,
  "coinsDelta": 0,
  "rewardCoins": 25, "rewardCoinsCapped": false,
  "missionsCompleted": [ ...MissionCompletion ],
  "emailVerified": true,
  "coins": 1125,
  "xpGained": 100, "xpCapped": false, "levelsGained": 0, "level": 2, "experience": 300
}
```

- `counted: false` = the game didn't pass the anti-farming rules (before turn 3, under 2 minutes,
  4th+ win vs the same opponent today, friendly, no result): no stats, ranking, achievements, XP,
  match coins or missions. Suggested copy: "Esta partida no cuenta para estadísticas ni recompensas
  (se necesita llegar al turno 3 y jugar 2 minutos)".
- A surrender during the mulligan/setup is `outcome: "win"` for the opponent but `counted: false`.
- `coinsDelta` is only the table bet (0 while bets are off); `rewardCoins` are the match coins.
- `emailVerified: false`: a counted game gave that player stats and XP but no match coins or
  missions (section 11). Suggested copy: "Verificá tu email para ganar monedas y misiones".

---

## 7. Battle pass by activity — rules

- One step per login day of the economy month (from `POST /check-in` or the daily pack), up to
  `maxSteps` (= min(30, days in month)). Missing a day doesn't lose anything already reached, but
  past days can't be made up.
- Free track: 50 coins per step; steps 10 and 20 = 1 pack (to inventory); last step = holo you don't own.
- Premium track (`config.battlePass.premium`): coins 100/50 on most steps (1.000 total), profile
  coins at 3 and 5, card backs at 10 and 13, playmats at 15 and 18, avatars at 20 and 23, packs at
  7, 14, 21 and 26, the Charizard Sepia variant at 30.
- Migration of the current month: claims made under the old calendar pass stay claimed; the user's
  `steps` starts at the highest day they had claimed (so unclaimed earlier steps become claimable
  with the new rewards).

---

## 8. Transaction types (GET /api/users/me/transactions) — suggested labels

`currency` is `coins`, `coupons`, `rareCandy` or the new `exchangeTokens`.

| type | currency | Label (es) |
|---|---|---|
| `welcome_grant` | coins, coupons | Regalo de bienvenida |
| `login_calendar` | coupons | Calendario de visitas |
| `mission_reward` | coins | Misión diaria |
| `weekly_mission_reward` | exchangeTokens | Misión semanal |
| `match_reward` | coins | Recompensa de partida |
| `set_milestone` | coins | Hito de colección |
| `exchange_redeem` | exchangeTokens (−) | Canje de ficha |
| `battle_pass_reward` | coins | Pase de batalla (existing) |
| `rare_candy_conversion` | rareCandy (−), coins / coupons | Conversión de Caramelo Raro (existing) |
| `pack_purchase` | coins (−) | Compra de sobre (existing) |
| `bet_stake` / `bet_win` / `bet_refund` | coins | Apuesta de mesa / ganada / devuelta (existing, unused while bets are off) |
| `daily_login` | coins, coupons | Recompensa diaria (old rows only; retired) |

Free packs are not currency: they are rows of the pack inventory (`source` above).

---

## 9. Anti-farming summary (what "counted" means)

A multiplayer game counts when ALL of: it has a winner, it isn't friendly, it reached turn 3, it
lasted ≥ 2 minutes since the game started, and the winner has fewer than 3 counted wins against that
opponent in the economy day. Only counted games touch `UserStats` (wins, losses, streaks → ranking,
titles, win/game/streak achievements), XP, match coins and missions. vs AI: ≥ 3 minutes, turn ≥ 3
(client-reported) and the first 10 counted AI games per day; AI games never touch stats.

---

## 10. Merged production hotfix (2026-10-14, `fix/critical-bugs`)

Already live in production; what it means on this branch:

- **Settlement**: every game end (game over, surrender, turn-timer kick, disconnect / setup
  forfeit, leaving a game in progress, draft forfeit) goes through `finishRoomGame` →
  `settleRoomResult` exactly once (`room.resultSettled`) → economy v2's `settleMatch`
  (`matchSettled`). A finished room rejects every further action (`La partida ya terminó`), so a
  second `gameOver` / settlement can't happen.
- **Rooms**: `joinRoom` on a room that no longer exists → `error { code: "ROOM_NOT_FOUND", message:
  "La partida ya no existe" }` (go back to the lobby); every game state carries `awaitingUserId`
  (the player the game waits on; only they can be kicked once the turn timer runs out); a waiting
  room whose creator left is removed after 15 s (`roomDeleted`); decks need a Basic Pokémon.
- **Achievements**: the hotfix made the Base Set collection achievements count only Base Set cards.
  Here they are retired (section 5), so that rule has nothing left to apply to: the two collection
  achievements still active (Coleccionista Novato, Coleccionista) are "de cualquier set" by
  definition and count owned cards (quantity > 0) of any set.
- **Accounts**: session revocation on password reset / change (change returns a fresh
  `accessToken`), idempotent email verification (`alreadyVerified`), Resend errors surfaced.
- **Draft**: timers, refunds of unplayed drafts, re-entry, `isAdminViewer`, `keepInCollection`
  credit (it locks the players' rows in the same order as the settlement, which runs at the same
  moment when the last game ends), validated forfeit.
- **Draft tournament**: a bye is a rest, not a win. `draft:withdraw { roomId }` (only in
  `matching`) charges `ECONOMY.draft.withdrawPenalty` (1000, or what the player has) into the
  prize pool (`draft_withdraw` transaction), every match of theirs not played is lost
  (`MatchResult.walkover`), answer `draft:withdrawn { roomId, penalty }`. The pool (entry fees +
  penalties) is split by `ECONOMY.draft.prizeSplit` and paid once at the end (`draft_prize`);
  `draft:state` carries `prizePool` and `prizes` (position, coins, withdrawn). Players have 5
  minutes to show up in a draft game; `draft:matchEnded` carries `gameRoomId`.

---

## 11. Accounts without a verified email

Local accounts (email + password) whose email isn't verified can log in, build decks and play, but
take no part in the economy. OAuth accounts (Google / Discord) count as verified.

| What | Unverified account |
|---|---|
| Welcome package | Granted at signup (in the account-creation transaction), but nothing in it can be used until the email is verified: packs can't be opened, coins/coupons can't be spent in the shop |
| `POST /economy/check-in` | 200, `emailVerified: false`, nothing granted or recorded; the day stays open |
| Daily pack, open inventory packs, Fichas de canje, set milestones claim | 403 `EMAIL_NOT_VERIFIED` |
| Battle pass claim / premium upgrade, market (cards, cosmetics, energy, Rare Candy conversion), pack purchase, wheel/slots (paid and free), deck slots, achievement claims | 403 `EMAIL_NOT_VERIFIED` |
| Counted games (online and vs AI) | Stats, ranking, XP and achievement progress as usual; no match coins and no mission progress (`emailVerified: false` in `matchSettled` / AI finish) |
| Battle-pass steps | Only come from check-ins, so none until verified |
| Table bets (when re-enabled) | Not eligible (`Necesitas verificar tu email para apostar`) |

Missions don't progress while unverified: their rewards (coins, packs, fichas) are paid
automatically on completion, so the progress itself is what is withheld.
