# Decision log

The specification (section 2) requires the decision log to live next to
the code. Each business decision has a default so work can start. The
owner confirms or changes each one before the release it affects.
Business values are also stored in the database `app.settings` table, so
they can change without a code change. Every change to a setting is
audited there. A change to a default recorded here is written in the
change history at the bottom, with who made it and when.

**Status:** `default` = the specification's default, not yet confirmed
by the owner · `confirmed` = confirmed by the owner · `changed` = the
owner chose something else (see history)

## Business decisions (specification section 2)

| # | Decision | Value | Applies | Status | Setting key |
|---|---|---|---|---|---|
| D1 | How seats are sold along a route | R1: whole-journey claim. R2: segment resale | R1, R2 | default | `seat_sales.mode` |
| D2 | Seat hold length | 10 minutes | R1 | default | `hold.minutes` |
| D3 | Hold extension while paying | Until 10 min after the attempt began, max 20 min from first selection | R1 | default | `hold.payment_extension_minutes`, `hold.max_total_minutes` |
| D4 | Payment arrives after the hold is gone | Same seat if free, else same-class seat, else full automatic refund | R1 | default | — |
| D5 | Online booking closes | 30 min before departure; station agents until departure | R1 | default | `booking.online_close_minutes` |
| D6 | Maximum seats per booking | 6 | R1 | default | `booking.max_seats` |
| D7 | Maximum active holds per person | 2, by phone number and account | R1 | default | `booking.max_active_holds` |
| D8 | Passenger sign-in | Phone number plus a text code; email optional | R1 | default | — |
| D9 | Guest booking | Allowed; found by reference + phone + text code | R1 | default | `booking.guest_allowed` |
| D10 | Student fares | Self-declared student number, checked at boarding | R1, R2 | default | — |
| D11 | Payment provider | **Paystack** (MoMo: MTN, Telecel, AirtelTigo; cards), behind an interface | R1 | confirmed | — |
| D12 | Station cash | Off in R1 | R2 | default | `station_cash.enabled` |
| D13 | Boarding validation | R1 online + manual lookup; R2 offline signed manifest | R1, R2 | default | — |
| D14 | Cancellation refund bands (owner) | ≥24h: fare less provider fee. 6–24h: 50%. <6h: none. Operator cancels: 100% incl. fees | R1 | default | `refund.policy` |
| D15 | Changing to another departure | Up to 6h before, once, same or higher fare | R2 | default | — |
| D16 | Turnaround buffer | 60 minutes | R1 | default | `fleet.turnaround_minutes` |
| D17 | Overbooking | Never | R1 | default | — |
| D18 | Revenue reporting | Booked (net of refunds) and earned (on completion) | R1 | default | — |
| D19 | Data retention (legal to confirm) | Passenger details 24 months; financial and audit 7 years | R1 | default | `retention.passenger_months`, `retention.financial_years` |
| D20 | Notifications | Text message first (**Arkesel**); push and email optional | R1 | default | — |
| D21 | Time zone and currency | Africa/Accra; Ghana cedi stored in pesewas | R1 | default | organisation columns |
| D22 | Free cancellation of unpaid booking | Any time before the hold ends | R1 | default | — |
| D23 | Journey generation | Nightly, 30 days ahead; DRAFT until bus + fare snapshot; booking opens 30 days before | R1 | default | `journeys.generation_horizon_days`, `booking.open_days_before` |
| D24 | Late payment and a different seat | Auto re-seat on, same class, no higher price, passenger told | R1 | default | `booking.auto_reseat_late_payment` |
| D25 | Student concession validity | End of academic year or 12 months, whichever sooner | R1, R2 | default | `concession.max_validity_months` |
| D26 | Price order | Base fare, concession, promotion, fees, rounding | R1 | default | — |
| D27 | Exception response times | Money taken no ticket: 1h. Failed refund / mismatch: 4h. Else next working day | R1 | default | `exceptions.response_minutes` |
| D28 | Boarding with no signal (R1) | Printed/exported manifest, manual mark-off, entry after trip | R1 | default | — |
| D29 | Checkout mode | R1 Paystack hosted checkout; R2 direct in-app MoMo charge | R1, R2 | default | — |
| D30 | Passengers with no email | Org-owned non-receiving address per booking | R1 | default | `paystack.placeholder_email_domain` |
| D31 | Who bears Paystack's fee | The organisation; passenger-pays is a setting | R1 | default | `fees.passenger_pays_provider_fee` |
| D32 | Refund routing | Paystack refund → Paystack transfer to MoMo → manual payout | R1 | default | — |
| D33 | Settlement | Paystack settles to bank; Finance reconciles daily | R1 | default | — |
| D34 | Webhook protection | Verify signature on raw body, Paystack IPs, server-side verify call | R1 | default | — |

## Technical decisions (made during the build)

The specification leaves the technology stack open (section 20).

| # | Decision | Choice | Why |
|---|---|---|---|
| T1 | Hosting | **Vercel** | Simple deploys from GitHub, preview deploys per change |
| T2 | Application framework | **Next.js 16** (App Router, TypeScript), one app serving the passenger, staff (`/staff`) and operations (`/ops`) areas | One codebase and one deploy are easiest for a small team to run. The three areas are still separate installable web apps (one manifest each) |
| T3 | Database | **Supabase Postgres** | The spec's integrity rules (partial unique indexes, exclusion constraints, row-level security, immutable tables) need Postgres |
| T4 | Where the tables live | Schema `app`, which is **not** exposed through Supabase's automatic REST API | Spec 20.5: no raw database access as an API. Every operation goes through our server endpoints |
| T5 | How the server talks to the database | `postgres` (postgres.js) over the Supabase pooler. Every business transaction runs as the restricted role `app_runtime` with the organisation set (`app.organisation_id`), so row-level security applies | Organisation boundary enforced by the database as a second line of defence (spec 10.9, 19.3) |
| T6 | Sign-in | **Supabase Auth**. Passengers: phone + text code, with codes delivered by our Send-SMS hook through **Arkesel**. Staff: email + password + authenticator-app second factor (TOTP) | D8, 19.1, 19.2 |
| T7 | Permissions | Our own tables (`app.roles`, `app.role_permissions`, `app.user_roles`); Supabase Auth only proves who someone is | Spec 5: roles and permissions are data; code checks a permission, never a role name |
| T8 | Background jobs | Supabase `pg_cron` for database-only jobs (hold expiry); Vercel Cron for jobs that call providers | Correctness never depends on a job running on time (11.4) |
| T9 | Tests | Vitest. Database tests run against a real Postgres with the migrations applied | The integrity tests (24.2) must exercise the real constraints |

## Change history

| Date | Decision | Change | By |
|---|---|---|---|
| 2026-10-08 | D11 | Paystack confirmed (spec v1.3) | Owner |
| 2026-10-08 | D20 | Arkesel chosen as the text-message provider | Owner |
| 2026-10-08 | T1–T9 | Stack chosen: Supabase, Vercel, Next.js, Paystack, Arkesel | Owner |
