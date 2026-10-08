import "server-only";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Postgres connection used by the server (the Supabase pooler in production).
  DATABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  // The organisation this deployment serves (release 1 runs one organisation).
  ORGANISATION_SLUG: z.string().default("pilot"),
  // Secret for Supabase's Send-SMS hook, in the form "v1,whsec_...".
  // Unset: the hook refuses every call, so no sign-in codes are sent.
  SEND_SMS_HOOK_SECRET: z.string().startsWith("v1,whsec_").optional(),
  SMS_PROVIDER: z.enum(["fake", "arkesel"]).default("fake"),
  ARKESEL_API_KEY: z.string().optional(),
  ARKESEL_SENDER_ID: z.string().max(11).optional(),
  PAYMENT_PROVIDER: z.enum(["fake", "paystack"]).default("fake"),
  PAYSTACK_SECRET_KEY: z.string().startsWith("sk_").optional(),
  // Ticket QR tokens, links and boarding codes are derived from this; at least 32 characters.
  TICKET_TOKEN_SECRET: z.string().min(32).optional(),
  // The public address of the app, for payment return pages and ticket links in text messages.
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  // Background jobs are called with this bearer secret.
  CRON_SECRET: z.string().min(24).optional(),
  // Set by Vercel: "production", "preview" or "development".
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
});

export type Env = z.infer<typeof schema>;

/** True for the live service: Vercel production, or a production build run elsewhere. */
export function isLive(e: Env = env()): boolean {
  return e.VERCEL_ENV ? e.VERCEL_ENV === "production" : e.NODE_ENV === "production";
}

let cached: Env | undefined;

/** Validated server environment. Throws on first use if anything is missing. */
export function env(): Env {
  if (!cached) {
    const result = schema.safeParse(process.env);
    if (!result.success) {
      // A plain Error, so a misconfiguration is reported as an internal error, never as the caller's fault.
      throw new Error(`Invalid server environment: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
    cached = result.data;
  }
  return cached;
}
