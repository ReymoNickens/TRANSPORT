import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import type { Tx } from "@/lib/db";

/**
 * Replacing a bus after seats are sold (spec 15.1). The database works out
 * where every passenger sits (app.vehicle_change_plan) and applies the change
 * (app.change_vehicle). The manager must see the preview first: applying needs
 * the fingerprint of the plan they saw, and is refused if it has changed since.
 */

const choice = z.union([
  z.object({ bookedSeatId: z.uuid(), seatNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/) }),
  z.object({ bookedSeatId: z.uuid(), refund: z.literal(true) }),
]);

export const vehicleChangePreviewInput = z.object({ vehicleId: z.uuid(), choices: z.array(choice).max(200).default([]) });
export const vehicleChangeInput = vehicleChangePreviewInput.extend({
  reason: z.string().trim().min(5).max(300),
  /** The fingerprint from the preview the manager confirmed (15.1 rule 5). */
  planFingerprint: z.string().length(64),
});

export type PlanRow = {
  bookedSeatId: string;
  bookingReference: string;
  passengerName: string;
  oldSeatNumber: string;
  oldSeatType: string;
  newSeatNumber: string | null;
  newSeatType: string | null;
  rule: number | null;
  /** What happens: moved by the rules, placed or refunded by the manager, or waiting for the manager. */
  outcome: "moved" | "manager_seat" | "refund" | "needs_choice";
};

export const ruleWords: Record<number, string> = {
  1: "Same seat",
  2: "Same row",
  3: "Next row",
  4: "Same window or aisle position",
  5: "Nearest seat of the same kind",
};

export async function previewVehicleChange(tx: Tx, journeyId: string, input: z.infer<typeof vehicleChangePreviewInput>) {
  const [vehicle] = await tx<{ registration: string; status: string; seats: number }[]>`
    select v.registration, v.status,
           (select count(*)::int from app.seats s join app.seat_layouts l on l.id = s.layout_id
            where l.vehicle_id = v.id and l.status = 'published' and s.bookable) as seats
    from app.vehicles v where v.id = ${input.vehicleId}`;
  if (!vehicle) throw new AppError("not_found", { message: "That bus does not exist." });

  const settled = input.choices.map((c) => c.bookedSeatId);
  const reserved = input.choices.flatMap((c) => ("seatNumber" in c ? [c.seatNumber] : []));
  const plan = await tx<{ bookedSeatId: string; bookingReference: string; passengerName: string; oldSeatNumber: string; oldSeatType: string; newSeatNumber: string | null; newSeatType: string | null; rule: number | null }[]>`
    select booked_seat_id, booking_reference, passenger_name, old_seat_number, old_seat_type, new_seat_number, new_seat_type, rule
    from app.vehicle_change_plan(${journeyId}, ${input.vehicleId}, ${settled}::uuid[], ${reserved}::text[])`;

  const rows: PlanRow[] = plan.map((p) => {
    const chosen = input.choices.find((c) => c.bookedSeatId === p.bookedSeatId);
    if (chosen && "refund" in chosen) return { ...p, newSeatNumber: null, newSeatType: null, outcome: "refund" };
    if (chosen) return { ...p, newSeatNumber: chosen.seatNumber, outcome: "manager_seat" };
    return { ...p, outcome: p.rule ? "moved" : "needs_choice" };
  });

  // Seats on the new bus no one has been given, for the manager's choices.
  const used = new Set(rows.flatMap((r) => (r.newSeatNumber ? [r.newSeatNumber] : [])));
  const free = await tx<{ seatNumber: string; seatType: string; position: string | null }[]>`
    select s.seat_number, s.seat_type, s.position from app.seats s join app.seat_layouts l on l.id = s.layout_id
    where l.vehicle_id = ${input.vehicleId} and l.status = 'published' and s.bookable
    order by s.row_number, s.column_number`;

  return {
    vehicle: { registration: vehicle.registration, inService: vehicle.status === "active", seats: vehicle.seats },
    passengers: rows.length,
    rows,
    freeSeats: free.filter((s) => !used.has(s.seatNumber)),
    needsChoice: rows.filter((r) => r.outcome === "needs_choice").length,
    planFingerprint: fingerprint(input.vehicleId, rows),
  };
}

function fingerprint(vehicleId: string, rows: PlanRow[]) {
  const stable = rows.map((r) => [r.bookedSeatId, r.newSeatNumber, r.outcome]);
  return createHash("sha256").update(JSON.stringify([vehicleId, stable])).digest("hex");
}

export async function changeVehicle(tx: Tx, journeyId: string, input: z.infer<typeof vehicleChangeInput>) {
  const preview = await previewVehicleChange(tx, journeyId, input);
  if (preview.planFingerprint !== input.planFingerprint) {
    throw new AppError("conflict", { message: "Bookings changed since you looked at the seating plan. Review the new plan, then confirm again. Nothing has been changed." });
  }
  if (preview.needsChoice) {
    throw new AppError("rule_violation", { message: `Choose a seat or a refund for the ${preview.needsChoice} passenger(s) the rules could not place.` });
  }
  const [row] = await tx<{ id: string }[]>`
    select app.change_vehicle(${journeyId}, ${input.vehicleId}, ${input.reason}, ${tx.json(input.choices)}) as id`;
  return {
    assignmentId: row.id,
    moved: preview.rows.filter((r) => r.outcome === "moved" || r.outcome === "manager_seat").length,
    refunded: preview.rows.filter((r) => r.outcome === "refund").length,
  };
}
