import { apiRoute } from "@/lib/api/handler";
import { requireActor } from "@/lib/auth/actor";

/** The signed-in person and what they may do. The apps use it to shape navigation only; the server re-checks every action. */
export const GET = apiRoute(async ({ correlationId }) => {
  const actor = await requireActor({ correlationId });
  return {
    data: {
      kind: actor.kind,
      permissions: [...new Set(actor.grants.map((grant) => grant.code))].sort(),
      secondFactorRequired: actor.secondFactorRequired,
      assuranceLevel: actor.assuranceLevel,
    },
  };
});
