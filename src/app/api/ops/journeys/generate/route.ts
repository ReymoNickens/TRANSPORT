import { opsRoute } from "@/lib/api/ops";
import { generateInput, generateNow } from "@/server/journeys";

/** Generates journeys now instead of waiting for the nightly run. Safe to repeat. */
export const POST = opsRoute({ permission: "journey.create", body: generateInput }, ({ tx, body }) => generateNow(tx, body));
