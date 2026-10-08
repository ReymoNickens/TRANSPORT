# Build progress

Where the build is right now, measured against the specification
(`docs/spec/specification-v1.3.md`). Claude updates this file at the end
of every working session.

**Legend:** ✅ done · 🔄 in progress · ⬜ not started · 🧑 needs you (an account, a key or a business decision)

**Now working on:** Phase A done → next is **Phase B: network and fleet** (locations, routes, stops, vehicles, seat layouts, fares)

---

## Stack (decided)

- ✅ Next.js 16 app, deployed on **Vercel**
- ✅ **Supabase** for the Postgres database and sign-in
- ✅ **Paystack** for payments (hosted checkout, D29)
- ✅ **Arkesel** for text messages (sign-in codes, tickets, alerts)

## Accounts and keys you will need to create 🧑

Not needed yet: everything runs locally until we deploy.

- ⬜ 🧑 Supabase project (free tier is fine for development)
- ⬜ 🧑 Vercel account connected to this GitHub repo
- ⬜ 🧑 Paystack account, test keys first (live keys only at launch)
- ⬜ 🧑 Arkesel account, an API key and an approved sender ID
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

### Phase B: Network and fleet
- ⬜ Locations, routes and stops
- ⬜ Vehicles and versioned seat layouts
- ⬜ Fare templates, concession (student) types, fee rules

### Phase C: Scheduling
- ⬜ Schedules and exceptions
- ⬜ Nightly journey generation, 30 days ahead (D23)
- ⬜ Seat and fare snapshots per journey
- ⬜ Vehicle assignment with the 60-minute turnaround buffer
- ⬜ Checkpoint: journeys generate once, snapshots never change, assignments can't overlap

### Phase D: Booking core (Slice 1)
- ⬜ Journey search
- ⬜ Seat map and seat holds (10-minute hold, lock-first transaction)
- ⬜ Booking state machine
- ⬜ Payment provider interface, plus a fake provider for tests
- ⬜ Paystack checkout, webhook inbox, verify call
- ⬜ Late payment handling: re-seat or automatic refund
- ⬜ One ticket per seat, with a rotating QR code
- ⬜ Text messages through the outbox
- ⬜ Checkpoint: concurrency, replay, late-success and boundary tests pass

### Phase E: Boarding and operations (Slices 2 to 5)
- ⬜ Slice 2: conductor scanning, manual lookup, duplicate refusal, paper manifest
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
