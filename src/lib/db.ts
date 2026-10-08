import "server-only";
import postgres from "postgres";
import { env } from "./env";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

let client: Sql | undefined;

/**
 * The shared connection pool. Use it directly only for the few platform
 * lookups that happen before an organisation is known. Business work goes
 * through withOrganisation.
 */
export function db(): Sql {
  // prepare: false because the Supabase pooler runs in transaction mode.
  client ??= postgres(env().DATABASE_URL, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10 });
  return client;
}

export type RequestContext = {
  organisationId: string;
  /** The person acting. Omit for system work. */
  actorUserId?: string | null;
  correlationId?: string;
  /** Required for high-risk actions; written to the audit log. */
  reason?: string;
  sourceAddress?: string | null;
  device?: string | null;
};

const RETRYABLE = new Set(["40001", "40P01"]); // serialisation failure, deadlock

/**
 * Runs fn in one transaction as the restricted app_runtime role, with the
 * organisation and actor set. Row-level security then limits every query
 * to that organisation (spec 10.9, 19.3), and audit triggers record who
 * acted. Serialisation and deadlock failures retry up to three times
 * (spec 11.3a).
 */
export async function withOrganisation<T>(
  context: RequestContext,
  fn: (tx: Tx) => Promise<T>,
  sql: Sql = db(),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await sql.begin(async (tx) => {
        await tx`
          select
            set_config('app.organisation_id', ${context.organisationId}, true),
            set_config('app.actor_user_id', ${context.actorUserId ?? ""}, true),
            set_config('app.correlation_id', ${context.correlationId ?? ""}, true),
            set_config('app.reason', ${context.reason ?? ""}, true),
            set_config('app.source_address', ${context.sourceAddress ?? ""}, true),
            set_config('app.device', ${(context.device ?? "").slice(0, 200)}, true)
        `;
        await tx`set local role app_runtime`;
        return fn(tx);
      })) as T;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt < 4 && code && RETRYABLE.has(code)) continue;
      throw error;
    }
  }
}
