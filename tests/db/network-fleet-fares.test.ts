import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOrganisation, type Tx } from "@/lib/db";
import { createLocation, createRoute, getRoute, replaceRouteStops, setRouteStatus, updateRoute } from "@/server/network";
import { createLayout, createVehicle, createVehicleInput, getVehicle, publishLayout, replaceSeats, updateVehicle } from "@/server/fleet";
import {
  copyFareTable,
  createConcession,
  createFareTable,
  createFee,
  getFareTable,
  quoteFare,
  replaceFareRules,
  setFareTableStatus,
  updateConcession,
} from "@/server/fares";
import { connectAsApp, connectAsOwner, createOrganisation, createStaff, type Sql } from "./helpers";

let owner: Sql;
let app: Sql;
let orgA: string;
let orgB: string;
let managerA: string;
let managerB: string;

/** Runs as the app does: restricted role, organisation and actor set. */
function asManager<T>(fn: (tx: Tx) => Promise<T>, organisationId = orgA, actorUserId = managerA) {
  return withOrganisation({ organisationId, actorUserId, correlationId: "test" }, fn, app);
}

/** A business-rule refusal, from the database (BR001) or caught earlier by the service (rule_violation). */
async function expectRule(promise: Promise<unknown>, message: RegExp) {
  const error = await promise.then(
    () => null,
    (e: { code?: string; message?: string }) => e,
  );
  expect(error, "expected the operation to be refused").not.toBeNull();
  expect(["BR001", "rule_violation"]).toContain(error?.code);
  expect(error?.message).toMatch(message);
}

type Corridor = {
  accra: string;
  kasoa: string;
  winneba: string;
  capeCoast: string;
  routeId: string;
  stops: { id: string; sequence: number }[];
};

/** Accra → Kasoa → Winneba → Cape Coast, live. */
async function buildCorridor(suffix: string, activate = true): Promise<Corridor> {
  return asManager(async (tx) => {
    const loc = async (name: string, locationType: "terminal" | "station" | "stop", city: string) =>
      ((await createLocation(tx, managerA, { name: `${name} ${suffix}`, locationType, city, region: "Central", address: null, description: null }))
        .id as string);
    const accra = await loc("Accra Circle", "terminal", "Accra");
    const kasoa = await loc("Kasoa Junction", "stop", "Kasoa");
    const winneba = await loc("Winneba Station", "station", "Winneba");
    const capeCoast = await loc("Cape Coast Terminal", "terminal", "Cape Coast");

    const route = await createRoute(tx, managerA, {
      name: `Accra to Cape Coast ${suffix}`,
      originLocationId: accra,
      destinationLocationId: capeCoast,
      distanceKm: 145,
    });
    const withStops = await replaceRouteStops(tx, route.id as string, {
      stops: [
        { locationId: accra, arrivalOffsetMinutes: 0, departureOffsetMinutes: 0, boardingAllowed: true, dropoffAllowed: false },
        { locationId: kasoa, arrivalOffsetMinutes: 40, departureOffsetMinutes: 45, boardingAllowed: true, dropoffAllowed: true },
        { locationId: winneba, arrivalOffsetMinutes: 90, departureOffsetMinutes: 95, boardingAllowed: true, dropoffAllowed: true },
        { locationId: capeCoast, arrivalOffsetMinutes: 165, departureOffsetMinutes: 165, boardingAllowed: false, dropoffAllowed: true },
      ],
    });
    if (activate) await setRouteStatus(tx, route.id as string, "active");
    return {
      accra,
      kasoa,
      winneba,
      capeCoast,
      routeId: route.id as string,
      stops: withStops.stops.map((s) => ({ id: s.id as string, sequence: s.sequence as number })),
    };
  });
}

/** Every pair a passenger can travel, standard seats, 10 GHS per leg travelled. */
function fullStandardFares(stops: Corridor["stops"]) {
  const rules = [];
  for (const o of stops) {
    for (const d of stops) {
      if (d.sequence > o.sequence && o.sequence < 4 && d.sequence > 1) {
        rules.push({ originStopId: o.id, destinationStopId: d.id, seatType: "standard" as const, amountPesewas: (d.sequence - o.sequence) * 1_000 });
      }
    }
  }
  return rules;
}

beforeAll(async () => {
  owner = connectAsOwner();
  app = connectAsApp();
  orgA = await createOrganisation(owner);
  orgB = await createOrganisation(owner);
  managerA = (await createStaff(owner, orgA, "Operations Manager")).userId;
  managerB = (await createStaff(owner, orgB, "Operations Manager")).userId;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("routes and stops (spec 10.2)", () => {
  it("builds a live corridor with a duration derived from the stops", async () => {
    const corridor = await buildCorridor("r1");
    const route = await asManager((tx) => getRoute(tx, corridor.routeId));
    expect(route.status).toBe("active");
    expect(route.durationMinutes).toBe(165);
    expect(route.stops.map((s) => s.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("refuses to go live when the first stop is not the origin", async () => {
    const c = await buildCorridor("r2", false);
    await asManager((tx) =>
      replaceRouteStops(tx, c.routeId, {
        stops: [
          { locationId: c.kasoa, arrivalOffsetMinutes: 0, departureOffsetMinutes: 0, boardingAllowed: true, dropoffAllowed: false },
          { locationId: c.capeCoast, arrivalOffsetMinutes: 100, departureOffsetMinutes: 100, boardingAllowed: false, dropoffAllowed: true },
        ],
      }),
    );
    await expectRule(asManager((tx) => setRouteStatus(tx, c.routeId, "active")), /first stop must be the route's origin/);
  });

  it("refuses times that go backwards and a first stop where people get off", async () => {
    const c = await buildCorridor("r3", false);
    const stops = (backwards: boolean, firstDropoff: boolean) => ({
      stops: [
        { locationId: c.accra, arrivalOffsetMinutes: 0, departureOffsetMinutes: 0, boardingAllowed: true, dropoffAllowed: firstDropoff },
        { locationId: c.kasoa, arrivalOffsetMinutes: 60, departureOffsetMinutes: 70, boardingAllowed: true, dropoffAllowed: true },
        { locationId: c.capeCoast, arrivalOffsetMinutes: backwards ? 65 : 150, departureOffsetMinutes: 150, boardingAllowed: false, dropoffAllowed: true },
      ],
    });
    await asManager((tx) => replaceRouteStops(tx, c.routeId, stops(true, false)));
    await expectRule(asManager((tx) => setRouteStatus(tx, c.routeId, "active")), /arrival time must be at or after/);
    await asManager((tx) => replaceRouteStops(tx, c.routeId, stops(false, true)));
    await expectRule(asManager((tx) => setRouteStatus(tx, c.routeId, "active")), /only board at the first stop/);
  });

  it("freezes the stops and ends of a live route", async () => {
    const c = await buildCorridor("r4");
    await expect(
      asManager((tx) => tx`update app.route_stops set arrival_offset_minutes = 41 where route_id = ${c.routeId} and sequence = 2`),
    ).rejects.toMatchObject({ code: "BR001" });
    await expectRule(asManager((tx) => updateRoute(tx, c.routeId, { originLocationId: c.kasoa })), /cannot change/);
    // A name change is fine.
    const renamed = await asManager((tx) => updateRoute(tx, c.routeId, { name: "Coastal Express r4" }));
    expect(renamed.name).toBe("Coastal Express r4");
  });

  it("never lets one organisation use another's location", async () => {
    const c = await buildCorridor("r5");
    await expect(
      asManager(
        (tx) => createRoute(tx, managerB, { name: "Stolen", originLocationId: c.accra, destinationLocationId: c.capeCoast }),
        orgB,
        managerB,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const seen = await asManager((tx) => tx`select count(*)::int as n from app.routes`, orgB, managerB);
    expect(seen[0].n).toBe(0);
  });

  it("never deletes locations or routes", async () => {
    const c = await buildCorridor("r6");
    await expect(owner`delete from app.locations where id = ${c.kasoa}`).rejects.toThrow(/never deleted/);
    await expect(owner`delete from app.routes where id = ${c.routeId}`).rejects.toThrow(/never deleted/);
  });
});

describe("vehicles and seat layouts (spec 10.2)", () => {
  async function newVehicle(registration: string, capacity = 52) {
    // Parsed exactly as the API parses the request body.
    const input = createVehicleInput.parse({ registration, vehicleType: "coach", capacity, make: "Yutong" });
    return asManager((tx) => createVehicle(tx, managerA, input));
  }

  it("normalises the registration and builds a 2+2 layout from a pattern", async () => {
    const vehicle = await newVehicle("gr 1234 22");
    expect(vehicle.registration).toBe("GR-1234-22");
    const layout = await asManager((tx) =>
      createLayout(tx, managerA, vehicle.id as string, { name: "2+2 standard", pattern: { left: 2, right: 2, rows: 13, fullBackRow: false } }),
    );
    expect(layout).toMatchObject({ version: 1, status: "draft", rowCount: 13, columnCount: 5 });
    expect(layout.seats).toHaveLength(52);

    const published = await asManager((tx) => publishLayout(tx, layout.id as string));
    expect(published.status).toBe("published");
  });

  it("refuses a layout with more bookable seats than the vehicle's capacity", async () => {
    const vehicle = await newVehicle("GT-5000-23", 40);
    const layout = await asManager((tx) =>
      createLayout(tx, managerA, vehicle.id as string, { name: "Too many", pattern: { left: 2, right: 2, rows: 11, fullBackRow: false } }),
    );
    await expectRule(asManager((tx) => publishLayout(tx, layout.id as string)), /44 bookable seats but the vehicle's capacity is 40/);
  });

  it("freezes a published layout and versions the next one", async () => {
    const vehicle = await newVehicle("GN-7777-21");
    const v1 = await asManager((tx) =>
      createLayout(tx, managerA, vehicle.id as string, { name: "Original", pattern: { left: 2, right: 2, rows: 12, fullBackRow: true } }),
    );
    await asManager((tx) => publishLayout(tx, v1.id as string));
    await expectRule(
      asManager((tx) => replaceSeats(tx, v1.id as string, { seats: [{ seatNumber: "1A", rowNumber: 1, columnNumber: 1, seatType: "standard", bookable: true }] })),
      /only be changed while the layout is a draft/,
    );
    await expect(
      asManager((tx) => tx`update app.seats set seat_type = 'premium' where layout_id = ${v1.id as string}`),
    ).rejects.toMatchObject({ code: "BR001" });

    const v2 = await asManager((tx) =>
      createLayout(tx, managerA, vehicle.id as string, { name: "With premium row", pattern: { left: 2, right: 2, rows: 12, fullBackRow: true } }),
    );
    expect(v2.version).toBe(2);
    // Only one draft at a time.
    await expect(
      asManager((tx) => createLayout(tx, managerA, vehicle.id as string, { name: "Another", pattern: { left: 2, right: 1, rows: 10, fullBackRow: false } })),
    ).rejects.toMatchObject({ code: "23505" });

    await asManager((tx) => publishLayout(tx, v2.id as string));
    const after = await asManager((tx) => getVehicle(tx, vehicle.id as string));
    expect(after.layouts.map((l) => [l.version, l.status])).toEqual([
      [2, "published"],
      [1, "retired"],
    ]);
  });

  it("keeps a retired vehicle retired", async () => {
    const vehicle = await newVehicle("GE-1111-20");
    await asManager((tx) => updateVehicle(tx, vehicle.id as string, { status: "retired" }));
    await expectRule(asManager((tx) => updateVehicle(tx, vehicle.id as string, { status: "active" })), /cannot return to service/);
    await expect(owner`delete from app.vehicles where id = ${vehicle.id as string}`).rejects.toThrow(/never deleted/);
  });

  it("refuses a duplicate registration in the same organisation", async () => {
    await newVehicle("AS-2020-24");
    await expect(newVehicle("as 2020 24")).rejects.toMatchObject({ code: "23505" });
  });
});

describe("fare tables (spec 10.3)", () => {
  it("goes live only with a standard fare for every trip a passenger can take", async () => {
    const c = await buildCorridor("f1");
    const table = await asManager((tx) => createFareTable(tx, managerA, { routeId: c.routeId, name: "Standard 2026" }));
    const rules = fullStandardFares(c.stops);
    expect(rules).toHaveLength(6);

    await asManager((tx) => replaceFareRules(tx, table.id as string, { rules: rules.slice(1) }));
    await expectRule(asManager((tx) => setFareTableStatus(tx, table.id as string, "active")), /1 stop pairs have no standard fare/);

    await asManager((tx) => replaceFareRules(tx, table.id as string, { rules }));
    const live = await asManager((tx) => setFareTableStatus(tx, table.id as string, "active"));
    expect(live.status).toBe("active");
    expect(live.rules).toHaveLength(6);
  });

  it("refuses a fare from a later stop to an earlier one, or across routes", async () => {
    const c = await buildCorridor("f2");
    const other = await buildCorridor("f2-other");
    const table = await asManager((tx) => createFareTable(tx, managerA, { routeId: c.routeId, name: "Bad" }));
    await expectRule(
      asManager((tx) =>
        replaceFareRules(tx, table.id as string, {
          rules: [{ originStopId: c.stops[2].id, destinationStopId: c.stops[1].id, seatType: "standard", amountPesewas: 1_000 }],
        }),
      ),
      /destination stop must come after the origin/,
    );
    await expect(
      asManager((tx) =>
        replaceFareRules(tx, table.id as string, {
          rules: [{ originStopId: other.stops[0].id, destinationStopId: other.stops[3].id, seatType: "standard", amountPesewas: 1_000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("changes prices only through a copied draft, archiving the old table", async () => {
    const c = await buildCorridor("f3");
    const v1 = await asManager((tx) => createFareTable(tx, managerA, { routeId: c.routeId, name: "v1" }));
    await asManager((tx) => replaceFareRules(tx, v1.id as string, { rules: fullStandardFares(c.stops) }));
    await asManager((tx) => setFareTableStatus(tx, v1.id as string, "active"));

    await expectRule(
      asManager((tx) => replaceFareRules(tx, v1.id as string, { rules: fullStandardFares(c.stops) })),
      /only be changed while the fare table is a draft/,
    );
    await expect(
      asManager((tx) => tx`update app.fare_rules set amount_pesewas = 1 where template_id = ${v1.id as string}`),
    ).rejects.toMatchObject({ code: "BR001" });

    const v2 = await asManager((tx) => copyFareTable(tx, v1.id as string, { name: "v2" }));
    expect(v2.status).toBe("draft");
    expect(v2.rules).toHaveLength(6);
    const raised = fullStandardFares(c.stops).map((r) => ({ ...r, amountPesewas: r.amountPesewas + 500 }));
    await asManager((tx) => replaceFareRules(tx, v2.id as string, { rules: raised }));
    await asManager((tx) => setFareTableStatus(tx, v2.id as string, "active"));

    const old = await asManager((tx) => getFareTable(tx, v1.id as string));
    expect(old.status).toBe("archived");
    expect(old.rules[0].amountPesewas).toBe(1_000);
  });

  it("needs a live route before fares go live", async () => {
    const c = await buildCorridor("f4", false);
    const table = await asManager((tx) => createFareTable(tx, managerA, { routeId: c.routeId, name: "Early" }));
    await expectRule(asManager((tx) => setFareTableStatus(tx, table.id as string, "active")), /route must be live/);
  });
});

describe("price preview (spec 13.4a)", () => {
  it("prices a student seat and a standard seat with fees, exactly as checkout will", async () => {
    const c = await buildCorridor("q1");
    const table = await asManager((tx) => createFareTable(tx, managerA, { routeId: c.routeId, name: "Quote" }));
    const rules = [
      ...fullStandardFares(c.stops).map((r) => ({ ...r, amountPesewas: 8_000 })),
      { originStopId: c.stops[0].id, destinationStopId: c.stops[3].id, seatType: "premium" as const, amountPesewas: 10_000 },
    ];
    await asManager((tx) => replaceFareRules(tx, table.id as string, { rules }));

    const student = await asManager((tx) =>
      createConcession(tx, managerA, { name: "Student", code: "student_q1", discountKind: "percent", discountBasisPoints: 1_000, requiresReference: true, checkAtBoarding: true }),
    );
    await asManager((tx) =>
      createFee(tx, managerA, { name: "Booking fee", category: "booking_fee", calculation: "fixed", amountPesewas: 150, appliesTo: "online" }),
    );

    const quote = await asManager((tx) =>
      quoteFare(tx, table.id as string, {
        originStopId: c.stops[0].id,
        destinationStopId: c.stops[3].id,
        seats: [{ seatType: "standard", concessionTypeId: student.id as string }, { seatType: "premium" }],
        channel: "online",
      }),
    );
    // 8000 − 10% = 7200; premium 10000; fee 150 once per booking.
    expect(quote.subtotalPesewas).toBe(17_200);
    expect(quote.feesPesewas).toBe(150);
    expect(quote.totalPesewas).toBe(17_350);
    expect(quote.seats[0].concessionPesewas).toBe(800);

    // A station sale does not carry the online-only fee.
    const station = await asManager((tx) =>
      quoteFare(tx, table.id as string, {
        originStopId: c.stops[0].id,
        destinationStopId: c.stops[3].id,
        seats: [{ seatType: "standard" }],
        channel: "station",
      }),
    );
    expect(station.totalPesewas).toBe(8_000);
  });

  it("does not apply an archived concession", async () => {
    const c = await buildCorridor("q2");
    const table = await asManager((tx) => createFareTable(tx, managerA, { routeId: c.routeId, name: "Quote" }));
    await asManager((tx) => replaceFareRules(tx, table.id as string, { rules: fullStandardFares(c.stops) }));
    const old = await asManager((tx) =>
      createConcession(tx, managerA, { name: "Old student", code: "old_student", discountKind: "fixed", discountPesewas: 200, requiresReference: true, checkAtBoarding: true }),
    );
    await asManager((tx) => updateConcession(tx, old.id as string, { status: "archived" }));
    await expectRule(
      asManager((tx) =>
        quoteFare(tx, table.id as string, {
          originStopId: c.stops[0].id,
          destinationStopId: c.stops[1].id,
          seats: [{ seatType: "standard", concessionTypeId: old.id as string }],
          channel: "online",
        }),
      ),
      /not available/,
    );
    await expectRule(asManager((tx) => updateConcession(tx, old.id as string, { status: "active" })), /cannot be brought back/);
  });
});

describe("staff scope and audit", () => {
  it("only lets a station role point at a station or terminal", async () => {
    const c = await buildCorridor("s1");
    const agent = await createStaff(owner, orgA, "Support");
    const [role] = await owner`select id from app.roles where organisation_id = ${orgA} and name = 'Station Agent'`;
    await expect(
      owner`insert into app.user_roles (organisation_id, user_id, role_id, scope_type, scope_id)
            values (${orgA}, ${agent.userId}, ${role.id}, 'station', ${c.kasoa})`,
    ).rejects.toMatchObject({ code: "BR001" });
    await owner`insert into app.user_roles (organisation_id, user_id, role_id, scope_type, scope_id)
                values (${orgA}, ${agent.userId}, ${role.id}, 'station', ${c.winneba})`;
  });

  it("records who created a vehicle, with the correlation id", async () => {
    const vehicle = await asManager((tx) =>
      createVehicle(tx, managerA, { registration: "CR-3030-25", vehicleType: "minibus", capacity: 18, fleetNumber: "M7", name: null, make: null, model: null, notes: null }),
    );
    const [entry] = await owner`
      select actor_user_id, correlation_id from app.audit_logs
      where action = 'vehicles.insert' and entity_id = ${vehicle.id as string}`;
    expect(entry).toMatchObject({ actor_user_id: managerA, correlation_id: "test" });
  });
});
