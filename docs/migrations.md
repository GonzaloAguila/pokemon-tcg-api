# Prisma migrations: baseline, production adoption and pending migrations

**Status (2026-10-14): production uses `prisma migrate deploy`.** It adopted migrations on
2026-10-13: the baseline `20261010000000_baseline` was marked applied there with
`migrate resolve --applied` (steps 1–4 below), so deploys run `npx prisma migrate deploy`,
never `db push`. The hotfix running in production since 2026-10-14 (master 9e30cd1) added no
migration, so production has exactly the baseline.

**Pending in production** (applied by `npx prisma migrate deploy` with the economy-v2 release,
after the backup of step 1; both additive):

1. `20261013000000_match_settlement`
2. `20261014000000_economy_v2`

`npx prisma migrate status` must list exactly those two as not applied before the deploy and
"Database schema is up to date!" after it.

The baseline was generated from `prisma/schema.prisma`:

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20261010000000_baseline/migration.sql
```

Later migrations (applied with `migrate deploy`):

- `20261013000000_match_settlement` (2026-10-13): `matches` gets `mode`, `roomId`, `betAmount`,
  `player1Xp`, `player2Xp`, `settledAt` and three indexes; `player1Id` becomes nullable with
  `ON DELETE SET NULL` (deleting an account no longer fails once it has matches). Additive, no
  data rewrite (nothing wrote to `matches` before this change).

- `20261014000000_economy_v2` (2026-10-14): `users.exchangeTokens`, `users.loginDays`;
  `matches.counted`, `player1Coins`, `player2Coins`; `user_battle_passes.steps`, `lastStepDay`;
  new tables `economy_claims`, `user_packs`, `user_missions`. All additive with defaults. One data
  statement: `user_battle_passes.steps` = highest day already claimed (max 30), so the battle pass
  switches from calendar to activity without taking anything away.

History: production was built with `prisma db push`. Before the adoption its
`_prisma_migrations` table held a single row, `0001_init` (applied 2026-02-09), from an earlier
attempt, and the VPS had an untracked `prisma/migrations/` folder from that attempt. The
procedure below is how it was adopted (kept for reference and for rebuilding a database that was
created with `db push`).

`test/migrations.test.ts` replays `prisma/migrations` into a shadow database in the Docker test
container and fails if the result differs from `schema.prisma`. After the switch, every schema
edit needs a migration (see "Day-to-day" below).

## What was verified locally (Docker test DB only)

On throwaway databases inside `ptcg-test-db`:

1. Applying the baseline to an empty database gives exactly `schema.prisma`
   (`migrate diff --from-url ... --to-schema-datamodel ...` printed "No difference detected").
2. A production lookalike, built with `db push` plus a `_prisma_migrations` row `0001_init`:
   - `migrate status` lists `20261010000000_baseline` as not applied and `0001_init` as missing locally.
   - **Running `migrate deploy` without resolving first fails** with `P3018` /
     `type "UserRole" already exists`. It leaves a *failed* `20261010000000_baseline` row that blocks
     every later deploy until it is resolved. Data is untouched, because the first statement fails.
     Fix: `npx prisma migrate resolve --applied 20261010000000_baseline`.
   - The intended path is `migrate resolve --applied 20261010000000_baseline` first, then
     `migrate deploy`. It reports "No pending migrations to apply" and `migrate status` reports
     "Database schema is up to date!". This works with the old `0001_init` row still there.
   - A follow-up migration (`ALTER TABLE ... ADD COLUMN`) then applied cleanly with `migrate deploy`.

## Adoption procedure (done in production on 2026-10-13; run on the VPS, in this order)

All commands run from `/var/www/pokemon-tcg-api`. Load the env first:

```bash
cd /var/www/pokemon-tcg-api
set -a; source .env; set +a
```

### 1. Back up first

```bash
mkdir -p ~/backups
pg_dump "$DATABASE_URL" -Fc -f ~/backups/pokemontcg-$(date +%F-%H%M).dump
# Separate copy of the migrations table, which is the only thing this procedure changes
psql "$DATABASE_URL" -c "\copy _prisma_migrations TO '$HOME/backups/_prisma_migrations-$(date +%F).csv' CSV HEADER"
ls -lh ~/backups
```

To restore the full dump if needed: `pg_restore --clean --if-exists -d "$DATABASE_URL" ~/backups/<file>.dump`.

### 2. Move the VPS's untracked migrations folder aside

If you skip this, `git pull` will refuse to overwrite the untracked
`prisma/migrations/migration_lock.toml`, or the old folder will mix with the repo's.

```bash
ls -la prisma/migrations            # inspect it once
mv prisma/migrations ~/backups/prisma-migrations-vps-$(date +%F)
git pull                            # brings prisma/migrations/20261010000000_baseline
npm ci && npx prisma generate
```

### 3. Check for drift between production and the repo schema

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
```

- Output `-- This is an empty migration.` means production matches the baseline. Continue to step 4.
- Any SQL means production differs from `schema.prisma`, for example the waitlist table that once
  had to be created by hand, or a column added outside Prisma. **Stop. Don't mark the baseline as applied.**
  Bring production in line first. Usually that means applying the printed SQL after reviewing it
  (`npx prisma db execute --url "$DATABASE_URL" --file <reviewed.sql>`). Re-run the diff until
  it's empty. If the difference is something that should stay, change `schema.prisma` and
  regenerate the baseline in the repo instead.

### 4. Mark the baseline as applied (no SQL runs)

```bash
npx prisma migrate resolve --applied 20261010000000_baseline
npx prisma migrate status           # expect: "Database schema is up to date!"
npx prisma migrate deploy           # expect: "No pending migrations to apply."
```

### 5. The old `0001_init` row

Prisma tolerates it once the baseline is resolved (verified above), so you can leave it.
To tidy up later, after the backup in step 1:

```bash
psql "$DATABASE_URL" -c "DELETE FROM _prisma_migrations WHERE migration_name = '0001_init';"
```

Don't delete it *instead of* resolving the baseline. Without the baseline row, `migrate deploy`
tries to create every table again and fails with P3018, as above.

### If something goes wrong

- `P3018` on `20261010000000_baseline`: someone ran `migrate deploy` before step 4. Run
  `npx prisma migrate resolve --applied 20261010000000_baseline`, then `migrate status`.
- Never run `prisma migrate dev` or `prisma migrate reset` against production. They can drop data.
- Last resort: restore the step 1 dump.

## Day-to-day (since the switch)

- Schema change in development (local Docker DB `ptcg-dev-db` only):
  `npx prisma migrate dev --name <change>`, then commit the new folder under `prisma/migrations/`.
- Deploy: `npx prisma migrate deploy` after `npm ci` and before the PM2 reload (frontend repo
  `.claude/skills/api-deploy/SKILL.md`; if that skill still says `db push`, it is stale). Back up
  first (step 1) whenever a deploy brings migrations.
- `npm run db:push` remains fine for throwaway databases. The test suite still resets
  `ptcg_test` with `db push --force-reset`. `test/migrations.test.ts` catches a schema edit
  that has no migration.
- Partial indexes (`CREATE UNIQUE INDEX … WHERE …`) can't be declared in `schema.prisma`: write
  them by hand at the end of the migration (Prisma's diff ignores them, so `migrations.test.ts`
  stays green). `db push` doesn't create them, so `test/global-setup.ts` runs every such statement
  found in `prisma/migrations` after resetting the test database.
- When the local dev DB was built with `db push` (no `_prisma_migrations` rows), `migrate dev`
  wants to reset it. Generate the SQL without touching it instead:
  `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <throwaway db> --script > prisma/migrations/<ts>_<name>/migration.sql`.

`20261021000000_adventure_mode` (2026-10-21, branch feat/adventure-mode): new tables
`adventure_runs`, `adventure_battle_results`, `adventure_progress`, `user_starter_unlocks` (FKs
to `users` / `adventure_runs`, `ON DELETE CASCADE`) and the partial unique index
`adventure_runs_one_active` (one `active` run per user). Additive only.
