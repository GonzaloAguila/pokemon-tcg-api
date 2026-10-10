# Prisma migrations: baseline and how to adopt it in production

Status (2026-10-10): `prisma/migrations/` exists in the repo with one baseline migration,
`20261010000000_baseline`, generated from the current `prisma/schema.prisma`:

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20261010000000_baseline/migration.sql
```

**Nothing has been applied to production.** Production was built with `prisma db push`. Its
`_prisma_migrations` table holds a single row, `0001_init` (applied 2026-02-09), from an earlier
attempt. The VPS also has an untracked `prisma/migrations/` folder from that attempt.

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

## Production procedure (run on the VPS, in this order)

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

## Day-to-day after the switch

- Schema change in development (local Docker DB `ptcg-dev-db` only):
  `npx prisma migrate dev --name <change>`, then commit the new folder under `prisma/migrations/`.
- Deploy: replace `npx prisma db push` in the deploy pipeline (frontend repo
  `.claude/skills/api-deploy/SKILL.md`) with `npx prisma migrate deploy`.
- `npm run db:push` remains fine for throwaway databases. The test suite still resets
  `ptcg_test` with `db push --force-reset`. `test/migrations.test.ts` catches a schema edit
  that has no migration.
