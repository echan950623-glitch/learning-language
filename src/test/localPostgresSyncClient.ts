import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Test-only bridge: execute the real migration RPCs and SELECTs in local PostgreSQL. */
export function localPostgresSyncClient(db: PGlite): SupabaseClient {
  const identifier = (name: string) => {
    if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid test SQL identifier");
    return `"${name}"`;
  };
  return {
    rpc: async (name: string, args?: { payload: unknown }) => {
      await db.exec("savepoint sync_rpc;");
      try {
        const sql = `select public.${identifier(name)}(${args ? "$1::jsonb" : ""}) as value`;
        const result = await db.query<{ value: unknown }>(sql, args ? [args.payload] : []);
        await db.exec("release savepoint sync_rpc;");
        return { data: result.rows[0].value, error: null, status: 200 };
      } catch (error) {
        await db.exec("rollback to savepoint sync_rpc; release savepoint sync_rpc;");
        return { data: null, error: { message: (error as Error).message }, status: 400 };
      }
    },
    from: (table: string) => {
      const filters: string[] = [], values: unknown[] = [], orders: string[] = [];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { values.push(value); filters.push(`${identifier(column)}=$${values.length}`); return query; },
        order: (column: string) => { orders.push(identifier(column)); return query; },
        range: async (from: number, to: number) => {
          const sql = `select * from public.${identifier(table)}${filters.length ? ` where ${filters.join(" and ")}` : ""}${orders.length ? ` order by ${orders.join(",")}` : ""} limit $${values.length + 1} offset $${values.length + 2}`;
          // PostgREST returns JSON timestamps, whereas PGlite returns Date objects.
          const rows = (await db.query(sql, [...values, to - from + 1, from])).rows;
          return { data: JSON.parse(JSON.stringify(rows)), error: null, status: 200 };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}
