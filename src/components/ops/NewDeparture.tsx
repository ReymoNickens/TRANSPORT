"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis, formatDay, formatDuration, formatTime, todayInAccra } from "@/lib/format";
import { Button, Field, Notice } from "../ui";
import { BackButton, Steps } from "./Guide";

type RouteSummary = { id: string; name: string; originName: string; destinationName: string; durationMinutes: number | null; stopCount: number };
type RouteStop = { id: string; sequence: number; locationName: string; arrivalOffsetMinutes: number; departureOffsetMinutes: number; boardingAllowed: boolean; dropoffAllowed: boolean };
type Route = { id: string; name: string; durationMinutes: number | null; stops: RouteStop[] };
type Vehicle = { id: string; registration: string; fleetNumber: string | null; bookableSeats: number | null };
type FareRule = { originName: string; destinationName: string; seatType: string; amountPesewas: number };
type JourneySummary = { id: string; scheduledDepartureAt: string; state: string };

const steps = ["Route", "Date and time", "Bus", "Check and create"] as const;

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Creating a departure as a guided sequence (8.3): route, date and time, bus,
 * then a plain summary of what passengers will see before anything is saved.
 */
export function NewDeparture() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [routes, setRoutes] = useState<RouteSummary[] | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [routeId, setRouteId] = useState("");
  const [route, setRoute] = useState<Route | null>(null);
  const [fares, setFares] = useState<FareRule[] | null>(null);
  const [date, setDate] = useState(() => addDays(todayInAccra(), 1));
  const [time, setTime] = useState("07:00");
  const [vehicleId, setVehicleId] = useState("");
  const [sameDay, setSameDay] = useState<JourneySummary[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [putOnSale, setPutOnSale] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // When the guide was opened; a departure must be later than this.
  const [openedAt] = useState(() => Date.now());

  useEffect(() => {
    api<{ items: RouteSummary[] }>("/api/ops/routes?status=active&pageSize=100")
      .then((p) => setRoutes(p.items))
      .catch((e: ApiError) => setMessage(e.message));
    api<{ items: Vehicle[] }>("/api/ops/vehicles?status=active&pageSize=100")
      .then((p) => setVehicles(p.items.filter((v) => v.bookableSeats)))
      .catch(() => setVehicles([]));
  }, []);

  useEffect(() => {
    if (!routeId) return;
    let live = true;
    api<Route>(`/api/ops/routes/${routeId}`).then((r) => live && setRoute(r)).catch(() => {});
    api<{ items: { id: string }[] }>(`/api/ops/fare-tables?routeId=${routeId}&status=active`)
      .then(async (p) => {
        const table = p.items[0];
        const rules = table ? (await api<{ rules: FareRule[] }>(`/api/ops/fare-tables/${table.id}`)).rules : [];
        if (live) setFares(rules);
      })
      .catch(() => live && setFares([]));
    return () => {
      live = false;
    };
  }, [routeId]);

  useEffect(() => {
    if (!routeId || !date) return;
    let live = true;
    api<{ items: JourneySummary[] }>(`/api/ops/journeys?routeId=${routeId}&from=${date}&to=${date}&pageSize=100`)
      .then((p) => live && setSameDay(p.items.filter((j) => j.state !== "CANCELLED")))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [routeId, date]);

  const departureAt = `${date}T${time}:00Z`; // Accra keeps UTC all year.
  const departure = new Date(departureAt);
  const clash = sameDay.find((j) => Math.abs(new Date(j.scheduledDepartureAt).getTime() - departure.getTime()) <= 60 * 60_000);
  const vehicle = vehicles?.find((v) => v.id === vehicleId) ?? null;
  const inPast = departure.getTime() <= openedAt;
  const canSell = !!vehicle && !!fares?.length;

  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      const journey = await api<{ id: string }>("/api/ops/journeys", {
        method: "POST",
        body: { routeId, departureAt, vehicleId: vehicleId || null },
      });
      if (putOnSale && canSell) {
        // If this fails the departure still exists; its page shows what it needs to go on sale.
        await api(`/api/ops/journeys/${journey.id}/publish`, { method: "POST" }).catch(() => {});
      }
      router.push(`/ops/journeys/${journey.id}`);
    } catch (e) {
      setMessage(`${(e as ApiError).message} Nothing has been saved.`);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Steps steps={steps} current={step} />

      {step === 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Which route?</h2>
          {!routes ? <Notice>Loading routes…</Notice> : null}
          {routes && !routes.length ? <Notice>There are no live routes yet. Create a route first.</Notice> : null}
          <div className="flex flex-col gap-2">
            {routes?.map((r) => (
              <label key={r.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${routeId === r.id ? "border-accent" : "border-border"}`}>
                <input type="radio" name="route" value={r.id} checked={routeId === r.id} onChange={() => { setRouteId(r.id); setRoute(null); setFares(null); }} className="mt-1" />
                <span>
                  <span className="block font-medium">{r.name}</span>
                  <span className="text-sm text-muted">
                    {r.originName} → {r.destinationName} · {r.stopCount} stops{r.durationMinutes ? ` · about ${formatDuration(r.durationMinutes)}` : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <Button type="button" disabled={!routeId} onClick={() => setStep(1)}>Next: date and time</Button>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">When does it leave {route?.stops[0]?.locationName ?? "the first stop"}?</h2>
          <Field label="Date" type="date" value={date} min={todayInAccra()} onChange={(e) => setDate(e.target.value)} />
          <Field label="Departure time" type="time" value={time} onChange={(e) => setTime(e.target.value)} hint="Times are Ghana time." />
          {inPast ? <Notice tone="error">That time has already passed. Choose a later time.</Notice> : null}
          {clash ? (
            <div className="flex flex-col gap-2 rounded-xl border-2 border-danger p-3">
              <p className="font-medium">There is already a departure on this route at {formatTime(clash.scheduledDepartureAt)} that day.</p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} />
                Yes, I want two separate departures
              </label>
            </div>
          ) : null}
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(0)} />
            <Button type="button" disabled={!date || !time || inPast || (!!clash && !confirmDuplicate)} onClick={() => setStep(2)}>Next: bus</Button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Which bus?</h2>
          <Notice>You can choose the bus later, but the departure cannot go on sale without one.</Notice>
          <div className="flex flex-col gap-2">
            <label className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${vehicleId === "" ? "border-accent" : "border-border"}`}>
              <input type="radio" name="bus" checked={vehicleId === ""} onChange={() => setVehicleId("")} />
              Decide later
            </label>
            {vehicles?.map((v) => (
              <label key={v.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${vehicleId === v.id ? "border-accent" : "border-border"}`}>
                <input type="radio" name="bus" checked={vehicleId === v.id} onChange={() => setVehicleId(v.id)} />
                <span>{v.registration}{v.fleetNumber ? ` (${v.fleetNumber})` : ""} · {v.bookableSeats} seats</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(1)} />
            <Button type="button" onClick={() => setStep(3)}>Next: check</Button>
          </div>
        </section>
      ) : null}

      {step === 3 && route ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">What passengers will see</h2>
          <div className="rounded-xl border border-border p-4">
            <p className="font-semibold">{route.name}</p>
            <p className="text-muted">{formatDay(departureAt)} · {vehicle ? `${vehicle.bookableSeats} seats` : "bus not chosen yet"}</p>
            <ol className="mt-3 flex flex-col gap-1 text-sm">
              {route.stops.map((s) => {
                const at = new Date(departure.getTime() + (s.sequence === 1 ? s.departureOffsetMinutes : s.arrivalOffsetMinutes) * 60_000);
                return (
                  <li key={s.id} className="flex gap-3">
                    <span className="w-12 tabular-nums font-medium">{formatTime(at)}</span>
                    <span>
                      {s.locationName}
                      <span className="text-muted"> · {s.boardingAllowed && s.dropoffAllowed ? "get on or off" : s.boardingAllowed ? "get on" : "get off"}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="font-medium">Fares</h3>
            {fares === null ? <Notice>Loading fares…</Notice> : null}
            {fares && !fares.length ? <Notice tone="error">This route has no live fare table, so it cannot go on sale yet.</Notice> : null}
            {fares?.length ? (
              <ul className="text-sm">
                {fares.map((f, i) => (
                  <li key={i}>{f.originName} → {f.destinationName}{f.seatType !== "standard" ? ` (${f.seatType})` : ""}: <strong>{formatCedis(f.amountPesewas)}</strong></li>
                ))}
              </ul>
            ) : null}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={putOnSale && canSell} disabled={!canSell} onChange={(e) => setPutOnSale(e.target.checked)} />
            Put it on sale straight away
          </label>
          {!canSell ? <Notice>It will be saved as not on sale. Add {!vehicle ? "a bus" : "fares"} later and put it on sale from its page.</Notice> : null}
          {message ? <Notice tone="error">{message}</Notice> : null}
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(2)} />
            <Button type="button" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create departure"}</Button>
          </div>
        </section>
      ) : null}
      {step === 3 && !route ? <Notice>Loading the route…</Notice> : null}
      {step < 3 && message ? <Notice tone="error">{message}</Notice> : null}
    </div>
  );
}
