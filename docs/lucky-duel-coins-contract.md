# Lucky Duel: coins vs the AI and achievements (frontend contract)

Branch `feat/lucky-duel-coins` (API). Numbers live in `src/modules/economy/config.ts`
(`ECONOMY.luckyDuelAi`); the values below are the defaults.

```ts
ECONOMY.luckyDuelAi = { stake: 20, streakBonusEvery: 5, streakBonus: 200, minVictoryMs: 30_000, dailyStakedGames: 20 }
```

## 1. Lucky Duel vs the AI

The game still runs in the browser and is reported by the client. What changes: the stake is
taken when the game starts (escrow) and settled once when it is reported.

| Result reported | Coins credited back (`payout`) | Net for the game |
|---|---|---|
| `victory` | 2 × stake = 40 | +20 |
| `draw` | stake = 20 | 0 |
| `defeat` | 0 | −20 |
| not reported, and the player starts another vs-AI game (abandon) | 0 | −20 |
| `victory` reported less than 30 s after the start | stake = 20 (settled as a draw) | 0 |

- The stake settles whatever the anti-farming rules say: a Lucky Duel can end on turn 1.
- The usual vs-AI XP, match coins and missions are unchanged. They still need turn ≥ 3, 3 minutes
  and the 10 counted games per day, and are reported in the same fields as before.
- **Streak bonus:** the vs-AI streak is the number of consecutive vs-AI Lucky Duel victories. A
  defeat, a draw (quick victories included) or an abandon resets it to 0. Multiplayer games never
  change it. When a victory brings it to 5, 10, 15…, the player gets +200 coins.
- **Daily staked games:** only a user's first 20 Lucky Duel vs-AI starts of the economy day
  (00:00 Argentina = 03:00 UTC, the same day as the AI's counted-games cap) are staked. Abandoned
  games count, because they were starts. From the 21st start on, the game takes no stake: stake
  0, payout 0 and no streak bonus. If such a game reaches a multiple of 5, the bonus is simply not
  paid. The vs-AI streak and the achievements still move. The "Necesitas 20 monedas…" 400 only
  applies to a game that would be staked.
- **Accounts without a verified email** (local accounts only) play Lucky Duel vs the AI for
  nothing: stake 0, payout 0, no streak bonus, `stakedGamesLeft` 0. Their streak and
  achievements still progress.

### `POST /api/matches/ai`

Body (optional): `{ "mode": "standard" | "lucky-duel" }`. If the body or `mode` is missing, the
game is standard and nothing changes for old clients.

Before the new game is created, the user's previous unfinished vs-AI games are cleared:

- An unfinished standard game is deleted, as before.
- An unfinished Lucky Duel is settled as an **abandoned defeat**: the stake is kept and the streak
  resets. Reporting it later answers 409.

This happens whatever mode the new game uses, even when the new Lucky Duel is refused for lack of
coins.

Responses:

```jsonc
// 200, standard
{ "matchId": "uuid" }
// 200, lucky-duel. stake: already taken, 0 when unstaked (daily staked games used up / unverified);
// streak: current vs-AI streak, before this game; stakedGamesLeft: staked starts left today after this one
{ "matchId": "uuid", "luckyDuel": { "stake": 20, "streak": 3, "stakedGamesLeft": 12 } }
// 400, fewer coins than the stake (only when the game would be staked)
{ "error": { "message": "Necesitas 20 monedas para jugar Lucky Duel", "code": "BAD_REQUEST" } }
// 422, unknown mode
{ "error": { "message": "Modo de juego inválido", "code": "VALIDATION_ERROR" } }
```

### `POST /api/matches/ai/:matchId/finish`

```jsonc
{
  "result": "victory" | "defeat" | "draw",
  "turnNumber": 3,            // GameState.turnNumber when the game ended
  "mode": "lucky-duel",       // optional, IGNORED: the mode is the one sent at the start
  "luckyDuel": {              // optional; send it for every Lucky Duel (the achievements need it)
    "playerStarterId": "base-set-035-magikarp",   // catalog id of the player's drawn Basic
    "opponentStarterId": "base-set-020-electabuzz", // catalog id of the AI's drawn Basic
    "startingPlayer": "player" | "opponent"       // GameState.startingPlayer (who took turn 1)
  }
}
```

- The starter ids are the **catalog** ids (`LuckyDuelDraw.active.id` from `drawLuckyDuel`), not
  the in-game card ids: `initializeLuckyDuelGame` gives every card a random id. Keep the two draws
  when you deal the game. If the player's Basic later evolves or a Ditto transforms, still send
  the Basic that was drawn.
- Each id must be in game-core `LUCKY_DUEL_BASICS`. Otherwise the server answers 400
  `{ "error": { "message": "Pokémon de Lucky Duel inválido", "code": "BAD_REQUEST" } }` and settles
  nothing, so the client can retry with valid ids. A malformed `luckyDuel` (for example
  `startingPlayer: "rival"`) answers 422 `"Resultado inválido"`.
- Without `luckyDuel`, the stake and the streak still settle, but the game can't earn
  `lucky-first-turn`, `lucky-magikarp` or `lucky-scyther-electabuzz`.

Response: the same fields as before, plus `mode`, plus `luckyDuel` for a Lucky Duel:

```jsonc
{
  "matchId": "uuid",
  "mode": "lucky-duel",              // "standard" | "lucky-duel" (the stored mode)
  "outcome": "win" | "loss" | "draw",
  "counted": false,
  "xpGained": 0, "xpCapped": false, "levelsGained": 0, "level": 4, "experience": 1234,
  "rewardCoins": 0, "rewardCoinsCapped": false,
  "coins": 1240,                     // balance after everything (stake payout and bonus included)
  "missionsCompleted": [],
  "emailVerified": true,
  "luckyDuel": {
    "stake": 20,                     // escrowed at the start (0 = unstaked: daily staked games used up or unverified account)
    "payout": 40,                    // 40 victory / 20 draw / 0 defeat
    "streak": 5,                     // vs-AI streak after this game
    "streakBonus": 200,              // 200 when this staked victory reached a multiple of 5, else 0
    "quickVictory": false            // true: a victory reported < 30 s after the start, settled as a draw (outcome "draw")
  }
}
```

Errors are unchanged: 404 for a match that isn't the user's (`"Partida"`), and 409
`"Esta partida ya fue registrada"` for one that was already reported or abandoned. A second finish
never pays again.

### `GET /api/matches/ai/lucky-duel`

Cheap status for the play page. Requires auth.

```jsonc
{
  "stake": 20,                 // what the next game takes (0: no staked games left today, or no verified email)
  "stakedGamesLeft": 12,       // staked Lucky Duel starts left this economy day (0 for unverified accounts)
  "streakBonusEvery": 5,
  "streakBonus": 200,
  "streak": 3,                 // current vs-AI Lucky Duel streak
  "luckyDuelStreak": 3,        // current Lucky Duel streak, vs AI + multiplayer ("Suerte imparable")
  "luckyDuelBestStreak": 7     // best one (the achievement's progress)
}
```

`GET /api/economy/config` also carries `luckyDuelAi: { stake, streakBonusEvery, streakBonus, dailyStakedGames }`.

### Wallet (`transactions.type`, all `currency: "coins"`)

| type | amount | description (Spanish, shown as is) |
|---|---|---|
| `lucky_duel_stake` | −20 | `Lucky Duel: 20 monedas en juego` |
| `lucky_duel_win` | +40 | `Lucky Duel ganado: 40 monedas` |
| `lucky_duel_refund` | +20 | `Lucky Duel empatado: 20 monedas devueltas` |
| `lucky_duel_streak_bonus` | +200 | `Racha de Lucky Duel: 5 victorias seguidas (+200 monedas)` |

## 2. Multiplayer Lucky Duel tables

There are no new events and no payload changes. The server now also records, on the match row,
each seat's drawn Basic (catalog id, kept when the game is dealt), who took turn 1 and the last
turn. Every decided Lucky Duel table updates the Lucky Duel streak: the winner +1, the loser and
both players of a draw reset to 0. This includes games ended by surrender, kick or disconnect
forfeit, and games that don't count for stats (turn < 3).

These don't change the streak:

- games without a result (cancelled before the start, both players gone, a server restart);
- friendly tables, which also earn no Lucky Duel achievement.

## 3. Achievements

They are claim-based and checked by the server, like the others. They are served by
`GET /api/achievements`, progress through `POST /api/achievements/check` (the server also runs
the check after every settled multiplayer game and every `/matches/ai/:id/finish`), and are
claimed with `POST /api/achievements/claim/:id`. Rewards follow the tier: silver 500 coins, gold
800 coins + 2 coupons.

| id | name | description | tier | target | progress |
|---|---|---|---|---|---|
| `lucky-first-turn` | Primer golpe | Gana un Lucky Duel en tu primer turno | silver | 1 | number of qualifying wins |
| `lucky-streak-10` | Suerte imparable | Gana 10 Lucky Duel seguidos | gold | 10 | best Lucky Duel streak |
| `lucky-magikarp` | Magikarp campeón | Gana un Lucky Duel con Magikarp | silver | 1 | number of qualifying wins |
| `lucky-scyther-electabuzz` | Filo contra trueno | Gana un Lucky Duel con Scyther contra Electabuzz | silver | 1 | number of qualifying wins |

How the checkers work (new checker types `lucky-first-turn`, `lucky-streak` and
`lucky-win-with`):

- **Which games count:** every Lucky Duel win, vs the AI and multiplayer, counted or not
  (friendly tables excluded). A draw is not a win, and a quick victory vs the AI is a draw.
- **"Your Pokémon"** is the Basic you drew (your starting Active). Names are matched by
  containment, so owner variants count: Magikarp = `base-set-035-magikarp`,
  `team-rocket-047-magikarp`; Scyther = `jungle-010-scyther`, `gym-heroes-013-rockets-scyther`;
  Electabuzz = `base-set-020-electabuzz`, `gym-heroes-006/027-lt-surges-electabuzz`.
- **First turn:** the game ended with your victory on your first turn. That is turn 1 if you
  started, turn 2 if the rival did (game-core counts every half-turn, starting at 1). A KO in the
  Pokémon Checkup at the end of your first turn still counts (the checkup runs before the turn
  number moves on). In multiplayer, a rival who surrenders on your first turn also counts.
- **Streak:** progress is the best Lucky Duel streak across both modes. Any Lucky Duel loss, draw
  or abandon in either mode resets the current run.

**Frontend action:** `src/domain/profile/achievements.ts` (`ACHIEVEMENT_DEFINITIONS`) is the
list the profile builds from, and it must get these four entries (icon and points: silver 25,
gold 50). Its `legend-50` `progressTarget: 49` is stale. Take `progressTarget` from
`GET /api/achievements` instead.

### "Leyenda Viviente" (`legend-50`)

Its target is the number of active achievements other than itself, so it grows by 4.

- Players who already claimed it keep it: it shows claimed, and its `progress` is now reported as
  the target.
- Players who had every older achievement but hadn't claimed `legend-50` can't claim it until they
  get the four new ones (400 `"Este logro todavía no está completo"`).

## 4. Frontend checklist

1. Lucky Duel vs AI start: `POST /api/matches/ai { mode: "lucky-duel" }`. Handle the 400
   (`error.message`), and show the stake, current streak and `stakedGamesLeft` (from the
   response or `GET /api/matches/ai/lucky-duel`). When `stake` is 0, say the game is played
   for no coins.
2. Keep both `drawLuckyDuel` results. At the end, send
   `luckyDuel { playerStarterId, opponentStarterId, startingPlayer }` together with `turnNumber`.
3. Result screen: `luckyDuel.payout`, `streak` and `streakBonus`. If `quickVictory` is true,
   explain why the victory became a draw.
4. Warn that leaving or reloading a Lucky Duel and starting another game counts as a defeat.
5. Add the four achievements to `ACHIEVEMENT_DEFINITIONS`.
