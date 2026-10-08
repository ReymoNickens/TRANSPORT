import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { log } from "@/lib/api/log";
import { env } from "@/lib/env";
import { normaliseGhanaPhone, maskPhone } from "@/lib/phone";
import { smsProvider } from "@/providers/sms";
import { SmsSendError } from "@/providers/sms/types";

/**
 * Supabase Auth "Send SMS" hook. Supabase calls this with the sign-in code;
 * we deliver it through our text-message provider (Arkesel, decision D20).
 * The request is signed (Standard Webhooks); anything unsigned is refused.
 * The code itself is never logged (spec 19.4).
 */
const payloadSchema = z.object({
  user: z.object({ phone: z.string().min(8) }),
  sms: z.object({ otp: z.string().regex(/^\d{4,10}$/) }),
});

function hookError(status: number, message: string) {
  return Response.json({ error: { http_code: status, message } }, { status });
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const raw = await request.text();

  let payload: z.infer<typeof payloadSchema>;
  try {
    const webhook = new Webhook(env().SEND_SMS_HOOK_SECRET.replace("v1,whsec_", ""));
    const verified = webhook.verify(raw, Object.fromEntries(request.headers));
    payload = payloadSchema.parse(verified);
  } catch {
    log("warn", "sms_hook.rejected", { correlationId });
    return hookError(401, "Invalid hook request");
  }

  const phone = normaliseGhanaPhone(payload.user.phone);
  if (!phone) {
    log("warn", "sms_hook.unsupported_number", { correlationId });
    return hookError(400, "Only Ghana mobile numbers are supported");
  }

  try {
    const result = await smsProvider().send({
      to: phone,
      message: `Your sign-in code is ${payload.sms.otp}. It expires in 10 minutes. Never share this code.`,
    });
    log("info", "sms_hook.sent", { correlationId, to: maskPhone(phone), providerReference: result.providerReference });
    return Response.json({});
  } catch (error) {
    log("error", "sms_hook.failed", {
      correlationId,
      to: maskPhone(phone),
      retryable: error instanceof SmsSendError ? error.retryable : true,
      cause: error instanceof Error ? error.message : String(error),
    });
    return hookError(502, "We could not send the code. Please try again.");
  }
}
