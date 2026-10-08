import { opsRoute } from "@/lib/api/ops";
import { pageQuery } from "@/lib/api/pagination";
import { createOneOffJourney, listJourneys, listJourneysQuery, oneOffJourneyInput } from "@/server/journeys";

export const GET = opsRoute({ permission: "journey.create", query: pageQuery.extend(listJourneysQuery.shape) }, ({ tx, query }) =>
  listJourneys(tx, query),
);

/** A one-off journey outside any schedule. */
export const POST = opsRoute({ permission: "journey.create", body: oneOffJourneyInput, status: 201 }, ({ tx, actor, body }) =>
  createOneOffJourney(tx, actor.userId, body),
);
