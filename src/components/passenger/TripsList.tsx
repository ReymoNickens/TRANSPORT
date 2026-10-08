"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatDay, formatTime } from "@/lib/format";
import { Notice } from "../ui";

type Trip = { reference: string; state: string; originName: string; destinationName: string; departsAt: string; seats: number };

/** Upcoming and past trips (7.9). */
export function TripsList() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<Trip[]>("/api/me/bookings").then(setTrips).catch(setError);
  }, []);

  if (error?.code === "unauthenticated") {
    return <Notice>Please <Link href="/sign-in" className="underline">sign in with your phone</Link> to see your trips. Booked as a guest? Use the link in your text message.</Notice>;
  }
  if (error) return <Notice tone="error">{error.message}</Notice>;
  if (!trips) return <Notice>Loading your trips…</Notice>;
  if (!trips.length) return <Notice>No trips yet. <Link href="/" className="underline">Find a bus</Link>.</Notice>;

  return (
    <ul className="flex flex-col gap-3">
      {trips.map((t) => (
        <li key={t.reference}>
          <Link href={`/booking/${t.reference}`} className="flex flex-col gap-1 rounded-xl border border-border p-4">
            <span className="font-semibold">{t.originName} → {t.destinationName}</span>
            <span className="text-sm text-muted">
              {formatDay(t.departsAt)} · {formatTime(t.departsAt)} · {t.seats} seat{t.seats === 1 ? "" : "s"} · {t.state.toLowerCase().replace("_", " ")}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
