"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/client/api";
import { todayInAccra } from "@/lib/format";
import { Button, Notice } from "../ui";

type Location = { id: string; name: string; city: string };

/** Search is the dominant element (7.2). Places come from the controlled list, never free text. */
export function SearchForm({ initial }: { initial?: { from?: string; to?: string; date?: string } }) {
  const router = useRouter();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(initial?.from ?? "");
  const [to, setTo] = useState(initial?.to ?? "");
  const [date, setDate] = useState(initial?.date ?? todayInAccra());

  useEffect(() => {
    api<Location[]>("/api/public/locations")
      .then(setLocations)
      .catch((e: Error) => setError(e.message));
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!from || !to || from === to) {
      setError("Choose where you're leaving from and where you're going.");
      return;
    }
    router.push(`/search?from=${from}&to=${to}&date=${date}`);
  }

  const select = "h-12 rounded-lg border border-border bg-background px-3 text-base";
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">From</span>
        <select className={select} value={from} onChange={(e) => setFrom(e.target.value)} required disabled={!locations}>
          <option value="">{locations ? "Choose a place" : "Loading places…"}</option>
          {locations?.map((l) => <option key={l.id} value={l.id}>{l.name}, {l.city}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">To</span>
        <select className={select} value={to} onChange={(e) => setTo(e.target.value)} required disabled={!locations}>
          <option value="">{locations ? "Choose a place" : "Loading places…"}</option>
          {locations?.filter((l) => l.id !== from).map((l) => <option key={l.id} value={l.id}>{l.name}, {l.city}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Date</span>
        <input type="date" className={select} value={date} min={todayInAccra()} onChange={(e) => setDate(e.target.value)} required />
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit">Find buses</Button>
    </form>
  );
}
