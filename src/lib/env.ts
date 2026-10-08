import "server-only";
import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Postgres connection used by the server (the Supabase pooler in production).
    DATABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    // The organisation this deployment serves (release 1 runs one organisation).
    ORGANISATION_SLUG: z.string().default("pilot"),
    // Secret for Supabase's Send-SMS hook, in the form "v1,whsec_...".
    SEND_SMS_HOOK_SECRET: z.string().startsWith("v1,whsec_"),
    SMS_PROVIDER: z.enum(["fake", "arkesel"]).default("fake"),
    ARKESEL_API_KEY: z.string().optional(),
    ARKESEL_SENDER_ID: z.string().max(11).optional(),
  })
  .refine((e) => e.SMS_PROVIDER !== "arkesel" || (e.ARKESEL_API_KEY && e.ARKESEL_SENDER_ID), {
    message: "ARKESEL_API_KEY and ARKESEL_SENDER_ID are required when SMS_PROVIDER is arkesel",
  })
  .refine((e) => e.NODE_ENV !== "production" || e.SMS_PROVIDER !== "fake", {
    message: "The fake SMS provider cannot run in production",
  });

export type Env = z.infer<typeof schema>;

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
