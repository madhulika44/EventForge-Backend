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
