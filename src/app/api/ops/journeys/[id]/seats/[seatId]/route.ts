import { z } from "zod";
import { opsRoute } from "@/lib/api/ops";
import { seatStateInput, setSeatState } from "@/server/journeys";

/** Blocks or unblocks one seat on a journey. */
export const PATCH = opsRoute(
  { permission: "vehicle.assign", params: z.object({ id: z.uuid(), seatId: z.uuid() }), body: seatStateInput },
  ({ tx, params, body }) => setSeatState(tx, params.id, params.seatId, body),
);
