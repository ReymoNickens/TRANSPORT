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
  return new AppError("internal_error", { cause: error });
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
