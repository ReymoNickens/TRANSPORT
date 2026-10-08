import { createHash } from "node:crypto";
import type { Tx } from "@/lib/db";
import { AppError } from "./errors";

/**
 * Idempotency keys (spec 11.7, 20.4). A repeated key returns the first
 * result; the same key with a different request is refused. The key row is
 * written in the same transaction as the operation, so a failed operation
 * leaves no key behind and can be retried.
 */
export async function idempotent<T>(
  tx: Tx,
  options: { organisationId: string; operation: string; key: string | null; request: unknown },
  run: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const key = options.key?.trim();
  if (!key || key.length < 8 || key.length > 100) {
    throw new AppError("validation_failed", { message: "An Idempotency-Key header (8 to 100 characters) is required." });
  }
  const requestHash = createHash("sha256").update(JSON.stringify(options.request ?? null)).digest("hex");

  const inserted = await tx<{ id: string }[]>`
    insert into app.idempotency_keys (organisation_id, operation, key, request_hash)
    values (${options.organisationId}, ${options.operation}, ${key}, ${requestHash})
    on conflict (organisation_id, operation, key) do nothing
    returning id`;

  if (inserted.length === 0) {
    const [existing] = await tx<{ requestHash: string; response: T | null; completedAt: Date | null }[]>`
      select request_hash, response, completed_at from app.idempotency_keys
      where organisation_id = ${options.organisationId} and operation = ${options.operation} and key = ${key}`;
    if (existing.requestHash !== requestHash) {
      throw new AppError("idempotency_mismatch");
    }
    if (!existing.completedAt) throw new AppError("conflict", { message: "This request is still being processed. Try again in a moment." });
    return { result: existing.response as T, replayed: true };
  }

  const result = await run();
  await tx`
    update app.idempotency_keys set response = ${tx.json(result as never)}, response_status = 200, completed_at = now()
    where id = ${inserted[0].id}`;
  return { result, replayed: false };
}
