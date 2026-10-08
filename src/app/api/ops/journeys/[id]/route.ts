import { idParams, opsRoute } from "@/lib/api/ops";
import { getJourney } from "@/server/journeys";

export const GET = opsRoute({ permission: "journey.create", params: idParams }, ({ tx, params }) => getJourney(tx, params.id));
