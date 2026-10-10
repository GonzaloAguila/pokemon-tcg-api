# API integration tests

Vitest suites that hit a real PostgreSQL, because the bugs they guard against (double spends, double claims) only show up with concurrent transactions.

```bash
# one-time: disposable Postgres on port 55432
docker run -d --name ptcg-test-db -e POSTGRES_USER=ptcg -e POSTGRES_PASSWORD=ptcg \
  -e POSTGRES_DB=ptcg_test -p 127.0.0.1:55432:5432 postgres:17-alpine

npm test            # resets the test schema (prisma db push --force-reset), then runs test/**/*.test.ts
```

Override the database with `TEST_DATABASE_URL`. The global setup refuses to reset anything that isn't on localhost.
