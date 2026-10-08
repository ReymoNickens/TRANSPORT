import { opsRoute } from "@/lib/api/ops";
import { listCrewCandidates } from "@/server/operations";

/** Active staff who can be put on a journey's crew. */
export const GET = opsRoute({ permission: "journey.create" }, ({ tx }) => listCrewCandidates(tx));
