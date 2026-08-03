import pg from 'pg';

// count(*) returns bigint, which node-postgres hands back as a string to avoid
// precision loss. That leaks into every dashboard as {"total":"5"}, so parse it
// as a number - no count in this system approaches 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

// NUMERIC is deliberately NOT parsed. Money is numeric(12,2) in INR, and
// turning it into a float is exactly the mistake the schema avoids. Callers
// that need arithmetic should do it in SQL or with a decimal type.

/**
 * The database contract for this API.
 *
 * Row-level security is the access control for this system, not the route
 * handlers. That only works if two things are true on every single request:
 *
 *   1. The connection is NOT a superuser and NOT the table owner. Either one
 *      bypasses RLS entirely and every policy in migration 0012 becomes
 *      decoration. `assertNotBypassingRls` checks this at boot and refuses to
 *      start otherwise - a misconfigured DATABASE_URL is the single most
 *      likely way this system would silently leak the lead book.
 *
 *   2. `app.user_id` is set for the transaction. Policies read it through
 *      crm.current_user_id(). If it is not set, the connection sees nothing,
 *      which is the correct failure direction.
 *
 * So all query access goes through `withUser`, which opens a transaction, sets
 * the acting user, and hands back a querier. There is deliberately no exported
 * way to run a query outside that wrapper.
 */

export interface Querier {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
  /** Convenience: first row or null. */
  one<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<T | null>;
  /** Convenience: all rows. */
  many<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

function wrap(client: pg.PoolClient): Querier {
  return {
    query: (text, params) => client.query(text, params as unknown[]),
    async one(text, params) {
      const r = await client.query(text, params as unknown[]);
      return (r.rows[0] as never) ?? null;
    },
    async many(text, params) {
      const r = await client.query(text, params as unknown[]);
      return r.rows as never[];
    },
  };
}

export class Database {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      // A request that cannot get a connection should fail fast rather than
      // pile up behind a stuck query.
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
  }

  /**
   * Refuse to start if the configured role can see through RLS. This is a
   * boot-time check rather than a comment in a runbook because the failure it
   * prevents is silent: everything works, and every user sees every lead.
   */
  async assertNotBypassingRls(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        owns_leads: boolean;
      }>(
        `select r.rolname, r.rolsuper, r.rolbypassrls,
                pg_catalog.pg_get_userbyid(c.relowner) = current_user as owns_leads
           from pg_roles r
           join pg_class c on c.relname = 'leads'
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'crm'
          where r.rolname = current_user`,
      );
      const me = rows[0];
      if (!me) throw new Error('could not identify the current database role');

      const problems: string[] = [];
      if (me.rolsuper) problems.push('is a superuser');
      if (me.rolbypassrls) problems.push('has BYPASSRLS');
      if (me.owns_leads) problems.push('owns crm.leads');

      if (problems.length > 0) {
        throw new Error(
          `refusing to start: database role "${me.rolname}" ${problems.join(' and ')}, ` +
            'which bypasses row-level security. Connect as a role that inherits crm_app instead.',
        );
      }
    } finally {
      client.release();
    }
  }

  /**
   * Run `fn` inside a transaction with `app.user_id` set to `userId`.
   *
   * `set_config(..., true)` scopes the setting to the transaction, so a pooled
   * connection can never leak one user's identity into the next request.
   */
  async withUser<T>(userId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['app.user_id', userId]);
      const result = await fn(wrap(client));
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * For work that happens before a user is known: login, session resolution,
   * health checks. Everything reachable here is a narrow SECURITY DEFINER
   * function (see migration 0013); no table is directly readable, because
   * app.user_id is not set and every policy therefore denies.
   */
  async withoutUser<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(wrap(client));
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
