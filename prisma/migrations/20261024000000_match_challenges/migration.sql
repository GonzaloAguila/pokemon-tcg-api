-- Challenge achievements (frontend docs/superpowers/specs/2026-10-23-challenge-achievements-design.md):
-- each multiplayer game keeps both decks as played, how it ended and what each seat did.
-- New nullable columns only.

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "endKind" TEXT,
ADD COLUMN     "feats" JSONB,
ADD COLUMN     "player1Deck" JSONB,
ADD COLUMN     "player2Deck" JSONB;
