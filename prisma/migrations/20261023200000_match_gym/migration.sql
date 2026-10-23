-- Gym Leader games in the match history (docs/gym-leaders.md): each game of a series is a match row
-- (mode "gym", player 2 = the leader, nothing settled) with the leader, version, game and score.
-- New nullable column only.

-- AlterTable
ALTER TABLE "matches" ADD COLUMN "gym" JSONB;
