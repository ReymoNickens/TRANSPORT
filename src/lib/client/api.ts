"use client";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Calls our API and returns `data`, or throws the server's plain message.
 * A network failure says so honestly instead of guessing the outcome (21 rule 4).
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("offline", "You seem to be offline. Check your connection and try again.", 0);
  }
  const json = (await response.json().catch(() => null)) as { data?: T; error?: { code: string; message: string } } | null;
  if (!response.ok || !json || json.error) {
    throw new ApiError(json?.error?.code ?? "unknown", json?.error?.message ?? "Something went wrong. Please try again.", response.status);
  }
  return json.data as T;
}

/** Per-browser access to a guest booking. Storage can be unavailable (private mode), so every call is guarded. */
export const bookingToken = {
  get(reference: string): string | null {
    try {
      return localStorage.getItem(`booking-token:${reference}`);
    } catch {
      return null;
    }
  },
  set(reference: string, token: string) {
    try {
      localStorage.setItem(`booking-token:${reference}`, token);
    } catch {
      // Signed-in passengers still see the booking in Trips.
    }
  },
};
