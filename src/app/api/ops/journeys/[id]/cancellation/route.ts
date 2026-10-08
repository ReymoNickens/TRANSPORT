import { idParams, opsRoute } from "@/lib/api/ops";
import { journeyCancellationPreview } from "@/server/cancellations";

/** What cancelling this journey would do: passengers, refund total, the message they get (15.2 step 1). */
export const GET = opsRoute({ permission: "journey.create", params: idParams }, ({ tx, params }) => journeyCancellationPreview(tx, params.id));
