-- Early forfeits and the per-opponent daily coin cap (ECONOMY.antiFarming.forfeit /
-- maxCoinsFromOpponentPerDay). Additive columns with defaults: existing rows are not early
-- forfeits and won no capped coins (the cap starts counting at deploy).

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "earlyForfeit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "player1PairCoins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "player2PairCoins" INTEGER NOT NULL DEFAULT 0;
