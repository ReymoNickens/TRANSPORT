import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { normaliseGhanaPhone } from "@/lib/phone";

export const name = (max = 120) => z.string().trim().min(2).max(max);
export const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

/** Accepts Ghana numbers as people type them; stores E.164. */
export const ghanaPhone = z
  .string()
  .transform((value, ctx) => {
    const phone = normaliseGhanaPhone(value);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "Enter a Ghana phone number, for example 024 123 4567." });
      return z.NEVER;
    }
    return phone;
  });

export const pesewas = z.number().int().positive().max(100_000_000);
export const basisPoints = z.number().int().min(1).max(10_000);
export const seatType = z.enum(["standard", "premium", "accessible"]);

/** The first row, or not_found. */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new AppError("not_found");
  return row;
}

/** Fields that are not part of a patch are left out of the update. */
export function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function requireChanges(patch: Record<string, unknown>) {
  if (Object.keys(patch).length === 0) {
    throw new AppError("validation_failed", { message: "Nothing to change." });
  }
}
