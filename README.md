# Mailsluice

Self-hosted IMAP/POP -> Gmail forwarder. New mail from your external accounts
lands in your primary Gmail inbox with original dates and headers intact (via
`users.messages.import`).

A small stand-in for Google's Gmailify. Inbound import only -- no two-way
reply sync, no outbound through the source account.

## Stack

Node 22, TypeScript, Fastify, EJS, better-sqlite3, ImapFlow,
`@googleapis/gmail`. SQLite under `./data`, no Postgres / Redis / queue.

## Run

### Docker (prebuilt image, no clone)

Easiest path. Pull from GitHub Container Registry:

```
mkdir mailsluice && cd mailsluice
cat > .env <<EOF
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
APP_SESSION_SECRET=$(openssl rand -hex 32)
EOF
docker run -d --name mailsluice \
  -p 3000:3000 \
  -v mailsluice-data:/app/data \
  --env-file .env \
  --restart unless-stopped \
  ghcr.io/luskan/mailsluice:0.2

# wait for the bootstrap to finish, then read the admin block
until curl -sf http://127.0.0.1:3000/health >/dev/null; do sleep 1; done
docker logs mailsluice 2>&1 | grep -A4 "FIRST-RUN ADMIN CREDENTIALS"
```

Save the printed username and password -- they're shown once. Open
`http://localhost:3000/`.

A named volume (`mailsluice-data`) is used instead of a host bind mount so
the image works the same on vanilla, snap, and rootless Docker. To back it
up: stop the container, then
`docker run --rm -v mailsluice-data:/d -v "$(pwd):/out" alpine tar czf /out/mailsluice-backup.tar.gz -C /d .`.

Tags: `0.2.1` (immutable), `0.2` (rolls forward inside 0.2.x), `latest`
(rolls forward across all releases), `sha-<short>` (per commit).

### Docker (build from source)

```
git clone https://github.com/luskan/mailsluice && cd mailsluice
./scripts/create_env.sh
./scripts/docker-run.sh --clear
```

Same admin-credential block as above. `APP_PORT` in `.env` only changes the
in-container port -- the compose file publishes `3000:3000`. Edit
`docker-compose.yml` for a different host port.

### Docker behind Traefik

```
./scripts/create_env.sh mail.example.com
./scripts/docker-run.sh --traefik --detach
```

`create_env.sh` writes `MAILSLUICE_DOMAIN` and `APP_PUBLIC_BASE_URL` into
`.env`. Pass `--http-auth` for a random Basic Auth gate in front.

Needs Docker Compose 2.24+ and an existing external network named `web` (or
override `TRAEFIK_NETWORK`). Other overrides: `TRAEFIK_ENTRYPOINT`,
`TRAEFIK_CERTRESOLVER`, `MAILSLUICE_ROUTER_NAME`. The overlay builds from
source; for a prebuilt image behind Traefik, write your own compose using
`ghcr.io/luskan/mailsluice:0.2`.

### Local (no Docker)

```
npm install
./scripts/run-local.sh --clear
```

Stop with `./scripts/run-local.sh --stop`. Needs `openssl`, `curl`, `lsof`
on PATH.

## Connecting Gmail

Log in as admin, open **Destination**. The page walks through the Google
Cloud side: new project, enable Gmail API, fill in Branding / Audience /
Data Access scopes, create an OAuth Web Client. The redirect URI to paste
into Google is shown right on the form. `client_id` and `client_secret`
go into SQLite encrypted, not into `.env`.

Then **Destination** -> Connect Gmail, **Sources** -> Add source.

## Configuration

All in `.env` (see `.env.example`). Required:

| Var                  | Notes                                              |
| -------------------- | -------------------------------------------------- |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` (or use `_FILE` variant) |
| `APP_SESSION_SECRET` | `openssl rand -hex 32`                             |

The helper scripts auto-generate both if empty.

Optional: `APP_PORT`, `APP_HOST`, `APP_DATABASE_PATH`, `APP_TRUST_PROXY`,
`APP_COOKIE_SECURE`, `APP_EVENT_LOG_MAX_ROWS`,
`APP_ENCRYPTION_KEY_PREV[_FILE]`, `APP_HTTP_AUTH`, `APP_PUBLIC_BASE_URL`,
`APP_ALLOW_PRIVATE_SOURCES`.

`APP_HTTP_AUTH=user:password` puts browser Basic Auth in front of every
page except `/health`. Use a long random password and only over HTTPS.

`APP_PUBLIC_BASE_URL` is recommended whenever you run behind a reverse
proxy. It pins the OAuth `redirect_uri` so a forged Host header can't shift
the callback.

`_FILE` variants read the key from a file path (Docker secrets, systemd
`LoadCredentialEncrypted`).

## Data

SQLite WAL at `./data/mailsluice.db`. To back up: stop the app first, or
copy `mailsluice.db` together with `mailsluice.db-wal` and `mailsluice.db-shm`.
Tearing down the container does not touch `./data`.

## Forgot the admin password

argon2id is one-way, so there's no recovery. Generate a fresh password:

```
./scripts/reset-password.sh admin            # local / dev
./scripts/reset-password.sh admin --docker   # container image must exist
```

The new password is printed once. Log in and change it. Works for any user,
not just admin.

## Development

```
npm install
npm run dev          # server + css, both watching
npm test             # node:test via tsx
npm run typecheck
npm run build
```

## Release

```
./scripts/release.sh patch    # or minor / major
```

Bumps `package.json`, commits, tags `v<x.y.z>`, and pushes. The GHCR
workflow picks up the tag and publishes a multi-arch image. The new
version shows in the app footer because `src/version.ts` reads
`package.json` at startup.

## Security notes

- Passwords: argon2id (OWASP 2024 params), transparent rehash on login.
- At rest: AES-256-GCM with per-row AAD binding -- copy-pasting ciphertext
  between rows won't decrypt. Key rotation via
  `APP_ENCRYPTION_KEY_PREV[_FILE]`.
- CSRF on every mutation. Sessions in signed cookies, regenerated on login
  and password change.
- Login limit: 5 / 15min per (user, IP); 20 / 15min per IP.
- `@fastify/helmet` for CSP, frame-ancestors, Referrer-Policy, no-sniff.
- SSRF guard rejects loopback / RFC1918 / link-local / CGNAT / multicast
  source hosts (covers `169.254.169.254` cloud-metadata) unless
  `APP_ALLOW_PRIVATE_SOURCES=1`.
- OAuth `redirect_uri` is pinned to `APP_PUBLIC_BASE_URL` when set.
- Audit log (admin actions) and event log (sync activity) on separate pages.

## License

MIT. See [LICENSE](LICENSE).
