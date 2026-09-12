# EventForge Backend

Backend foundation and authentication system for EventForge, an event discovery and
ticket booking platform. This phase implements only the backend architecture and
email/password + (schema-ready) Google OAuth authentication — no events, venues,
seats, bookings, or payments yet.

## Stack

Node.js, Express 5, TypeScript, Prisma (PostgreSQL), Zod, Argon2id, JWT, Pino.

## Architecture

```
Request → Route → Controller → Service → Repository → Prisma → PostgreSQL
```

- **Routes** (`src/routes`) wire endpoints to middleware and controllers only.
- **Controllers** (`src/controllers`) read the request, call a service, shape the HTTP response.
- **Services** (`src/services`) hold business logic: password checks, token issuance/rotation.
- **Repositories** (`src/repositories`) are the only layer that talks to Prisma.
- **Middleware** (`src/middleware`) handles auth guarding, request validation, and centralized error formatting.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in real values (a `.env` with working
   local defaults already exists in this repo for development).
3. Create the local database (PostgreSQL must be running):
   ```
   psql -U postgres -c "CREATE DATABASE eventforge;"
   ```
4. Apply migrations:
   ```
   npm run prisma:migrate
   ```
5. Start the dev server:
   ```
   npm run dev
   ```
6. Verify it's up:
   ```
   curl http://localhost:4000/health
   ```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the server with hot reload (tsx watch) |
| `npm run build` | Type-check and compile `src/` to `dist/` |
| `npm start` | Run the compiled server (`dist/server.js`) |
| `npm run typecheck` | Type-check the whole project (including tests) with no emit |
| `npm test` | Run the automated test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run prisma:generate` | Regenerate the Prisma client after a schema change |
| `npm run prisma:migrate` | Create/apply a migration in dev |
| `npm run prisma:studio` | Open Prisma Studio (visual DB browser) |
| `npm run worker` | Start the booking-expiry background worker (requires Redis — see below) |
| `npm run start:worker` | Run the compiled worker (`dist/worker.js`) |

## Authentication

- **Register**: `POST /api/auth/register` — `{ name, email, password }`
- **Login**: `POST /api/auth/login` — `{ email, password }`
- **Refresh**: `POST /api/auth/refresh` — reads the `refreshToken` httpOnly cookie, rotates it
- **Logout**: `POST /api/auth/logout` — revokes the current refresh token
- **Current user**: `GET /api/auth/me` — requires `Authorization: Bearer <accessToken>`

Access tokens are short-lived JWTs (15m) sent in the response body and used via the
`Authorization` header. Refresh tokens (7d) are opaque-to-the-client JWTs stored as a
`Secure` (in production) + `HttpOnly` + `SameSite=Lax` cookie scoped to `/api/auth`;
only a SHA-256 hash of each refresh token is persisted, and every refresh rotates
(single-use) and revokes the previous one.

Login errors are intentionally generic (`INVALID_CREDENTIALS`) whether the email
doesn't exist or the password is wrong, to avoid account enumeration. Registration
does disclose a duplicate email (`EMAIL_ALREADY_EXISTS`), which is standard UX and
carries materially less enumeration risk than login.

Google OAuth is not implemented yet — the `OAuthAccount` table and repository exist
so it can be added without a schema change, but the routes/controller logic are a
follow-up increment.

## Testing

Tests run against your local `eventforge` database (via Supertest + the real
Express app, no server binding required) and are self-isolating: each test uses a
randomly generated email and cleans up the rows it created afterward, so running
the suite never disturbs data you created manually. Auth rate limiting is disabled
under `NODE_ENV=test` (set automatically by `npm test`) so the suite isn't throttled.

## Payments & booking lifecycle (Phase 6)

### Booking state lifecycle

```
PENDING ──cancel──▶ CANCELLED
   │                   ▲
   │ (lazy, or worker) │
   ▼                   │
EXPIRED           CONFIRMED ──cancel──▶ CANCELLED
```

`PENDING` holds its inventory (seats / general-admission quantity) immediately on
creation (Phase 5). `CONFIRMED` is reached only via a verified payment webhook —
never by a client simply asserting success. `CANCELLED` and `EXPIRED` are terminal:
neither can become `CONFIRMED` afterward. Every transition (confirm, cancel, expire)
uses the same guarded pattern: `UPDATE bookings SET status = X WHERE id = ? AND
status IN (allowed-from-states)`, checking the affected-row count. Postgres's own
row-level locking on that `UPDATE` makes two competing transitions (e.g. a payment
webhook and the expiry worker racing the same booking) safe with no explicit
`SELECT ... FOR UPDATE` needed: whichever commits first wins, and the loser's `WHERE`
clause re-evaluates against the now-committed row and safely updates zero rows.

### Payment state lifecycle

```
PENDING ──succeeded webhook──▶ SUCCEEDED
   │
   └──failed webhook──▶ FAILED
```

A `Payment` snapshots its `amount`/`currency` from `Booking.total`/`Booking.currency`
at creation time — the webhook handler verifies an incoming event against this
snapshot, never against the (mutable) booking or anything the webhook payload
itself claims. `SUCCEEDED` only transitions the parent `Booking` to `CONFIRMED` if
the booking is still `PENDING`; if it already left `PENDING` (cancelled/expired
first), the payment is still recorded as `SUCCEEDED` — the money genuinely moved —
but the booking is not resurrected. Reconciling that case into a refund is
explicitly out of scope for this phase.

### Payment provider abstraction

```
PaymentService → PaymentProvider interface → StripePaymentProvider | FakePaymentProvider
```

`src/providers/payment-provider.ts` defines the interface; `stripe-payment-provider.ts`
is the real Stripe implementation; `fake-payment-provider.ts` is an in-process test
double. **Real Stripe credentials are never required** — `src/providers/payment-provider.factory.ts`
automatically uses the fake provider whenever `NODE_ENV=test`, or whenever
`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` aren't set. This means `npm test` and
even `npm run dev` work out of the box with no Stripe account at all; the fake
provider is a genuine HMAC-signed test double (tampered signatures really are
rejected), not a bypass of the webhook logic itself.

### API endpoints

```
POST /api/bookings/:id/payment        (authenticated; owner only)
POST /api/payments/webhook/stripe     (Stripe signature-verified, not user-authenticated)
```

`POST /api/bookings/:id/payment` requires the booking be `PENDING` and not expired,
derives the amount/currency from the booking itself, and creates (or reuses an
existing unresolved) payment intent through the provider abstraction. It returns
only `{ payment: { id, provider, amount, currency, status }, clientSecret }` — no
secret keys, no internal provider ids beyond what the frontend needs to complete
payment client-side.

### Stripe test-mode setup (optional — not required for tests or local dev)

1. Create a free Stripe account and switch to **test mode**.
2. Get your test secret key from https://dashboard.stripe.com/test/apikeys →
   `STRIPE_SECRET_KEY` in `.env`.
3. For webhooks locally, install the [Stripe CLI](https://stripe.com/docs/stripe-cli)
   and run `stripe listen --forward-to localhost:4000/api/payments/webhook/stripe` —
   it prints a webhook signing secret to put in `STRIPE_WEBHOOK_SECRET`.
4. Restart the server. Leaving either value blank keeps the fake provider active.

### Webhook raw-body handling

Stripe signature verification needs the exact raw request bytes. `src/app.ts`
registers `POST /api/payments/webhook/stripe` with its own `express.raw()` parser
**before** the global `express.json()` middleware, so this one route sees unparsed
bytes while every other route is unaffected.

### Redis + BullMQ expiry worker

Phase 5 used purely lazy expiry (checked on read/write). Phase 6 adds a proactive
background sweep via BullMQ, running as a **separate process** from the API server
(`npm run worker`) — its lifecycle (crashes, restarts, deploys) is intentionally
decoupled from the HTTP API's.

1. Install Redis locally (e.g. via WSL: `sudo apt install redis-server`, or Windows
   builds, or Docker: `docker run -p 6379:6379 redis`).
2. Set `REDIS_URL` in `.env` (defaults to `redis://localhost:6379`).
3. Run the worker in a separate terminal: `npm run worker`.

The worker doesn't carry a job per booking — a permanent per-booking timer wouldn't
survive a restart and doesn't scale. Instead one recurring job (every 60s, via
BullMQ's `upsertJobScheduler` — idempotent across worker restarts) asks the database
"which `PENDING` bookings are actually overdue right now" and expires them. Every
expiry goes through the same guarded transition as everything else, so the job is
safe to run concurrently with itself, retry, or run after a crash: anything already
resolved by another path (a payment webhook, a cancellation, an earlier sweep) is
simply skipped.

**Redis is never required for `npm test`** — the expiry logic itself
(`expireDueBookings()` in `booking.service.ts`) is a plain, directly-callable
function with zero BullMQ/Redis dependency, and the full test suite calls it
directly against the real database. As of Phase 7, `npm run worker` also starts the
refund-processing worker (below) in the same process — both are lightweight enough
that there's no reason to run them separately yet.

## Refunds & organizer booking management (Phase 7)

### Refund state lifecycle

```
PENDING ──provider/webhook confirms──▶ SUCCEEDED
   │
   └──provider call fails──▶ FAILED ──(admin retry creates a NEW attempt)──▶ PENDING → ...
```

A `Refund` is its own model (not fields on `Payment`), mirroring why `Payment` is its
own model rather than fields on `Booking`: a payment can have multiple attempts, and
so can a refund. Full-refund-only in V1 — `Refund.amount` always equals the
payment's amount. `Booking`/`BookingItem`/`Payment` state machines are **unchanged**
by refunds: a refunded booking stays `CANCELLED`, and a refunded payment stays
`SUCCEEDED` (the charge really did succeed; the refund is a separate, later event —
same as Stripe's own model). Nothing about "was this refunded" lives on `Booking` —
it's derived by joining `Booking → Payment → Refund`.

A `Refund` row is persisted as `PENDING` — with its idempotency key already fixed —
**before** the provider is ever called, unlike `Payment.providerPaymentId` which is
only known after a synchronous call inside an HTTP request. Refund processing runs
in a background worker with no client waiting, so persist-then-call is what keeps a
worker crash between "the provider confirmed the refund" and "we recorded that fact"
from leaving real money moved with zero local record — the refund webhook is a
second, independent path to reach the correct state either way.

**Duplicate-refund protection is three layers deep**, each independently sufficient:
1. A Postgres **partial unique index** — `refunds_active_payment_unique` — allows at
   most one `PENDING` or `SUCCEEDED` refund per payment (a `FAILED` one doesn't
   count, so a retry can create a fresh row). The hard backstop, DB-enforced.
2. The same **guarded conditional `UPDATE`** pattern used everywhere else in this
   project (`transitionRefundIfInState`) for the PENDING→SUCCEEDED/FAILED transition.
3. BullMQ's own **job-id deduplication** — a refund job is enqueued with the refund's
   own id as its BullMQ job id, so enqueuing "the same" refund twice is a queue-level
   no-op too.

A refund is triggered two ways, both funneled through the same
`ensureRefundForPayment` function so "never create a second active refund" is
enforced in exactly one place: automatically when a `CONFIRMED` (paid) booking is
cancelled (`booking.service.cancelBooking` → `refund.service.triggerRefundForCancelledBooking`
— cancelling a `PENDING`, never-paid booking finds no `SUCCEEDED` payment and
triggers nothing), or manually via `POST /api/bookings/:id/refund` (ADMIN-only,
idempotent, primarily for retrying after a `FAILED` attempt). Cancellation itself
stays synchronous and fast; the refund's actual provider call happens asynchronously
via the same BullMQ infrastructure as booking expiry.

A genuine provider failure (Stripe declines the refund, etc.) is recorded as
terminal `FAILED` immediately — it is **not** retried automatically by BullMQ, since
blindly retrying a provider-rejected refund isn't safe by default; that's what the
admin retry endpoint is for. BullMQ's own retry/backoff instead covers *our own*
infrastructure hiccups (a transient DB/Redis blip while recording the outcome).

### Organizer booking APIs

```
GET /api/events/:eventId/bookings              (organizer of that event, or ADMIN)
GET /api/events/:eventId/bookings/:bookingId   (organizer of that event, or ADMIN)
```

Event-scoped (not a global booking-browsing endpoint), mirroring exactly how ticket
types are already nested under events — an ADMIN can still reach any event's
bookings this way without a separate global surface. Paginated, with an optional
`?status=` filter (`PENDING` | `CONFIRMED` | `CANCELLED` | `EXPIRED`).

Responses are a dedicated, privacy-safe DTO (`AttendeeBookingView`), never the raw
`Booking`/`BookingItem`/`User` models — the same idea as `toPublicUser` in the auth
domain. An organizer sees the attendee's name/email, the booking's status/total/
reference, and each line item shaped as either `{ type: "RESERVED", ticketTypeName,
seatLabel }` or `{ type: "GENERAL_ADMISSION", ticketTypeName, quantity }`. It never
includes `passwordHash`, `role`, other bookings by the same attendee, or any
payment/refund internals. A booking id that belongs to a different event returns
`404`, never leaking another event's data through a mismatched `eventId`.

### Environment variables (Phase 6 additions)

| Variable | Required? | Purpose |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | No | Real Stripe test-mode secret key; omit to use the fake provider |
| `STRIPE_WEBHOOK_SECRET` | No | Real Stripe webhook signing secret; omit to use the fake provider |
| `REDIS_URL` | No (defaults to `redis://localhost:6379`) | Only read by `npm run worker` |

## Known trade-offs / accepted risks

- `npm audit` reports vulnerabilities in Prisma's own transitive dependencies
  (`deepmerge-ts`, `mysql2` — the latter unused since this project is PostgreSQL-only).
  The suggested fix downgrades Prisma to an older line; given the low relevance of
  the attack surface (local CLI config merging, not user-facing), the current
  version was kept. Revisit when Prisma patches upstream.
- Prisma is pinned to the 6.19.3 stable line rather than the newly-released 7.x,
  which requires a driver-adapter/`prisma.config.ts` setup instead of the
  traditional `url` in `schema.prisma`. That's real added complexity not worth
  taking on for this foundation phase.
