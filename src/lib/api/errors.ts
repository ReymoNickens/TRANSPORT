/**
 * Stable error codes (spec 20.2). A client acts on the code; a person reads
 * the message. Neither exposes internals. Add new codes here, never inline.
 */
export const errorCatalogue = {
  validation_failed: { status: 400, message: "Some of the details sent are not valid." },
  unauthenticated: { status: 401, message: "Please sign in to continue." },
  second_factor_required: { status: 403, message: "Confirm it's you with your authenticator app to continue." },
  forbidden: { status: 403, message: "You don't have permission to do this." },
  reconfirmation_required: { status: 403, message: "This is a sensitive action. Enter the code from your authenticator app again to confirm it's you." },
  not_found: { status: 404, message: "We couldn't find what you were looking for." },
  conflict: { status: 409, message: "This was changed by someone else. Refresh and try again." },
  already_exists: { status: 409, message: "Something with these details already exists." },
  rule_violation: { status: 422, message: "This change breaks one of the business rules." },
  organisation_unavailable: { status: 503, message: "This service is not available right now." },
  provider_unavailable: { status: 502, message: "A service we depend on is not responding. Please try again shortly." },
  internal_error: { status: 500, message: "Something went wrong on our side. Please try again." },
} as const;

export type ErrorCode = keyof typeof errorCatalogue;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe, structured detail for the client (for example which fields failed). */
  readonly details?: unknown;

  constructor(code: ErrorCode, options: { message?: string; details?: unknown; cause?: unknown } = {}) {
    super(options.message ?? errorCatalogue[code].message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = errorCatalogue[code].status;
    this.details = options.details;
  }
}
