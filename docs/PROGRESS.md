# Build progress

Where the build is right now, measured against the specification
(`docs/spec/specification-v1.3.md`). Claude updates this file at the end
of every working session.

**Legend:** ✅ done · 🔄 in progress · ⬜ not started · 🧑 needs you (an account, a key or a business decision)

**Now working on:** Phase E Slice 2 (boarding) done → next is **Phase E, Slice 3: the manager's dashboard and guided journey creation**

---

## Stack (decided)

- ✅ Next.js 16 app, deployed on **Vercel**
- ✅ **Supabase** for the Postgres database and sign-in
- ✅ **Paystack** for payments (hosted checkout, D29)
- ✅ **Arkesel** for text messages (sign-in codes, tickets, alerts)

## Accounts and keys you will need to create 🧑

- ✅ Supabase project `transport` created (London, free plan); migrations applied, organisation `pilot` created, security advisor clean
- ✅ Vercel project `transport` created and linked to this repo; public settings added
- ⬜ 🧑 Add `DATABASE_URL` in Vercel (instructions in the chat / README "How the app logs in to the database")
- ⬜ 🧑 Supabase dashboard: switch on Phone sign-in, the Send-SMS hook and TOTP (README "Still to switch on")
- ⬜ 🧑 Paystack account, test keys first (live keys only at launch)
- ⬜ 🧑 Arkesel account, an API key and an approved sender ID (then add them in Vercel)
- ⬜ 🧑 A domain name (for the app and the Paystack webhook)

---

## Release 1: pilot corridor

### Phase A: Foundations ✅ (built and tested locally)
- ✅ App scaffold (Next.js 16, TypeScript, Tailwind, Vitest)
- ✅ Specification, decision log (D1 to D34 plus technical decisions T1 to T9) and AI working rules (`CLAUDE.md`) in the repo
- ✅ Database conventions: time-ordered ids, no cascading deletes, update triggers
- ✅ Organisation boundary: row-level security, composite foreign keys, tested
- ✅ Roles and permissions stored as data: all 29 permissions and the 8 default roles of section 5
- ✅ Settings table holding every decision-log value, type-checked, with each change audited
- ✅ Audit log: nothing can edit or delete it, and phone numbers and names in it are masked
- ✅ API foundations: one response shape, stable error codes, correlation ids, no leaked internals
- ✅ Passenger sign-in: phone number plus text code, sent through Arkesel via the Supabase hook
- ✅ Staff sign-in: password plus authenticator-app second factor
- ✅ Tests: 28 unit tests and 17 database integrity tests passing
- ✅ CI on GitHub: lint, typecheck, tests, build and dependency audit on every push
- ⬜ 🧑 Try sign-in end to end on a real Supabase project, with a real Arkesel text (needs the accounts below)

### Phase B: Network and fleet ✅ (built, tested, live on Supabase)
- ✅ Locations: terminals, stations and stops (the controlled list used for search)
- ✅ Routes with ordered stops; checked by the database before going live (origin first, destination last, times never go backwards)
- ✅ Vehicles (registration, fleet number, capacity, status; retirement is final)
- ✅ Versioned seat layouts, built from a pattern such as "2+2, 13 rows" or seat by seat; a published layout never changes
- ✅ Fare tables by stop pair and seat type; can go live only when every trip has a price; prices change through a copied draft
- ✅ Student concession types (percent or fixed) and fee rules (booking fee, levy; online or station)
- ✅ Pricing in the fixed order of section 13.4a, with a price preview for managers
- ✅ 24 operations endpoints, each checking a permission (route.manage, fleet.manage, fare.manage)
- ✅ Tests: 86 passing (pricing, seat maps, permissions, and 20 database integrity tests for this phase)
- ⬜ Manager screens for these (they come with Slice 3, the guided workflows)

### Phase C: Scheduling ✅ (built and tested; one step waiting for you on Supabase)
- ✅ Schedules with versions (an edit is a new version) and exceptions (holidays, moved or extra runs)
- ✅ Nightly journey generation, 30 days ahead, at 02:10 (D23); also runnable on demand; never duplicates
- ✅ A journey goes on sale only with a bus, a seat map copied from that bus and fares copied from the live fare table
- ✅ Seat and fare snapshots never change once on sale (only blocking a broken seat is allowed)
- ✅ Bus assignment with the 60-minute turnaround (D16): the database refuses double-booking a bus
- ✅ Crew (driver, conductor): nobody can be on two overlapping journeys
- ✅ Journey status machine (DRAFT → SCHEDULED → … → COMPLETED / CANCELLED), every move recorded with who, when and why
- ✅ Changing a schedule shows the effect first, then moves unbooked journeys (spec 23.1)
- ✅ High-risk actions (for example cancelling a journey) need a reason and a fresh authenticator code
- ✅ Checkpoint passed: journeys generate once, snapshots hold, assignments cannot overlap (14 tests)
- ⬜ 🧑 Run one SQL file in the Supabase SQL editor (the bus-assignment function, see chat)

### Phase D: Booking core (Slice 1)
**Part 1, server side ✅ (built and tested; one SQL file waiting for you on Supabase)**
- ✅ Search between locations, with nearby dates when a day has nothing
- ✅ Seat map with available, held, taken and blocked seats, and the fares for the chosen stops
- ✅ Seat holds: all or nothing, 10 minutes (D2), never double-sold (the database refuses it)
- ✅ Limits: up to 6 seats (D6), 2 unpaid bookings per person (D7), holds per network address
- ✅ Server-side prices (13.4a) with the student fare (verified, expires per D25) and booking fees
- ✅ Payment provider interface: Paystack (hosted checkout) and a fake provider for testing
- ✅ Payment attempts written first, hold extended while paying (D3), callback inbox, verify call before trusting money
- ✅ Late payments: same seat, else same-class seat, else full automatic refund, with a critical exception (12.4)
- ✅ Paid twice: the extra payment is refunded automatically
- ✅ One ticket per seat with a QR code and a 6-character boarding code, never stored in readable form
- ✅ Text messages through the outbox (one per traveller, retried, never sent twice)
- ✅ Ledger postings that must balance; refunds can never exceed the payment
- ✅ 24 integrity tests from spec 24.2 pass (100 people grabbing one seat, a callback replayed 1,000 times, …)
- ⬜ 🧑 Run `supabase/manual/2026-10-08_phase_c7_d_and_e2.sql` in the Supabase SQL editor
- ⬜ 🧑 Paystack test secret key, a ticket secret and a job secret in Vercel

**Part 2, passenger screens ✅ (built and tested end to end in a browser)**
- ✅ Search with nearby dates, seat map, passenger details, review and pay, waiting screen, tickets with QR and boarding code
- ✅ My trips (signed in), ticket link page (`/t/…`), the fake checkout page for testing
- ✅ Demo data for previews: `supabase/demo-data.sql` (Accra → Kasoa → Winneba → Cape Coast, one 52-seat coach, daily 07:00)
- ⬜ Guest ticket lookup by reference + phone + text code (moved to Phase E)
- ⬜ Refund policy text on the booking page comes from settings (now fixed to the D14 defaults)
- ⬜ 🧑 Run the job every minute (`/api/jobs/tick`: payment checks, text messages): Vercel cron or Supabase pg_net, after the secrets are set

### Phase E: Boarding and operations (Slices 2 to 5)
**Slice 2, boarding ✅ (built and tested; included in the SQL file waiting for you on Supabase)**
- ✅ Staff "Today" list: the journeys you are on today and tomorrow, with boarded counts
- ✅ Start boarding, record departure, record arrival from the bus
- ✅ Scan the QR with the phone camera (or a scanner, or by typing): checks in the order of spec 14.3 with plain answers
- ✅ The passenger's name, seat, stops and fare shown first, with "Check student ID" for student fares, then one Confirm button
- ✅ Already boarded → "Already boarded at 06:12 by Kofi"; every refused scan written to the audit log
- ✅ 20 people confirming the same ticket at once → exactly one boarding (tested)
- ✅ A lost reply can be retried safely (same result, never boarded twice)
- ✅ Find a passenger by boarding code, booking reference, ticket number, phone or name, and board manually
- ✅ Manager override with a reason, for payment problems
- ✅ No signal: numbered printed passenger sheet with boarding codes; ticks entered later with the time from the sheet; a ticket cancelled after printing is flagged for review
- ✅ Boarding records can never be changed or removed
- ⬜ Not yet seen in a real browser: staff sign-in needs Supabase with an authenticator app, which this sandbox can't do. Please try it once the SQL file has run (see chat)
- ⬜ Slice 3: manager dashboard, guided route, schedule and journey creation
- ⬜ Slice 4: cancellations, refund approval, refunds through Paystack, exception queue
- ⬜ Slice 5: replacing a vehicle after seats are sold, with seat remapping

### Phase F: Money and hardening (Slice 6)
- ⬜ Ledger (chart of accounts, postings that sum to zero)
- ⬜ Daily reconciliation against Paystack settlements, with Finance sign-off
- ⬜ Reports
- ⬜ Security review, adversarial tests
- ⬜ Load tests, performance budgets, accessibility pass
- ⬜ Backup restore drill, alerts
- ⬜ Usability tests with managers and students

### Gate 1: pilot launch (section 25.1)
- ⬜ Every line of section 25.1 passes, with evidence kept
- ⬜ 🧑 Live Paystack payment on MTN, Telecel, AirtelTigo and a card
- ⬜ 🧑 Pilot plan: corridor, departures, support contact, rollback rule

---

## Release 2: scale
- ⬜ Segment resale · offline boarding · ticket changes · station cash shifts · second payment provider · verified student accounts

## Release 3: growth
- ⬜ Multi-leg journeys · passes · corporate accounts · driver app · live tracking · parcels

---

## Session log

| Date | What was done |
|---|---|
| 2026-10-08 | Stack chosen (Supabase, Vercel, Paystack, Arkesel). Phase A built: database foundations, sign-in, permissions, audit log, tests, CI. |
| 2026-10-08 | Supabase and Vercel projects created; app live in London. Phase B built: locations, routes, vehicles, seat layouts, fares, concessions, fees, pricing. |
| 2026-10-08 | Phase C built: schedules, journey generation, bus and crew assignment, snapshots, journey status machine, high-risk confirmation. 105 tests. |
| 2026-10-08 | Phase D part 1 built: holds, payments (Paystack and fake), late payments, tickets, text messages, ledger. 129 tests. |
| 2026-10-08 | Phase D part 2 built: passenger screens. Full flow tested in a browser: search → seats → pay (fake) → tickets with QR. |
| 2026-10-08 | Phase E slice 2 built: boarding (scan, find, override, paper sheet). 152 tests. |
