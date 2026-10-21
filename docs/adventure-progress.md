# Modo Aventura — API progress (Stage 2a)

Plan: game-core `docs/superpowers/plans/2026-10-21-adventure-mode.md` (Stage 2a, Tasks 8–13). Design: same repo, `docs/superpowers/specs/2026-10-21-adventure-mode-design.md`. Branch `feat/adventure-mode`, worktree `pokemon-tcg-api-wt-adventure`. Tests run on a private DB: `TEST_DATABASE_URL=postgresql://ptcg:ptcg@127.0.0.1:55432/ptcg_test_adventure`.

Owner decisions (Task 0): architecture A; no copy limit (`rules.maxCopies: null`); every other §11 default; Metapod battle Prizes 1/1; bonus cards Pokémon Flute + Gust of Wind + PlusPower.

| Task | Status | Notes |
|---|---|---|
| 8 Content + validator | done | `content/adventures/pueblo-paleta-bosque-verde.json`; loaded at boot (`getAdventures()` in `index.ts`, read from `<repo>/content` via `__dirname`, so it ships with the repo, not `dist/`). Achievements live in the JSON (`achievements[].condition`), read by Task 13. Card checks use a local copy of `isAdventureCardAllowed` (`content/cards.ts`). |
