import { z } from "zod";
import { requireActor } from "@/lib/auth/actor";
import { isHighRisk, requireFreshConfirmation, requirePermission, type Actor } from "@/lib/auth/permissions";
import { withOrganisation, type Tx } from "@/lib/db";
import { AppError } from "./errors";
import { apiRoute, readJson, type ApiContext } from "./handler";

type Schema = z.ZodType;
type Out<S> = S extends z.ZodType ? z.infer<S> : undefined;

export type OpsArgs<B, Q, P> = {
  tx: Tx;
  actor: Actor;
  body: B;
  query: Q;
  params: P;
  ctx: ApiContext;
  /** The reason given for a high-risk action (also written to the audit log). */
  reason: string | undefined;
};

/** Route params are uuids; anything else is simply not found. */
export const idParams = z.object({ id: z.uuid() });

/**
 * A staff business operation (spec 20.5): signed-in staff, a named
 * permission checked on the server, validated input, and one transaction
 * scoped to the actor's organisation with the actor recorded for audit.
 * A high-risk permission also needs a reason in the body and a fresh
 * second-factor confirmation (spec 5).
 */
export function opsRoute<BS extends Schema | undefined = undefined, QS extends Schema | undefined = undefined, PS extends Schema | undefined = undefined>(
  options: { permission: string; body?: BS; query?: QS; params?: PS; status?: number },
  run: (args: OpsArgs<Out<BS>, Out<QS>, Out<PS>>) => Promise<unknown>,
) {
  return apiRoute<Record<string, string>>(async (ctx, rawParams) => {
    const actor = await requireActor({ correlationId: ctx.correlationId });
    if (actor.kind !== "staff") throw new AppError("forbidden");
    requirePermission(actor, options.permission);

    let params = rawParams as Out<PS>;
    if (options.params) {
      const parsed = options.params.safeParse(rawParams ?? {});
      if (!parsed.success) throw new AppError("not_found");
      params = parsed.data as Out<PS>;
    }
    const query = (options.query
      ? options.query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams))
      : undefined) as Out<QS>;
    const body = (options.body ? await readJson(ctx.request, options.body) : undefined) as Out<BS>;
    const reason = isHighRisk(actor, options.permission)
      ? requireFreshConfirmation(actor, (body as { reason?: string } | undefined)?.reason)
      : undefined;

    const data = await withOrganisation(
      {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        correlationId: ctx.correlationId,
        sourceAddress: clientAddress(ctx.request),
        device: ctx.request.headers.get("user-agent"),
        reason,
      },
      (tx) => run({ tx, actor, body, query, params, ctx, reason }),
    );
    return { data, status: options.status };
  });
}

function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip") || null;
  // Only something that looks like an IP address goes into the inet column.
  return candidate && /^[0-9a-fA-F:.]{3,45}$/.test(candidate) ? candidate : null;
}
