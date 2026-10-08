"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { formatCedis, formatDay, formatDuration, formatTime } from "@/lib/format";
import { Notice } from "../ui";

type Result = {
  journeyId: string;
  originStopId: string;
  originName: string;
  destinationStopId: string;
  destinationName: string;
  departsAt: string;
  arrivesAt: string;
  durationMinutes: number;
  seatsLeft: number;
  fromPesewas: number;
  delayMinutes: number;
};
type Response = { results: Result[]; nearby: { date: string; journeys: number }[] };

/** Results (7.3): one operator, so no comparison; each result has one clear action. */
export function SearchResults() {
  const params = useSearchParams();
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const date = params.get("date") ?? "";
  const key = `${from}|${to}|${date}`;
  // Results are kept with the search they answer, so a new search never shows old results.
  const [answer, setAnswer] = useState<{ key: string; data?: Response; error?: string } | null>(null);

  useEffect(() => {
    let active = true;
    api<Response>(`/api/public/search?from=${from}&to=${to}&date=${date}`)
      .then((data) => active && setAnswer({ key, data }))
      .catch((e: Error) => active && setAnswer({ key, error: e.message }));
    return () => {
      active = false;
    };
  }, [from, to, date, key]);

  const current = answer?.key === key ? answer : null;
  if (current?.error) return <Notice tone="error">{current.error}</Notice>;
  const data = current?.data;
  if (!data) return <Notice>Finding buses…</Notice>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{formatDay(`${date}T12:00:00Z`)} · <Link href="/" className="underline">Change search</Link></p>
      {data.results.length === 0 ? (
        <div className="flex flex-col gap-3">
          <Notice>No bus with seats on this day: there may be no service, it may be sold out, or online booking may have closed.</Notice>
          {data.nearby.length ? (
            <ul className="flex flex-col gap-2">
              {data.nearby.map((n) => (
                <li key={n.date}>
                  <Link className="underline" href={`/search?from=${from}&to=${to}&date=${n.date}`}>
                    {formatDay(`${n.date}T12:00:00Z`)}: {n.journeys} bus{n.journeys === 1 ? "" : "es"} with seats
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.results.map((r) => (
            <li key={r.journeyId} className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-xl font-semibold">{formatTime(r.departsAt)} → {formatTime(r.arrivesAt)}</p>
                <p className="font-semibold">from {formatCedis(r.fromPesewas)}</p>
              </div>
              <p className="text-sm text-muted">
                Board at {r.originName} · {formatDuration(r.durationMinutes)} · {r.seatsLeft === 0 ? "Sold out" : `${r.seatsLeft} seats left`}
                {r.delayMinutes ? ` · Delayed ${r.delayMinutes} min` : ""}
              </p>
              {r.seatsLeft > 0 ? (
                <Link
                  href={`/journey/${r.journeyId}?origin=${r.originStopId}&destination=${r.destinationStopId}`}
                  className="flex h-11 items-center justify-center rounded-lg bg-accent font-medium text-accent-foreground"
                >
                  Choose seats
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
