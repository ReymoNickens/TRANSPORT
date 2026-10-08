import { idParams, opsRoute } from "@/lib/api/ops";
import { publishJourney } from "@/server/journeys";

/** Copies the live fares and puts the journey on sale. */
export const POST = opsRoute({ permission: "journey.create", params: idParams }, ({ tx, params }) => publishJourney(tx, params.id));
