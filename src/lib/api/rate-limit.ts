import { withOrganisation, type Sql, type Tx } from "@/lib/db";
import { AppError } from "./errors";
import { log } from "./log";

/**
 * Rate limits (spec 19.5, 19.6, 19.9). Counted in the database, so every
 * server instance shares them. Keys name what is limited and for whom, never
 * a full phone number or a token.
 */
export const limits = {
  /** Seat holds from one network address, a burst on top of the hourly limit of 11.6. */
  hold: { limit: 20, windowSeconds: 60 },
  /** Opening a booking or a ticket link from one address. */
  bookingLookup: { limit: 60, windowSeconds: 60 },
  /** Booking references or ticket links that matched nothing, from one address (guessing, 19.9). */
  lookupMiss: { limit: 10, windowSeconds: 600 },
  /** Starting payments for one booking. */
  paymentStart: { limit: 10, windowSeconds: 600 },
  /** Scans and manual boardings by one staff member (scan floods, 19.9). */
  scan: { limit: 120, windowSeconds: 60 },
  /** Manual lookups by one staff member. */
  staffLookup: { limit: 60, windowSeconds: 60 },
  /** Sign-in codes sent to one number (19.1: 5 an hour). */
  signInCode: { limit: 5, windowSeconds: 3600 },
} as const;

export type LimitName = keyof typeof limits;

/** Counts one attempt and refuses it when over the limit. */
export async function rateLimit(tx: Tx | Sql, name: LimitName, subject: string, context: { correlationId?: string } = {}) {
  const { limit, windowSeconds } = limits[name];
  const [row] = await tx<{ allowed: boolean }[]>`select app.hit_rate_limit(${`${name}:${subject}`}, ${limit}, ${windowSeconds}) as allowed`;
  if (!row.allowed) {
    log("warn", "rate_limit.refused", { correlationId: context.correlationId, limit: name });
    throw new AppError("rate_limited");
  }
}

/** Counts one attempt without refusing; true when the subject is now over the limit. */
export async function overLimitAfter(tx: Tx | Sql, name: LimitName, subject: string) {
  const { limit, windowSeconds } = limits[name];
  const [row] = await tx<{ allowed: boolean }[]>`select app.hit_rate_limit(${`${name}:${subject}`}, ${limit}, ${windowSeconds}) as allowed`;
  return !row.allowed;
}

/** Counts and checks an attempt in its own transaction, so it counts even when the attempt itself fails. */
export async function checkLimit(context: { organisationId: string; correlationId?: string }, name: LimitName, subject: string, sql?: Sql) {
  await withOrganisation(context, (tx) => rateLimit(tx, name, subject, context), sql);
}

/**
 * Guards a lookup by a guessable value (a booking reference or ticket link,
 * 19.9): at most `bookingLookup` lookups a minute from one address, and after
 * `lookupMiss` misses the address is refused until the window passes. Misses are logged.
 */
export async function guardedLookup<T>(
  context: { organisationId: string; correlationId?: string },
  address: string | null,
  lookup: () => Promise<T | null>,
  sql?: Sql,
): Promise<T | null> {
  const subject = address ?? "unknown";
  const { windowSeconds, limit } = limits.lookupMiss;
  await withOrganisation(context, async (tx) => {
    await rateLimit(tx, "bookingLookup", subject, context);
    const [row] = await tx<{ hits: number }[]>`
      select hits from app.rate_limit_hits
      where key = ${`lookupMiss:${subject}`} and window_start = to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds})`;
    if (row && row.hits >= limit) throw new AppError("rate_limited");
  }, sql);
  const found = await lookup();
  if (found === null) {
    log("warn", "lookup.miss", { correlationId: context.correlationId });
    await withOrganisation(context, (tx) => overLimitAfter(tx, "lookupMiss", subject), sql);
  }
  return found;
}
