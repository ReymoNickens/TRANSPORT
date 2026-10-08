# Build progress

Where the build is right now, measured against the specification
(`docs/spec/specification-v1.3.md`). Claude updates this file at the end
of every working session.

**Legend:** ✅ done · 🔄 in progress · ⬜ not started · 🧑 needs you (an account, a key or a business decision)

**Now working on:** Phases A, B and C done → next is **Phase D: booking core (Slice 1)**: search, seat holds, Paystack payment, tickets

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
| 2026-10-08 | Supabase and Vercel projects created; app live in London. Phase B built: locations, routes, vehicles, seat layouts, fares, concessions, fees, pricing. |
| 2026-10-08 | Phase C built: schedules, journey generation, bus and crew assignment, snapshots, journey status machine, high-risk confirmation. 105 tests. |
