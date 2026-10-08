"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { formatDay, formatTime } from "@/lib/format";
import { Notice } from "../ui";

type StaffJourney = {
  id: string;
  routeName: string;
  scheduledDepartureAt: string;
  state: string;
  vehicleRegistration: string | null;
  crewRole: string | null;
  ticketsSold: number;
  boarded: number;
  openSheets: number;
};

export const stateLabel: Record<string, string> = {
  SCHEDULED: "On sale",
  SALES_CLOSED: "Sales closed",
  BOARDING: "Boarding",
  DEPARTED: "On the road",
  COMPLETED: "Arrived",
};

/** The staff app's Today screen (6.2): yesterday's, today's and tomorrow's journeys for this person. */
export function StaffJourneys() {
  const [journeys, setJourneys] = useState<StaffJourney[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<StaffJourney[]>("/api/staff/journeys").then(setJourneys).catch(setError);
  }, []);

  if (error?.code === "forbidden") return <Notice>Boarding is not part of your role. Ask an administrator.</Notice>;
  if (error) return <Notice tone="error">{error.message}</Notice>;
  if (!journeys) return <Notice>Loading your journeys…</Notice>;
  if (!journeys.length) return <Notice>No journeys for you today or tomorrow. Ask your manager to put you on a crew.</Notice>;

  return (
    <ul className="flex flex-col gap-3">
      {journeys.map((j) => (
        <li key={j.id}>
          <Link href={`/staff/journeys/${j.id}`} className="flex flex-col gap-1 rounded-xl border border-border p-4">
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{formatTime(j.scheduledDepartureAt)} · {j.routeName}</span>
              <span className="text-sm font-medium">{stateLabel[j.state] ?? j.state}</span>
            </span>
            <span className="text-sm text-muted">
              {formatDay(j.scheduledDepartureAt)} · {j.vehicleRegistration ?? "no bus yet"}
              {j.crewRole ? ` · you are the ${j.crewRole}` : ""}
            </span>
            <span className="text-sm">
              {j.boarded} of {j.ticketsSold} boarded
              {j.openSheets ? <span className="text-danger"> · {j.openSheets} paper sheet{j.openSheets === 1 ? "" : "s"} to enter</span> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
