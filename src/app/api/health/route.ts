import { apiRoute } from "@/lib/api/handler";
import { AppError } from "@/lib/api/errors";
import { db } from "@/lib/db";

/** Liveness and database reachability, for uptime monitoring (spec 22.3). */
export const GET = apiRoute(async () => {
  try {
    await db()`select 1`;
  } catch (error) {
    throw new AppError("internal_error", { cause: error });
  }
  return { data: { status: "ok" } };
});
