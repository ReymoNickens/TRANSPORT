import { withOrganisation, type Tx } from "@/lib/db";
import { createLayout, createVehicle, createVehicleInput, publishLayout } from "@/server/fleet";
import { createFareTable, replaceFareRules, setFareTableStatus } from "@/server/fares";
import { createLocation, createRoute, replaceRouteStops, setRouteStatus } from "@/server/network";
import type { Sql } from "./helpers";

export type Operator = { app: Sql; organisationId: string; actorUserId: string };

/** Runs as the app does: restricted role, organisation and actor set. */
export function as<T>(op: Operator, fn: (tx: Tx) => Promise<T>, reason?: string) {
  return withOrganisation({ organisationId: op.organisationId, actorUserId: op.actorUserId, correlationId: "test", reason }, fn, op.app);
}

/** Accra → Kasoa → Cape Coast, live, 165 minutes, with a live standard fare table. */
export async function liveCorridor(op: Operator, suffix: string) {
  return as(op, async (tx) => {
    const loc = async (name: string, locationType: "terminal" | "stop", city: string) =>
      (await createLocation(tx, op.actorUserId, { name: `${name} ${suffix}`, locationType, city, region: "Central", address: null, description: null })).id;
    const accra = await loc("Accra", "terminal", "Accra");
    const kasoa = await loc("Kasoa", "stop", "Kasoa");
    const capeCoast = await loc("Cape Coast", "terminal", "Cape Coast");
    const route = await createRoute(tx, op.actorUserId, { name: `Corridor ${suffix}`, originLocationId: accra, destinationLocationId: capeCoast });
    const { stops } = await replaceRouteStops(tx, route.id, {
      stops: [
        { locationId: accra, arrivalOffsetMinutes: 0, departureOffsetMinutes: 0, boardingAllowed: true, dropoffAllowed: false },
        { locationId: kasoa, arrivalOffsetMinutes: 45, departureOffsetMinutes: 50, boardingAllowed: true, dropoffAllowed: true },
        { locationId: capeCoast, arrivalOffsetMinutes: 165, departureOffsetMinutes: 165, boardingAllowed: false, dropoffAllowed: true },
      ],
    });
    await setRouteStatus(tx, route.id, "active");
    const table = await createFareTable(tx, op.actorUserId, { routeId: route.id, name: `Fares ${suffix}` });
    await replaceFareRules(tx, table.id, {
      rules: [
        { originStopId: stops[0].id, destinationStopId: stops[1].id, seatType: "standard", amountPesewas: 3_000 },
        { originStopId: stops[0].id, destinationStopId: stops[2].id, seatType: "standard", amountPesewas: 8_000 },
        { originStopId: stops[1].id, destinationStopId: stops[2].id, seatType: "standard", amountPesewas: 6_000 },
      ],
    });
    await setFareTableStatus(tx, table.id, "active");
    return { routeId: route.id, stops, fareTableId: table.id, locations: { accra, kasoa, capeCoast } };
  });
}

/** An active 2+2 coach with a published 52-seat layout. */
export async function coach(op: Operator, registration: string) {
  return as(op, async (tx) => {
    const vehicle = await createVehicle(tx, op.actorUserId, createVehicleInput.parse({ registration, vehicleType: "coach", capacity: 52 }));
    const layout = await createLayout(tx, op.actorUserId, vehicle.id, { name: "2+2", pattern: { left: 2, right: 2, rows: 13, fullBackRow: false } });
    await publishLayout(tx, layout.id);
    return { vehicleId: vehicle.id, layoutId: layout.id };
  });
}

/** A date n days from today, as YYYY-MM-DD (Accra is UTC). */
export function daysFromToday(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO day of week (1 = Monday) of a YYYY-MM-DD date. */
export function isoDay(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
