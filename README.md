# Mailsluice

Self-hosted mail forwarder. Pulls new messages from external IMAP/POP accounts
and imports them into your primary Gmail mailbox (via `users.messages.import`,
so dates and headers are preserved).

A minimal clone of Google's Gmailify feature, which Google is retiring on
gmail.com. Imports new mail into your primary inbox the same way; does not
replicate every Gmailify feature (no two-way sync of replies, no outbound
sending through the source account).

Gmail is the only destination in v1. The core is destination-agnostic - adding
Outlook/Fastmail is a new class under `src/destinations/`.

## Stack

Node 22, TypeScript, Fastify, EJS, better-sqlite3, ImapFlow, `@googleapis/gmail`.
Single SQLite file, no external services.

## Run it

### Docker (default: host port 3000)

```
cp .env.example .env
./scripts/docker-run.sh --clear
```

First run prints the admin username + random password. Open
`http://localhost:3000/`.

### Docker behind Traefik

In `.env`:

```
MAILSLUICE_DOMAIN=mailsluice.example.com
```

Then:

```
./scripts/docker-run.sh --traefik --detach
```

The overlay joins the external `web` network, adds Traefik labels, drops the
host port, and sets `APP_TRUST_PROXY=1` + `APP_COOKIE_SECURE=true`. Override
`TRAEFIK_NETWORK`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`,
`MAILSLUICE_ROUTER_NAME` in `.env` if your setup differs.

### Local (no Docker)

```
npm install
cp .env.example .env
./scripts/run-local.sh --clear
```

Stop with `./scripts/run-local.sh --stop`.

## First-time Gmail setup

Log in as admin, go to **Destination**. The page walks you through the
Google Cloud console: create a project, enable Gmail API, set up Branding +
Audience + Data Access scopes, create an OAuth Web Client, paste `client_id` /
`client_secret` into the form. These are stored encrypted in SQLite, not in
`.env`.

Users then go to **Destination** -> Connect Gmail, **Sources** -> Add source.

## Configuration

All in `.env` (see `.env.example`). Minimum:

| Var                  | Notes                                                   |
| -------------------- | ------------------------------------------------------- |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` (or use `_FILE` variant)      |
| `APP_SESSION_SECRET` | `openssl rand -hex 32`                                  |

Optional: `APP_PORT`, `APP_HOST`, `APP_DATABASE_PATH`, `APP_TRUST_PROXY`,
`APP_COOKIE_SECURE`, `APP_EVENT_LOG_MAX_ROWS`,
`APP_ENCRYPTION_KEY_PREV[_FILE]`, `APP_HTTP_AUTH`,
`APP_PUBLIC_BASE_URL`, `APP_ALLOW_PRIVATE_SOURCES`.

Set `APP_HTTP_AUTH=user:password` to require browser Basic Auth in front of
every page (except `/health`). It's a moat, not a wall - hides the login page
from scanners and adds a layer on top of the regular login. Use a long random
password, and only over HTTPS.

The `_FILE` variants read the key from a file path (systemd
`LoadCredentialEncrypted`, Docker secret, etc.) instead of the env var.

## Data

Everything lives in `./data/mailsluice.db` (SQLite, WAL mode). Back up that
file. Destroying the container does not touch it.

## Development

```
npm install
npm run dev          # tsx watch
npm test             # node:test
npm run typecheck
npm run build
```

## Layout

```
src/
  auth/         login, bootstrap, password policy, change-password
  admin/        user / audit / event routes
  destinations/ factory registry + Gmail impl
  sources/      IMAP/POP CRUD + test-connection
  sync/         per-destination workers, backoff, dedup
  views/        EJS templates
  public/       static assets
  crypto.ts     AES-256-GCM v1 with AAD
  key_provider.ts / key_providers/   env + file sources; KMS later
scripts/
  run-local.sh, docker-build.sh, docker-run.sh
```

## Security notes

- Passwords: argon2id (OWASP 2024 params), transparent rehash on login.
- At rest: AES-256-GCM with per-row AAD binding (ciphertext copy-paste
  between rows won't decrypt). Key rotation supported via
  `APP_ENCRYPTION_KEY_PREV[_FILE]`.
- CSRF on every mutation. Sessions in signed cookies; regenerated on login
  and password change.
- Login rate limit: per (user, IP) 5/15min + per IP 20/15min.
- `@fastify/helmet` adds CSP, frame-ancestors, Referrer-Policy, no-sniff.
- SSRF guard blocks loopback/RFC1918/link-local as source hosts unless
  `APP_ALLOW_PRIVATE_SOURCES=1`.
- OAuth `redirect_uri` is pinned to `APP_PUBLIC_BASE_URL` when set, so Host
  header spoofing cannot shift the callback.
- Audit log (admin actions) and event log (sync activity) on separate pages.

## License

MIT. See [LICENSE](LICENSE).
