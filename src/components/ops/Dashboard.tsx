"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatCedis, formatDay, formatTime } from "@/lib/format";
import { Notice } from "../ui";
import type { OpsCan } from "./OpsShell";

export type AttentionItem = {
  id: string;
  kind: string;
  severity: "critical" | "high" | "normal";
  state: "OPEN" | "ACKNOWLEDGED" | "IN_PROGRESS";
  summary: string;
  recommendedAction: string;
  ownerName: string | null;
  dueAt: string;
  overdue: boolean;
  journeyId: string | null;
  bookingReference: string | null;
};
type Departure = {
  id: string;
  routeName: string;
  scheduledDepartureAt: string;
  state: string;
  vehicleRegistration: string | null;
  seatsSold: number;
  seats: number;
  boarded: number;
  problems: string[];
};
type DashboardData = {
  attention: AttentionItem[];
  today: Departure[];
  nextDeparture: { id: string; routeName: string; scheduledDepartureAt: string } | null;
  figures: { seatsSoldToday: number; occupancyPercent: number | null; revenueTodayPesewas: number; boardedToday: number; refundsOwedPesewas: number };
};

export const journeyStatus: Record<string, string> = {
  DRAFT: "○ Not on sale",
  SCHEDULED: "● On sale",
  SALES_CLOSED: "● Sales closed",
  BOARDING: "▶ Boarding",
  DEPARTED: "→ On the road",
  COMPLETED: "✓ Arrived",
  CANCELLED: "✕ Cancelled",
};

const severityLabel = { critical: "Urgent", high: "Today", normal: "When you can" } as const;

/**
 * The manager's dashboard (8.2a): what needs attention, today's departures,
 * and a quiet line of figures. Every item carries its next action.
 */
export function Dashboard({ can }: { can: OpsCan }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const load = () =>
      api<DashboardData>("/api/ops/dashboard")
        .then((d) => live && (setData(d), setError(null)))
        .catch((e: ApiError) => live && setError(e));
    load();
    // The day moves on: refresh every minute while the page is open.
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [refresh]);

  if (error?.code === "forbidden") return <Notice>The dashboard is not part of your role. Ask an administrator.</Notice>;
  if (error && !data) return <Notice tone="error">{error.message}</Notice>;
  if (!data) return <Notice>Loading today…</Notice>;

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="attention" className="flex flex-col gap-3">
        <h2 id="attention" className="text-lg font-semibold">Needs attention</h2>
        {data.attention.length ? (
          <ul className="flex flex-col gap-2">
            {data.attention.map((item) => (
              <AttentionRow key={item.id} item={item} can={can} onChange={reload} />
            ))}
          </ul>
        ) : (
          <Notice>Nothing needs your attention right now.</Notice>
        )}
      </section>

      <section aria-labelledby="today" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="today" className="text-lg font-semibold">Departures today</h2>
          {data.nextDeparture ? (
            <span className="text-sm text-muted">
              Next: <Link className="underline" href={`/ops/journeys/${data.nextDeparture.id}`}>{data.nextDeparture.routeName}, {formatDay(data.nextDeparture.scheduledDepartureAt)} {formatTime(data.nextDeparture.scheduledDepartureAt)}</Link>
            </span>
          ) : null}
        </div>
        {data.today.length ? (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {data.today.map((d) => (
              <li key={d.id}>
                <Link href={`/ops/journeys/${d.id}`} className="grid grid-cols-[3.5rem_1fr_auto] items-start gap-3 p-3">
                  <span className="text-lg font-semibold tabular-nums">{formatTime(d.scheduledDepartureAt)}</span>
                  <span className="flex flex-col">
                    <span className="font-medium">{d.routeName}</span>
                    <span className="text-sm text-muted">
                      {d.vehicleRegistration ?? "No bus"} · {d.seatsSold} of {d.seats} seats sold
                      {["BOARDING", "DEPARTED", "COMPLETED"].includes(d.state) ? ` · ${d.boarded} boarded` : ""}
                    </span>
                    {d.problems.length ? <span className="text-sm font-medium text-danger">⚠ {d.problems.join(" · ")}</span> : null}
                  </span>
                  <span className="text-sm font-medium">{journeyStatus[d.state] ?? d.state}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Notice>No departures today. {can.journeys ? <Link className="underline" href="/ops/journeys/new">Create a departure</Link> : null}</Notice>
        )}
      </section>

      <section aria-labelledby="figures" className="flex flex-col gap-2 text-sm text-muted">
        <h2 id="figures" className="font-medium">Today in figures</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
          <Figure label="Seats sold" value={String(data.figures.seatsSoldToday)} />
          <Figure label="Occupancy of today's buses" value={data.figures.occupancyPercent === null ? "–" : `${data.figures.occupancyPercent}%`} />
          <Figure label="Booked revenue" value={formatCedis(data.figures.revenueTodayPesewas)} />
          <Figure label="Passengers boarded" value={String(data.figures.boardedToday)} />
          <Figure label="Refunds owed" value={formatCedis(data.figures.refundsOwedPesewas)} />
        </dl>
      </section>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt>{label}</dt>
      <dd className="text-base font-semibold text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

/** One needs-attention item with its next action beside it (8.2, 18.6). */
export function AttentionRow({ item, can, onChange }: { item: AttentionItem; can: OpsCan; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/ops/exceptions/${item.id}/${path}`, { method: "POST", body });
      onChange();
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.code === "reconfirmation_required" ? "Enter your authenticator code again (sign out and in), then retry." : err.message);
    } finally {
      setBusy(false);
    }
  }

  const fix =
    item.journeyId && (item.kind === "bus_missing" || item.kind === "paper_boardings_not_entered" || item.kind === "boarding_override")
      ? { href: `/ops/journeys/${item.journeyId}`, label: item.kind === "bus_missing" ? "Assign a bus" : "Open the journey" }
      : item.bookingReference
        ? { href: `/ops/bookings/${item.bookingReference}`, label: "Open the booking" }
        : item.journeyId
          ? { href: `/ops/journeys/${item.journeyId}`, label: "Open the journey" }
          : null;

  const tone = item.severity === "critical" ? "border-danger" : "border-border";
  return (
    <li className={`flex flex-col gap-2 rounded-xl border-2 p-3 ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium">{item.summary}</span>
        <span className={`shrink-0 text-xs font-semibold uppercase ${item.severity === "normal" ? "text-muted" : "text-danger"}`}>
          {item.overdue ? "Overdue" : severityLabel[item.severity]}
        </span>
      </div>
      <p className="text-sm text-muted">
        {item.recommendedAction} · {item.ownerName ? `${item.ownerName} is on it` : "Unassigned"} · due {formatDay(item.dueAt)} {formatTime(item.dueAt)}
      </p>
      <div className="flex flex-wrap gap-2">
        {fix ? (
          <Link href={fix.href} className="flex h-10 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-foreground">{fix.label}</Link>
        ) : null}
        {can.exceptions ? (
          <>
            {item.state === "OPEN" ? <SmallButton disabled={busy} onClick={() => act("take")}>I&apos;ll handle it</SmallButton> : null}
            <SmallButton
              disabled={busy}
              onClick={() => {
                const resolution = window.prompt("What was done? This note is kept with the item.");
                if (resolution) void act("resolve", { resolution });
              }}
            >
              Mark as done
            </SmallButton>
          </>
        ) : null}
        {can.dismiss ? (
          <SmallButton
            disabled={busy}
            onClick={() => {
              const reason = window.prompt("Why is no action needed? This is recorded.");
              if (reason) void act("dismiss", { reason });
            }}
          >
            No action needed
          </SmallButton>
        ) : null}
      </div>
      {message ? <Notice tone="error">{message}</Notice> : null}
    </li>
  );
}

export function SmallButton(props: React.ComponentProps<"button">) {
  return <button type="button" {...props} className="h-10 rounded-lg border border-border px-3 text-sm font-medium disabled:opacity-60" />;
}
