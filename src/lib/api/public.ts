import "server-only";
import type { z } from "zod";
import { currentIdentity, loadActor } from "@/lib/auth/actor";
import { withOrganisation, type Tx } from "@/lib/db";
import { currentOrganisation } from "@/lib/organisation";
import { AppError } from "./errors";
import { clientAddress } from "./client-address";
import { apiRoute, readJson, type ApiContext } from "./handler";

type Schema = z.ZodType;
type Out<S> = S extends z.ZodType ? z.infer<S> : undefined;

export type PublicArgs<B, Q, P> = {
  tx: Tx;
  ctx: ApiContext;
  organisationId: string;
  /** The signed-in passenger or staff member, if any. */
  userId: string | null;
  address: string | null;
  body: B;
  query: Q;
  params: P;
};

/**
 * An endpoint passengers can use without signing in (search, holds, guest
 * bookings). It still runs as the restricted role within the deployment's
 * organisation, and every business rule is enforced on the server.
 */
export function publicRoute<BS extends Schema | undefined = undefined, QS extends Schema | undefined = undefined, PS extends Schema | undefined = undefined>(
  options: { body?: BS; query?: QS; params?: PS; status?: number },
  run: (args: PublicArgs<Out<BS>, Out<QS>, Out<PS>>) => Promise<unknown>,
) {
  return apiRoute<Record<string, string>>(async (ctx, rawParams) => {
    let params = rawParams as Out<PS>;
    if (options.params) {
      const parsed = options.params.safeParse(rawParams ?? {});
      if (!parsed.success) throw new AppError("not_found");
      params = parsed.data as Out<PS>;
    }
    const query = (options.query ? options.query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)) : undefined) as Out<QS>;
    const body = (options.body ? await readJson(ctx.request, options.body) : undefined) as Out<BS>;
    const organisation = await currentOrganisation();
    const identity = await currentIdentity().catch(() => null);
    const address = clientAddress(ctx.request);

    const data = await withOrganisation({ organisationId: organisation.id, correlationId: ctx.correlationId, sourceAddress: address }, async (tx) => {
      const actor = identity ? await loadActor(tx, organisation.id, identity) : null;
      return run({ tx, ctx, organisationId: organisation.id, userId: actor?.userId ?? null, address, body, query, params });
    });
    return { data, status: options.status };
  });
}

