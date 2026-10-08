"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { parseCedis } from "@/domain/money";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis, formatDuration } from "@/lib/format";
import { Button, Field, Notice, Select } from "../ui";
import { BackButton, Steps } from "./Guide";

type Place = { id: string; name: string; city: string };
type Stop = { locationId: string; travelMinutes: string; stopMinutes: string; boarding: boolean; dropoff: boolean };
type Pair = { from: number; to: number };

const steps = ["Stops", "Times", "Getting on and off", "Fares", "Check and save"] as const;

const minutes = (v: string) => (/^\d{1,4}$/.test(v.trim()) ? Number(v) : null);

/** Arrival and departure offsets from the first departure, from the times between stops. */
export function stopOffsets(stops: Stop[]) {
  let clock = 0;
  return stops.map((s, i) => {
    if (i === 0) return { arrival: 0, departure: 0 };
    const arrival = clock + (minutes(s.travelMinutes) ?? 0);
    const departure = i === stops.length - 1 ? arrival : arrival + (minutes(s.stopMinutes) ?? 0);
    clock = departure;
    return { arrival, departure };
  });
}

/**
 * Creating a route as a guided sequence (8.3): stops in order, then times
 * between stops, then who may get on and off, then fares, then a plain summary.
 * Saving makes the route and its fares live together.
 */
export function NewRoute() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");
  const [distance, setDistance] = useState("");
  const [fares, setFares] = useState<Record<string, string>>({});
  const [premium, setPremium] = useState(false);
  const [premiumFares, setPremiumFares] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newPlace, setNewPlace] = useState<{ name: string; city: string; region: string; locationType: "terminal" | "station" | "stop" } | null>(null);

  useEffect(() => {
    api<{ items: Place[] }>("/api/ops/locations?status=active&pageSize=100")
      .then((p) => setPlaces(p.items))
      .catch((e: ApiError) => setMessage(e.message));
  }, []);

  const placeName = (id: string) => places?.find((p) => p.id === id)?.name ?? "";
  const suggestedName = stops.length >= 2 ? `${placeName(stops[0].locationId).split(",")[0]} to ${placeName(stops[stops.length - 1].locationId).split(",")[0]}` : "";
  const offsets = useMemo(() => stopOffsets(stops), [stops]);
  // First stop: get on only. Last stop: get off only (route stop rules).
  const rules = stops.map((s, i) => ({ boarding: i === stops.length - 1 ? false : i === 0 ? true : s.boarding, dropoff: i === 0 ? false : i === stops.length - 1 ? true : s.dropoff }));
  const pairs: Pair[] = [];
  stops.forEach((_, from) => stops.forEach((__, to) => { if (from < to && rules[from].boarding && rules[to].dropoff) pairs.push({ from, to }); }));
  const key = (p: Pair) => `${p.from}-${p.to}`;

  const timesOk = stops.every((s, i) => i === 0 || (minutes(s.travelMinutes) !== null && minutes(s.travelMinutes)! > 0 && (i === stops.length - 1 || minutes(s.stopMinutes) !== null)));
  const onOffOk = rules.slice(1, -1).every((r) => r.boarding || r.dropoff);
  const faresOk = pairs.length > 0 && pairs.every((p) => parseCedis(fares[key(p)] ?? "") && (!premium || parseCedis(premiumFares[key(p)] ?? "")));

  function update(i: number, patch: Partial<Stop>) {
    setStops((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }
  function move(i: number, by: -1 | 1) {
    setStops((all) => {
      const next = [...all];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });
  }

  async function addPlace() {
    if (!newPlace) return;
    setMessage(null);
    try {
      const place = await api<Place>("/api/ops/locations", { method: "POST", body: { ...newPlace, address: null, description: null } });
      setPlaces((p) => [...(p ?? []), place].sort((a, b) => a.name.localeCompare(b.name)));
      setStops((s) => [...s, { locationId: place.id, travelMinutes: "", stopMinutes: "5", boarding: true, dropoff: true }]);
      setNewPlace(null);
    } catch (e) {
      setMessage((e as ApiError).message);
    }
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    let routeId: string | null = null;
    try {
      const route = await api<{ id: string }>("/api/ops/routes", {
        method: "POST",
        body: {
          name: name.trim() || suggestedName,
          originLocationId: stops[0].locationId,
          destinationLocationId: stops[stops.length - 1].locationId,
          distanceKm: distance ? Number(distance) : null,
        },
      });
      routeId = route.id;
      const saved = await api<{ stops: { id: string }[] }>(`/api/ops/routes/${route.id}/stops`, {
        method: "PUT",
        body: {
          stops: stops.map((s, i) => ({
            locationId: s.locationId,
            arrivalOffsetMinutes: offsets[i].arrival,
            departureOffsetMinutes: offsets[i].departure,
            boardingAllowed: rules[i].boarding,
            dropoffAllowed: rules[i].dropoff,
          })),
        },
      });
      await api(`/api/ops/routes/${route.id}/activate`, { method: "POST" });
      const table = await api<{ id: string }>("/api/ops/fare-tables", { method: "POST", body: { routeId: route.id, name: `Fares from ${new Date().toISOString().slice(0, 10)}` } });
      const fareRules = pairs.flatMap((p) => [
        { originStopId: saved.stops[p.from].id, destinationStopId: saved.stops[p.to].id, seatType: "standard", amountPesewas: parseCedis(fares[key(p)])! },
        ...(premium ? [{ originStopId: saved.stops[p.from].id, destinationStopId: saved.stops[p.to].id, seatType: "premium", amountPesewas: parseCedis(premiumFares[key(p)])! }] : []),
      ]);
      await api(`/api/ops/fare-tables/${table.id}/rules`, { method: "PUT", body: { rules: fareRules } });
      await api(`/api/ops/fare-tables/${table.id}/activate`, { method: "POST" });
      router.push(`/ops/routes/${route.id}`);
    } catch (e) {
      const text = (e as ApiError).message;
      if (routeId) {
        // The route exists; its page shows what is still missing.
        setMessage(`${text} The route was saved but is not fully set up. Opening it so you can finish.`);
        setTimeout(() => router.push(`/ops/routes/${routeId}`), 2500);
      } else {
        setMessage(`${text} Nothing has been saved.`);
        setBusy(false);
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Steps steps={steps} current={step} />

      {step === 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Stops, in the order the bus calls at them</h2>
          {stops.length ? (
            <ol className="flex flex-col gap-2">
              {stops.map((s, i) => (
                <li key={`${s.locationId}-${i}`} className="flex items-center gap-2 rounded-xl border border-border p-2">
                  <span className="w-6 text-center font-semibold">{i + 1}</span>
                  <span className="flex-1">{placeName(s.locationId)}</span>
                  <SmallIcon label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</SmallIcon>
                  <SmallIcon label="Move down" disabled={i === stops.length - 1} onClick={() => move(i, 1)}>↓</SmallIcon>
                  <SmallIcon label="Remove" onClick={() => setStops((all) => all.filter((_, j) => j !== i))}>✕</SmallIcon>
                </li>
              ))}
            </ol>
          ) : (
            <Notice>Start with the place the bus leaves from.</Notice>
          )}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Select label={stops.length ? "Add the next stop" : "First stop"} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose a place…</option>
                {places?.filter((p) => !stops.some((s) => s.locationId === p.id)).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
            <button
              type="button"
              className="h-12 rounded-lg border border-border px-4 font-medium disabled:opacity-60"
              disabled={!pick}
              onClick={() => {
                setStops((s) => [...s, { locationId: pick, travelMinutes: "", stopMinutes: "5", boarding: true, dropoff: true }]);
                setPick("");
              }}
            >
              Add
            </button>
          </div>
          {newPlace ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
              <h3 className="font-medium">A new place</h3>
              <Field label="Name passengers will see" placeholder="Kasoa Junction" value={newPlace.name} onChange={(e) => setNewPlace({ ...newPlace, name: e.target.value })} />
              <Field label="Town or city" value={newPlace.city} onChange={(e) => setNewPlace({ ...newPlace, city: e.target.value })} />
              <Field label="Region" placeholder="Central" value={newPlace.region} onChange={(e) => setNewPlace({ ...newPlace, region: e.target.value })} />
              <Select label="Kind of place" value={newPlace.locationType} onChange={(e) => setNewPlace({ ...newPlace, locationType: e.target.value as "terminal" | "station" | "stop" })}>
                <option value="terminal">Terminal (start or end of routes)</option>
                <option value="station">Station (with a desk)</option>
                <option value="stop">Roadside stop</option>
              </Select>
              <div className="flex gap-2">
                <BackButton onClick={() => setNewPlace(null)} />
                <Button type="button" onClick={addPlace} disabled={newPlace.name.trim().length < 2 || newPlace.city.trim().length < 2 || newPlace.region.trim().length < 2}>Add this place</Button>
              </div>
            </div>
          ) : (
            <button type="button" className="self-start text-sm underline" onClick={() => setNewPlace({ name: "", city: "", region: "", locationType: "stop" })}>
              The place is not in the list
            </button>
          )}
          {message ? <Notice tone="error">{message}</Notice> : null}
          <Button type="button" disabled={stops.length < 2} onClick={() => setStep(1)}>Next: times</Button>
          {stops.length === 1 ? <Notice>A route needs at least two stops.</Notice> : null}
        </section>
      ) : null}

      {step === 1 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">How long between stops?</h2>
          <Notice>In minutes, as the bus usually runs. Passengers see times worked out from these.</Notice>
          <ol className="flex flex-col gap-3">
            {stops.map((s, i) => (
              <li key={i} className="flex flex-col gap-2 rounded-xl border border-border p-3">
                <span className="font-medium">{i + 1}. {placeName(s.locationId)}</span>
                {i === 0 ? <span className="text-sm text-muted">The bus leaves here at the departure time.</span> : (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={`Minutes from ${placeName(stops[i - 1].locationId).split(",")[0]}`} inputMode="numeric" value={s.travelMinutes} onChange={(e) => update(i, { travelMinutes: e.target.value })} />
                    {i < stops.length - 1 ? (
                      <Field label="Minutes stopped here" inputMode="numeric" value={s.stopMinutes} onChange={(e) => update(i, { stopMinutes: e.target.value })} />
                    ) : null}
                  </div>
                )}
                {i > 0 && minutes(s.travelMinutes) !== null ? <span className="text-sm text-muted">Arrives {formatDuration(offsets[i].arrival)} after departure.</span> : null}
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(0)} />
            <Button type="button" disabled={!timesOk} onClick={() => setStep(2)}>Next: getting on and off</Button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Who can get on and off where?</h2>
          <ul className="flex flex-col gap-2">
            {stops.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
                <span className="font-medium">{i + 1}. {placeName(s.locationId)}</span>
                {i === 0 ? <span className="text-sm text-muted">Get on only (first stop)</span> : i === stops.length - 1 ? <span className="text-sm text-muted">Get off only (last stop)</span> : (
                  <span className="flex gap-4 text-sm">
                    <label className="flex items-center gap-1"><input type="checkbox" checked={s.boarding} onChange={(e) => update(i, { boarding: e.target.checked })} /> Get on</label>
                    <label className="flex items-center gap-1"><input type="checkbox" checked={s.dropoff} onChange={(e) => update(i, { dropoff: e.target.checked })} /> Get off</label>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {!onOffOk ? <Notice tone="error">Every stop in the middle needs at least one of get on or get off.</Notice> : null}
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(1)} />
            <Button type="button" disabled={!onOffOk} onClick={() => setStep(3)}>Next: fares</Button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Fares for each trip</h2>
          <Notice>The price of one standard seat, in Ghana cedis. Student discounts and the booking fee are added automatically.</Notice>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={premium} onChange={(e) => setPremium(e.target.checked)} /> Premium seats (for example the front row) cost more
          </label>
          <ul className="flex flex-col gap-2">
            {pairs.map((p) => (
              <li key={key(p)} className="grid grid-cols-[1fr_7rem] items-end gap-2 sm:grid-cols-[1fr_7rem_7rem]">
                <span className="pb-3 text-sm">{placeName(stops[p.from].locationId)} → {placeName(stops[p.to].locationId)}</span>
                <Field label="Standard GH₵" inputMode="decimal" value={fares[key(p)] ?? ""} onChange={(e) => setFares({ ...fares, [key(p)]: e.target.value })} />
                {premium ? <Field label="Premium GH₵" inputMode="decimal" value={premiumFares[key(p)] ?? ""} onChange={(e) => setPremiumFares({ ...premiumFares, [key(p)]: e.target.value })} /> : null}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(2)} />
            <Button type="button" disabled={!faresOk} onClick={() => setStep(4)}>Next: check</Button>
          </div>
        </section>
      ) : null}

      {step === 4 ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">What passengers will see</h2>
          <Field label="Route name" value={name || suggestedName} onChange={(e) => setName(e.target.value)} hint="Shown to staff and on tickets." />
          <Field label="Distance in km (optional)" inputMode="numeric" value={distance} onChange={(e) => setDistance(e.target.value.replace(/\D/g, ""))} />
          <div className="rounded-xl border border-border p-4">
            <p className="font-semibold">{name || suggestedName}</p>
            <p className="text-sm text-muted">About {formatDuration(offsets[offsets.length - 1].arrival)} end to end</p>
            <ol className="mt-3 flex flex-col gap-1 text-sm">
              {stops.map((s, i) => (
                <li key={i}>
                  <span className="inline-block w-20 text-muted">+{formatDuration(i === 0 ? 0 : offsets[i].arrival)}</span>
                  {placeName(s.locationId)} <span className="text-muted">· {rules[i].boarding && rules[i].dropoff ? "get on or off" : rules[i].boarding ? "get on" : "get off"}</span>
                </li>
              ))}
            </ol>
            <ul className="mt-3 flex flex-col gap-0.5 text-sm">
              {pairs.map((p) => (
                <li key={key(p)}>
                  {placeName(stops[p.from].locationId)} → {placeName(stops[p.to].locationId)}: <strong>{formatCedis(parseCedis(fares[key(p)])!)}</strong>
                  {premium ? <span className="text-muted"> · premium {formatCedis(parseCedis(premiumFares[key(p)])!)}</span> : null}
                </li>
              ))}
            </ul>
          </div>
          <Notice>Saving makes the route and its fares live, so you can create departures and schedules on it. Stops cannot be changed once the route is live; you would make a new route instead.</Notice>
          {message ? <Notice tone="error">{message}</Notice> : null}
          <div className="flex gap-2">
            <BackButton onClick={() => setStep(3)} />
            <Button type="button" disabled={busy || (name || suggestedName).trim().length < 2} onClick={save}>{busy ? "Saving…" : "Save the route"}</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SmallIcon({ label, children, ...props }: { label: string } & React.ComponentProps<"button">) {
  return (
    <button type="button" aria-label={label} title={label} {...props} className="h-9 w-9 rounded-lg border border-border disabled:opacity-40">
      {children}
    </button>
  );
}
