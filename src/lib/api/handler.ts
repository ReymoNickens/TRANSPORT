import { ZodError, type z } from "zod";
import { AppError } from "./errors";
import { log } from "./log";

export const CORRELATION_HEADER = "x-correlation-id";

export type ApiContext = {
  correlationId: string;
  request: Request;
};

/** One response shape for every endpoint (spec 20.1): { data } or { error }. */
export function ok<T>(data: T, init: { status?: number; correlationId: string }) {
  return Response.json({ data }, { status: init.status ?? 200, headers: { [CORRELATION_HEADER]: init.correlationId } });
}

export function fail(error: AppError, correlationId: string) {
  return Response.json(
    { error: { code: error.code, message: error.message, details: error.details, correlationId } },
    { status: error.status, headers: { [CORRELATION_HEADER]: correlationId } },
  );
}

function correlationIdFor(request: Request) {
  const given = request.headers.get(CORRELATION_HEADER);
  return given && /^[A-Za-z0-9-]{8,64}$/.test(given) ? given : crypto.randomUUID();
}

/**
 * Wraps a route handler: assigns a correlation id, maps errors to stable
 * codes, and never leaks stack traces or internals (spec 19.5).
 */
export function apiRoute<P = unknown>(
  run: (ctx: ApiContext, params: P) => Promise<Response | { data: unknown; status?: number }>,
) {
  return async (request: Request, routeContext?: { params: Promise<P> }) => {
    const correlationId = correlationIdFor(request);
    const started = Date.now();
    try {
      const params = (await routeContext?.params) as P;
      const result = await run({ correlationId, request }, params);
      const response = result instanceof Response ? result : ok(result.data, { status: result.status, correlationId });
      log("info", "request.completed", {
        correlationId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        ms: Date.now() - started,
      });
      return response;
    } catch (error) {
      const appError = toAppError(error);
      log(appError.status >= 500 ? "error" : "warn", "request.failed", {
        correlationId,
        method: request.method,
        path: new URL(request.url).pathname,
        code: appError.code,
        status: appError.status,
        ms: Date.now() - started,
        cause: appError.status >= 500 ? describe(error) : undefined,
      });
      return fail(appError, correlationId);
    }
  };
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError("validation_failed", {
      details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const dbError = fromDatabaseError(error);
  if (dbError) return dbError;
  return new AppError("internal_error", { cause: error });
}

/** Plain messages for unique rules a manager can run into. */
const uniqueMessages: Record<string, string> = {
  locations_name_per_organisation: "A location with this name already exists.",
  routes_name_per_organisation: "A route with this name already exists.",
  route_stops_route_id_location_id_key: "A location can appear only once on a route.",
  route_stops_route_id_sequence_key: "Two stops have the same number.",
  vehicles_organisation_id_registration_key: "A vehicle with this registration already exists.",
  vehicles_fleet_number: "A vehicle with this fleet number already exists.",
  seat_layouts_one_draft: "This vehicle already has a draft seat layout. Edit or publish that one.",
  seats_layout_id_seat_number_key: "Two seats have the same number.",
  seats_layout_id_row_number_column_number_key: "Two seats are in the same place.",
  fare_rules_template_id_origin_stop_id_destination_stop_id_seat_type_key: "There are two prices for the same trip and seat type.",
  concession_types_organisation_id_code_key: "A concession with this code already exists.",
};

/**
 * Maps database errors to stable codes. Business-rule failures (SQLSTATE
 * BR001) carry plain-English messages written for managers, so they pass
 * through. Everything else gets a generic message (spec 19.5).
 */
function fromDatabaseError(error: unknown): AppError | null {
  const e = error as { code?: string; message?: string; constraint_name?: string };
  switch (e?.code) {
    case "BR001":
      return new AppError("rule_violation", { message: e.message, cause: error });
    case "23505":
      return new AppError("already_exists", {
        message: (e.constraint_name && uniqueMessages[e.constraint_name]) || undefined,
        cause: error,
      });
    case "23503":
      return new AppError("validation_failed", { message: "Something this refers to does not exist.", cause: error });
    case "23514":
    case "22023":
    case "22P02":
      return new AppError("validation_failed", { cause: error });
    case "40001":
    case "40P01":
      return new AppError("conflict", { cause: error });
    default:
      return null;
  }
}

function describe(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message } : String(error);
}

/** Parses a JSON body against a schema (spec 20.3). */
export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("validation_failed", { message: "The request body must be valid JSON." });
  }
  return schema.parse(body);
}
