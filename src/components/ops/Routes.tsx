"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { parseCedis } from "@/domain/money";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis, formatDay, formatDuration } from "@/lib/format";
import { Button, Field, Notice } from "../ui";
import type { OpsCan } from "./OpsShell";

type RouteSummary = { id: string; name: string; status: "draft" | "active" | "archived"; originName: string; destinationName: string; durationMinutes: number | null; stopCount: number };
type RouteStop = { id: string; sequence: number; locationName: string; arrivalOffsetMinutes: number; departureOffsetMinutes: number; boardingAllowed: boolean; dropoffAllowed: boolean };
type Route = { id: string; name: string; status: RouteSummary["status"]; distanceKm: number | null; durationMinutes: number | null; stops: RouteStop[] };
type FareTableSummary = { id: string; name: string; status: "draft" | "active" | "archived"; activatedAt: string | null; ruleCount: number };
type FareRule = { originStopId: string; destinationStopId: string; originName: string; destinationName: string; seatType: string; amountPesewas: number };
type FareTable = FareTableSummary & { rules: FareRule[] };

/** 2550 → "25.50", for an editable box (integer arithmetic only). */
const cedisText = (pesewas: number) => `${Math.floor(pesewas / 100)}.${String(pesewas % 100).padStart(2, "0")}`;

const routeStatus = { draft: "Not live yet", active: "Live", archived: "Retired" } as const;

/** Every route, live first. */
export function RouteList() {
  const [routes, setRoutes] = useState<RouteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: RouteSummary[] }>("/api/ops/routes?pageSize=100").then((p) => setRoutes(p.items)).catch((e: ApiError) => setError(e.message));
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!routes) return <Notice>Loading routes…</Notice>;
  const order = { active: 0, draft: 1, archived: 2 };
  return (
    <div className="flex flex-col gap-4">
      <Link href="/ops/routes/new" className="flex h-12 items-center justify-center rounded-lg bg-accent font-medium text-accent-foreground">Create a route</Link>
      {routes.length ? (
        <ul className="flex flex-col gap-2">
          {[...routes].sort((a, b) => order[a.status] - order[b.status]).map((r) => (
            <li key={r.id}>
              <Link href={`/ops/routes/${r.id}`} className="flex flex-col gap-1 rounded-xl border border-border p-3">
                <span className="flex justify-between gap-3">
                  <span className="font-medium">{r.name}</span>
                  <span className={`text-sm ${r.status === "active" ? "font-medium" : "text-muted"}`}>{routeStatus[r.status]}</span>
                </span>
                <span className="text-sm text-muted">
                  {r.originName} → {r.destinationName} · {r.stopCount} stops{r.durationMinutes ? ` · about ${formatDuration(r.durationMinutes)}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Notice>No routes yet.</Notice>
      )}
    </div>
  );
}

/** One route (8.6): stops, times, who gets on and off, and its fares. */
export function RouteDetail({ can }: { can: OpsCan }) {
  const { id } = useParams<{ id: string }>();
  const [route, setRoute] = useState<Route | null>(null);
  const [tables, setTables] = useState<FareTableSummary[]>([]);
  const [live, setLive] = useState<FareTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    let current = true;
    api<Route>(`/api/ops/routes/${id}`).then((r) => current && setRoute(r)).catch((e: ApiError) => current && setError(e.message));
    if (can.fares) {
      api<{ items: FareTableSummary[] }>(`/api/ops/fare-tables?routeId=${id}&pageSize=100`)
        .then(async (p) => {
          if (!current) return;
          setTables(p.items);
          const active = p.items.find((t) => t.status === "active");
          const table = active ? await api<FareTable>(`/api/ops/fare-tables/${active.id}`) : null;
          if (current) setLive(table);
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [id, refresh, can.fares]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!route) return <Notice>Loading the route…</Notice>;

  async function call(path: string) {
    setMessage(null);
    try {
      await api(path, { method: "POST" });
      reload();
    } catch (e) {
      setMessage((e as ApiError).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{route.name}</h1>
        <p className="text-muted">
          {routeStatus[route.status]}
          {route.durationMinutes ? ` · about ${formatDuration(route.durationMinutes)}` : ""}
          {route.distanceKm ? ` · ${route.distanceKm} km` : ""}
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Stops</h2>
        <ol className="flex flex-col gap-1 text-sm">
          {route.stops.map((s, i) => (
            <li key={s.id}>
              <span className="inline-block w-20 text-muted">+{formatDuration(i === 0 ? 0 : s.arrivalOffsetMinutes)}</span>
              {s.locationName}
              <span className="text-muted"> · {s.boardingAllowed && s.dropoffAllowed ? "get on or off" : s.boardingAllowed ? "get on" : "get off"}</span>
              {s.departureOffsetMinutes > s.arrivalOffsetMinutes && i > 0 ? <span className="text-muted"> · stops {s.departureOffsetMinutes - s.arrivalOffsetMinutes} min</span> : null}
            </li>
          ))}
        </ol>
        {route.status === "draft" && can.routes ? (
          <Button type="button" onClick={() => call(`/api/ops/routes/${route.id}/activate`)}>Make the route live</Button>
        ) : null}
        {route.status === "active" && can.routes ? (
          <button
            type="button"
            className="self-start text-sm underline"
            onClick={() => window.confirm("Retire this route? No new departures or schedules can use it. Existing departures and tickets are not affected.") && call(`/api/ops/routes/${route.id}/archive`)}
          >
            Retire this route
          </button>
        ) : null}
      </section>

      {can.fares ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Fares</h2>
          {live ? (
            <>
              <p className="text-sm text-muted">Live since {live.activatedAt ? formatDay(live.activatedAt) : "–"} · {live.name}</p>
              <FareEditor key={live.id} table={live} onSaved={reload} />
            </>
          ) : (
            <FirstFares route={route} tables={tables} onSaved={reload} />
          )}
        </section>
      ) : null}
      {message ? <Notice tone="error">{message}</Notice> : null}
    </div>
  );
}

/**
 * Shows the live fares and changes them safely (8.4): a copy is edited, and on
 * confirmation it replaces the live table for new bookings and for departures
 * put on sale from now on. Tickets already sold keep their fare.
 */
function FareEditor({ table, onSaved }: { table: FareTable; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const changed = table.rules
    .map((r, i) => ({ r, i, next: amounts[i] === undefined ? r.amountPesewas : parseCedis(amounts[i]) }))
    .filter((x) => x.next !== x.r.amountPesewas);
  const valid = table.rules.every((_, i) => amounts[i] === undefined || parseCedis(amounts[i]));

  async function save() {
    const summary = changed.map((x) => `${x.r.originName} → ${x.r.destinationName}: ${formatCedis(x.r.amountPesewas)} → ${formatCedis(x.next!)}`).join("\n");
    if (!window.confirm(`Change these fares?\n\n${summary}\n\nNew bookings, and departures put on sale from now on, use the new fares. Tickets already sold and departures already on sale keep their fares.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const copy = await api<{ id: string }>(`/api/ops/fare-tables/${table.id}/copy`, { method: "POST", body: { name: `Fares from ${new Date().toISOString().slice(0, 10)}` } });
      await api(`/api/ops/fare-tables/${copy.id}/rules`, {
        method: "PUT",
        body: {
          rules: table.rules.map((r, i) => ({
            originStopId: r.originStopId,
            destinationStopId: r.destinationStopId,
            seatType: r.seatType,
            amountPesewas: amounts[i] === undefined ? r.amountPesewas : parseCedis(amounts[i])!,
          })),
        },
      });
      await api(`/api/ops/fare-tables/${copy.id}/activate`, { method: "POST" });
      setEditing(false);
      setAmounts({});
      onSaved();
    } catch (e) {
      setMessage(`${(e as ApiError).message} The live fares have not changed.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1 text-sm">
        {table.rules.map((r, i) => (
          <li key={i} className="flex items-center justify-between gap-3">
            <span>{r.originName} → {r.destinationName}{r.seatType !== "standard" ? ` (${r.seatType})` : ""}</span>
            {editing ? (
              <input
                aria-label={`Fare ${r.originName} to ${r.destinationName} ${r.seatType}`}
                inputMode="decimal"
                className="h-10 w-28 rounded-lg border border-border bg-background px-2 text-right"
                value={amounts[i] ?? cedisText(r.amountPesewas)}
                onChange={(e) => setAmounts({ ...amounts, [i]: e.target.value })}
              />
            ) : (
              <strong>{formatCedis(r.amountPesewas)}</strong>
            )}
          </li>
        ))}
      </ul>
      {editing ? (
        <div className="flex gap-2">
          <button type="button" className="h-12 rounded-lg border border-border px-4 font-medium" onClick={() => { setEditing(false); setAmounts({}); }}>Cancel</button>
          <Button type="button" disabled={busy || !valid || !changed.length} onClick={save}>{busy ? "Saving…" : `Save ${changed.length} change${changed.length === 1 ? "" : "s"}`}</Button>
        </div>
      ) : (
        <button type="button" className="self-start text-sm underline" onClick={() => setEditing(true)}>Change fares</button>
      )}
      {message ? <Notice tone="error">{message}</Notice> : null}
    </div>
  );
}

/** A live route with no live fares: enter the standard fare for each trip. */
function FirstFares({ route, tables, onSaved }: { route: Route; tables: FareTableSummary[]; onSaved: () => void }) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const pairs = route.stops.flatMap((a, i) => route.stops.slice(i + 1).filter((b) => a.boardingAllowed && b.dropoffAllowed).map((b) => ({ a, b, key: `${a.id}-${b.id}` })));
  const ok = pairs.length > 0 && pairs.every((p) => parseCedis(amounts[p.key] ?? ""));
  if (route.status !== "active") return <Notice>Make the route live first, then set its fares.</Notice>;

  return (
    <div className="flex flex-col gap-2">
      <Notice tone="error">This route has no live fares, so nothing on it can go on sale.{tables.length ? " Earlier fare tables are retired or drafts." : ""}</Notice>
      {pairs.map((p) => (
        <Field key={p.key} label={`${p.a.locationName} → ${p.b.locationName} (GH₵)`} inputMode="decimal" value={amounts[p.key] ?? ""} onChange={(e) => setAmounts({ ...amounts, [p.key]: e.target.value })} />
      ))}
      <Button
        type="button"
        disabled={!ok}
        onClick={async () => {
          setMessage(null);
          try {
            const table = await api<{ id: string }>("/api/ops/fare-tables", { method: "POST", body: { routeId: route.id, name: `Fares from ${new Date().toISOString().slice(0, 10)}` } });
            await api(`/api/ops/fare-tables/${table.id}/rules`, {
              method: "PUT",
              body: { rules: pairs.map((p) => ({ originStopId: p.a.id, destinationStopId: p.b.id, seatType: "standard", amountPesewas: parseCedis(amounts[p.key])! })) },
            });
            await api(`/api/ops/fare-tables/${table.id}/activate`, { method: "POST" });
            onSaved();
          } catch (e) {
            setMessage((e as ApiError).message);
          }
        }}
      >
        Make these fares live
      </Button>
      {message ? <Notice tone="error">{message}</Notice> : null}
    </div>
  );
}
