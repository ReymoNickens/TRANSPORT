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

## Assumptions made during the build

Choices the specification left open. Each is the safer reading; the owner
can change any of them.

| # | Phase | Assumption | Why |
|---|---|---|---|
| A1 | B | Route stops, seat layouts and fare tables are edited only while they are drafts. A live one is changed by copying it to a new draft and publishing that; the old version is retired or archived, never edited | Spec 27.3 and 27.4 forbid changing layouts or fares under existing journeys. Versioning is the simplest way to guarantee it and keeps every version on record |
| A2 | B | A route's duration is not stored; it is the last stop's arrival offset | Spec 27.10: do not store a value in two places |
| A3 | B | A fare table can go live only when every stop pair a passenger can travel has a standard fare | No journey is ever on sale without a price |
| A4 | B | Concession discounts are rounded half up per seat; fees are summed exactly and the booking total is rounded once | Spec 13.4a rounds the total once; a per-seat concession must be a whole pesewa to be shown before payment |
| A5 | B | Percentages (concessions, percent fees) are stored in basis points (1000 = 10%) | Integer arithmetic only; no floating point on money |
| A6 | B | Vehicle capacity is the physical seat count; a published layout may not offer more bookable seats | Keeps the fleet record and the seat map consistent |
| A8 | C | A schedule does not pin a fare table. A journey takes the route's live fare table when it goes on sale | Prices change by publishing a new fare table (A1); a pinned table would be archived and stale |
| A9 | C | A journey's seat map is copied from its bus's published layout when the bus is assigned, while the journey is a draft. Once on sale, the bus changes only through the vehicle change procedure (Slice 5) | Spec 10.4: seat snapshot at creation; 15.1 governs changes after sale |
| A10 | C | A journey's times can change only before sales close; the bus and crew bookings move with them, and a clash is refused | Invariants 11.8 #4 stay true whatever changes |
| A11 | C | All staff sign in with an authenticator app. High-risk actions also need a reason and an authenticator code entered within the last 5 minutes | Spec 5 (fresh confirmation at the moment of use) and 19.2 |
| A12 | C | Generation never re-creates a journey for a schedule and date that already had one, even if it was cancelled | Spec 10.4: generation cannot duplicate; a cancelled journey stays as history |
| A13 | D | A booking that EXPIRED can still become CONFIRMED, but only inside the late-payment procedure (12.4) | Spec 12.4 confirms or re-seats a payment that arrives after the hold ended; the state table in 9.3 lists EXPIRED as final |
| A14 | D | A booking can go from PENDING straight to CONFIRMED when a success arrives for an attempt after a failure was reported | Out-of-order callbacks must reach the same final state (24.2) |
| A15 | D | QR token, ticket-link token and boarding code are derived from a server secret (TICKET_TOKEN_SECRET) and the credential id; only hashes are stored | Spec 14.2: the token is never stored, yet the passenger must be able to see the QR again |
| A16 | D | Each traveller gets one text with their own ticket link and boarding code; the purchaser gets a summary if they are not travelling | Spec 14.1 one ticket per seat, 17.3 rule 6 minimal data |
| A17 | D | A self-declared student number is accepted (D10) and re-declaring it after expiry re-verifies it | D25 release 1 |
| A18 | E | Staff see a journey's passengers when they are on its crew, or hold booking.view.scope (station agents, managers, support) | Spec 5 scopes: conductor "assigned journeys", station agent "assigned station"; station scoping waits for station assignments |
| A19 | E | Scanning and manual boarding need the journey in BOARDING. A conductor starts boarding from the bus, at most `boarding.opens_minutes_before` (120) minutes before departure | Spec 14.3 "Boarding has not opened" |
| A20 | E | A manager's override (ticket.override.board) can board against a payment problem, boarding not yet open, or a departed journey. It cannot board a cancelled, replaced or already boarded ticket, or a ticket for another journey | Spec 14.4; the ticket state machine and one-record-per-ticket rule still hold |
| A21 | E | A paper manifest can be printed from `boarding.manifest_export_hours` (24) hours before departure; sheets are numbered per organisation; paper boardings are entered once boarding has started, including after departure and arrival | Spec 14.7 |
| A22 | E | After arrival, once every paper sheet is entered and `boarding.no_show_after_hours` (6) have passed, unboarded seats become NO_SHOW, unused tickets EXPIRED and paid bookings COMPLETED (the every-minute job) | Spec 9.4 NO_SHOW, 14.7 step 3: late paper entries are never blocked |
| A23 | E | Two new permissions: exception.manage (take, work, resolve: Operations Manager, Finance, Support) and exception.dismiss (high risk: Operations Manager, Finance) | Spec 18.6 "dismissing needs a reason and a permission"; the spec's permission table has no code for it |
| A24 | E | "Bus missing" opens for a journey with no bus within `journeys.bus_missing_alert_hours` (24) of departure, and "paper boardings not entered" for an arrived journey with an open sheet; both close themselves when fixed | Spec 18.6, 14.7 step 4, 9.11 |
| A25 | E | Dashboard figures: seats sold and booked revenue count payments received today (Accra); refunds owed are refunds requested, approved, processing or failed | Spec 8.2a performance band |
| A26 | E | A new departure is warned as a possible duplicate when the same route already leaves within an hour that day | Spec 8.4 "Create a duplicate departure" |
| A7 | B | Business-rule refusals come from the database with SQLSTATE BR001 and a plain message, shown to managers as is | Spec 8.5: plain-English confirmation and recovery |

## Change history

| Date | Decision | Change | By |
|---|---|---|---|
| 2026-10-08 | D11 | Paystack confirmed (spec v1.3) | Owner |
| 2026-10-08 | D20 | Arkesel chosen as the text-message provider | Owner |
| 2026-10-08 | T1–T9 | Stack chosen: Supabase, Vercel, Next.js, Paystack, Arkesel | Owner |
