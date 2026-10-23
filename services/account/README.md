# ezdesign-account

Accounts for ezdesign: sign-in with Google or an email and a password. A Cloudflare Worker over D1,
at `account.ezdesign.dev`.

ezdesign signs in the way a native app does (RFC 8252): the daemon opens `/authorize` with PKCE and
a loopback redirect, this service signs the person in on its own page, sends the browser back to the
loopback with a code, and the daemon trades the code at `/token` for a bearer token.

## Layout

- `src/` - the Worker. `index.ts` mounts the routes; `routes/login.ts` is the browser side,
  `routes/api.ts` the daemon side. `flow.ts` holds login requests, codes and sessions; `users.ts`
  the accounts; `google.ts` the round trip to Google; `page.ts` the sign-in page.
- `migrations/` - D1 migrations.
- `test/` - integration tests, run against a local D1 inside workerd.

## Routes

| Route | Auth | What |
| --- | --- | --- |
| `GET /authorize` | none | `client_id=ezdesign`, `response_type=code`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`. `redirect_uri` must be `http://127.0.0.1:<port>/__ezdesign/account/callback`. Sends the browser on to `/login/:id`. |
| `GET`/`POST /login/:id` | none | The sign-in page and its form (`mode` is `signin` or `signup`). Success is a 303 to the loopback with `code` and `state`. |
| `GET /login/:id/google`, `GET /google/callback` | none | The round trip to Google, bound to the browser by a cookie. |
| `POST /token` | the PKCE verifier | Form-encoded `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `redirect_uri`. `{ access_token, token_type, user: { id, email } }`. |
| `GET /v1/me` | bearer | `{ user: { id, email } }`. |
| `POST /v1/logout` | bearer | Revokes the token. |

Anything that needs a signed-in person goes behind `requireUser` (`src/auth.ts`). Errors are
`{ error: string }`.

- A login request lives 15 minutes and is spent by the first code issued from it; a code lives 60
  seconds and is good once.
- Passwords are PBKDF2-SHA256 at 100,000 iterations, the most Workers allow. Sign-in attempts are
  limited to 10 a minute per address and per email.
- A Google sign-in whose verified email matches a password account nobody verified takes that
  account over and drops its password and sessions: whoever signed up first may not own the address.

## Local development

```sh
pnpm install                  # from the repo root
cd services/account
npm run migrate:local
npm run dev                   # http://127.0.0.1:8787
```

Point a daemon at it with `EZDESIGN_ACCOUNT_URL=http://127.0.0.1:8787`. The Google button only shows
once `GOOGLE_CLIENT_SECRET` is set: put it in `.dev.vars`, and a client id that allows
`http://127.0.0.1:8787/google/callback` in `wrangler.toml`'s `[vars]`.

## First-time setup

Everything here needs a logged-in Wrangler: `npx wrangler login`.

1. **Create the D1 database** and paste its `database_id` into `wrangler.toml`.

   ```sh
   npx wrangler d1 create account
   ```

2. **Create a Google OAuth client** (Google Cloud console, APIs & Services, Credentials, OAuth
   client ID, Web application) with the redirect URI `https://account.ezdesign.dev/google/callback`.
   Put its client id in `wrangler.toml` and its secret in Wrangler:

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
   ```

3. **Migrate and deploy.**

   ```sh
   npm run migrate:production && npm run deploy:production
   ```
