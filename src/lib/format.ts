import { formatCedis } from "@/domain/money";

const ZONE = "Africa/Accra";

export function formatTime(value: string | Date) {
  return new Intl.DateTimeFormat("en-GH", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function formatDay(value: string | Date) {
  return new Intl.DateTimeFormat("en-GH", { timeZone: ZONE, weekday: "short", day: "numeric", month: "short" }).format(new Date(value));
}

export function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m ? `${m} min` : ""}`.trim() : `${m} min`;
}

/** Today's date in Accra as YYYY-MM-DD. */
export function todayInAccra() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());
}

export { formatCedis };
