# @rungsjs/store-postgres

A PostgreSQL 15+ store for [Rungs](https://www.npmjs.com/package/@rungsjs/core). Bring your own
driver: node-postgres, postgres.js or PGlite. No runtime dependencies. It ships migrations,
row locks and compare-and-set for concurrent workers, an append-only audit table, and functions
for data retention.

Rungs is `0.x`: the API can still change in minor versions, and every change is in the changelog.

## Install

```bash
npm install @rungsjs/core @rungsjs/store-postgres pg
```

## Example

```ts
export async function connect(connectionString: string): Promise<Rungs> {
  const db = fromPg(new pg.Pool({ connectionString, max: 10 })); // more than one connection
  await migrate(db); // creates or upgrades the tables; safe to run from several processes
  return createRungs({
    store: postgresStore(db),
    clock: () => new Date(),
    ids: () => crypto.randomUUID(),
  });
}
```

Use `fromPostgresJs(sql)` for postgres.js or `fromPglite(db)` for PGlite. `migrationSql()` returns
the same migrations as SQL, for your own migration tool.

## Links

- [Documentation](https://sodastech.github.io/rungs/): [PostgreSQL guide](https://sodastech.github.io/rungs/guides/postgresql/) and [data retention](https://sodastech.github.io/rungs/guides/data-retention/)
- [Edge case catalog](https://sodastech.github.io/rungs/edge-cases/): every case Rungs handles, each with a test
- [Changelog](./CHANGELOG.md)
- [Issues](https://github.com/Sodastech/rungs/issues)

## License

MIT
