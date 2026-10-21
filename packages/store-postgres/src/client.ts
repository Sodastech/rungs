/**
 * The little this package needs from a PostgreSQL driver. Use `fromPg`, `fromPostgresJs` or
 * `fromPglite`, or implement it for any other driver. The drivers are not dependencies.
 */
export interface PgQueryable {
  /**
   * One statement with `$1, $2, …` parameters. `rowCount` is the number of rows a SELECT returned
   * or an INSERT, UPDATE or DELETE changed, as node-postgres reports it.
   */
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
  /** A script of several statements without parameters, such as a migration. */
  execute(script: string): Promise<void>;
}

export interface PgClient extends PgQueryable {
  /** Runs `fn` on one connection between BEGIN and COMMIT; ROLLBACK when it throws. */
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
}

interface PgResultLike {
  rows: unknown[];
  rowCount: number | null;
}

interface PgConnectionLike {
  query(text: string, params?: unknown[]): Promise<PgResultLike>;
}

/** A node-postgres `Pool` (the `pg` package), or anything shaped like it. */
export interface PgPoolLike extends PgConnectionLike {
  connect(): Promise<PgConnectionLike & { release(error?: Error | boolean): void }>;
}

function pgQueryable(connection: PgConnectionLike): PgQueryable {
  return {
    async query<R>(text: string, params: readonly unknown[] = []) {
      const result = await connection.query(text, [...params]);
      return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
    },
    async execute(script) {
      await connection.query(script);
    },
  };
}

/** Adapts a node-postgres `Pool`. */
export function fromPg(pool: PgPoolLike): PgClient {
  return {
    ...pgQueryable(pool),
    async transaction(fn) {
      const connection = await pool.connect();
      let broken = false;
      try {
        await connection.query("BEGIN");
        const result = await fn(pgQueryable(connection));
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await connection.query("ROLLBACK");
        } catch {
          broken = true;
        }
        throw error;
      } finally {
        connection.release(broken);
      }
    },
  };
}

/** What postgres.js hands a transaction callback: a `sql` that can run queries. */
export interface PostgresJsQueryLike {
  unsafe(text: string, params?: unknown[]): PromiseLike<unknown[] & { count?: number }>;
}

/** A postgres.js `sql` instance (the `postgres` package), or anything shaped like it. */
export interface PostgresJsLike extends PostgresJsQueryLike {
  begin(fn: (sql: PostgresJsQueryLike) => Promise<unknown>): PromiseLike<unknown>;
}

function postgresJsQueryable(sql: PostgresJsQueryLike): PgQueryable {
  return {
    async query<R>(text: string, params: readonly unknown[] = []) {
      const rows = await sql.unsafe(text, [...params]);
      return { rows: [...rows] as R[], rowCount: rows.count ?? rows.length };
    },
    async execute(script) {
      await sql.unsafe(script);
    },
  };
}

/** Adapts a postgres.js `sql` instance. */
export function fromPostgresJs(sql: PostgresJsLike): PgClient {
  return {
    ...postgresJsQueryable(sql),
    async transaction<T>(fn: (tx: PgQueryable) => Promise<T>) {
      return (await sql.begin((tx) => fn(postgresJsQueryable(tx)))) as T;
    },
  };
}

interface PgliteQueryableLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(script: string): Promise<unknown>;
}

/** A PGlite database (`@electric-sql/pglite`), for tests, demos and local development. */
export interface PgliteLike extends PgliteQueryableLike {
  transaction<T>(fn: (tx: PgliteQueryableLike) => Promise<T>): Promise<T>;
}

function pgliteQueryable(db: PgliteQueryableLike): PgQueryable {
  return {
    async query<R>(text: string, params: readonly unknown[] = []) {
      const result = await db.query(text, [...params]);
      // PGlite reports affectedRows 0 for a SELECT; count the rows it returned instead.
      const rowCount = Math.max(result.affectedRows ?? 0, result.rows.length);
      return { rows: result.rows as R[], rowCount };
    },
    async execute(script) {
      await db.exec(script);
    },
  };
}

/** Adapts a PGlite database. PGlite has one connection, so it suits a single process only. */
export function fromPglite(db: PgliteLike): PgClient {
  return {
    ...pgliteQueryable(db),
    transaction(fn) {
      return db.transaction((tx) => fn(pgliteQueryable(tx)));
    },
  };
}
