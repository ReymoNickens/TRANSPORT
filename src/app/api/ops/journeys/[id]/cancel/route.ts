import { idParams, opsRoute } from "@/lib/api/ops";
import { cancelJourney, cancelJourneyInput } from "@/server/journeys";

/** High-risk: needs a reason and a fresh authenticator code (spec 5). */
export const POST = opsRoute({ permission: "journey.cancel", params: idParams, body: cancelJourneyInput }, ({ tx, params, body }) =>
  cancelJourney(tx, params.id, body),
);
