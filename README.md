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
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
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
# Set APP_TRUST_PROXY in .env to Traefik's IP on the shared Docker network.
./scripts/docker-run.sh --traefik --detach
```

`create_env.sh` writes `MAILSLUICE_DOMAIN` and `APP_PUBLIC_BASE_URL` into
`.env`. Pass `--http-auth` for a random Basic Auth gate in front.

`APP_TRUST_PROXY` must contain Traefik's trusted IP or CIDR. Use a network CIDR
only if every container on it is trusted. Numeric hop counts such as `1` are
no longer supported; replace them when upgrading from 0.2.10. The helper
checks this before stopping the old Traefik deployment.

Needs Docker Compose 2.24+ and an existing external network named `web` (or
override `TRAEFIK_NETWORK`). Other overrides: `TRAEFIK_ENTRYPOINT`,
`TRAEFIK_CERTRESOLVER`, `MAILSLUICE_ROUTER_NAME`. The overlay builds from
source; for a prebuilt image behind Traefik, write your own compose using
`ghcr.io/luskan/mailsluice:0.2`.

#### Login returns `FST_CSRF_MISSING_SECRET` after a reboot

Sessions and their CSRF secrets live in process memory. A restart signs users
out and invalidates forms already open in the browser. Open `/login` again
to obtain a fresh form and session cookie.

If a freshly loaded form also fails (including in a private window), check
the proxy address. Docker can assign Traefik a different IP after a restart.
If `APP_TRUST_PROXY` still contains the old IP, Fastify ignores
`X-Forwarded-Proto: https`. The Traefik overlay forces secure cookies, so the
session plugin then refuses to save the session or issue its cookie.

Run these read-only checks on the Docker host; the output excludes secrets:

```bash
docker inspect mailsluice --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(APP_TRUST_PROXY|APP_COOKIE_SECURE)='
docker network inspect $(docker inspect mailsluice --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}') --format '{{.Name}}: {{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}'
```

Compare `APP_TRUST_PROXY` with Traefik's address on the shared network.
Set it in `.env` to the current trusted IP, then recreate the app container
to apply the environment change (a plain `docker restart` does not apply it):

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --no-deps --force-recreate mailsluice
```

For a lasting fix, assign Traefik a stable IP on that network, or trust the
network CIDR only if every attached container is trusted. Keep
`APP_COOKIE_SECURE=true`. Afterward, load `/login` again and verify its response
sets `mailsluice.sid`. If the trusted address already matches, check that the
proxy sends `X-Forwarded-Proto: https` and that the browser returns the session
cookie on `POST /login`.

### Local (no Docker)

```
npm install
./scripts/run-local.sh --clear
```

Stop with `./scripts/run-local.sh --stop`. Needs `openssl`, `curl`, `lsof`
on PATH.

## Connecting Gmail

Log in as admin and open **Destination** for the detailed Google Cloud
setup checklist and exact URLs to copy. Set `APP_PUBLIC_BASE_URL` to your
public HTTPS address. Mailsluice provides `/oauth-info` as the application
homepage and `/privacy` as its privacy/data-use page. Both are public even
with `APP_HTTP_AUTH`; reverse-proxy authentication must also allow them.
Complete Branding, including App domain and authorized domains, then the
listed scopes and a **Web application** OAuth client. JavaScript origins
are not required. Save the client ID and secret immediately when Google
creates them; Mailsluice stores them encrypted in SQLite.

**Publish before connecting Gmail:** Google Auth Platform -> Audience ->
Publish App -> Confirm. Manually check **External / In production**.
In **Testing**, Gmail authorizations and refresh tokens expire after
**7 days**. In production removes that special Testing expiration;
tokens can still be revoked or invalidated for other reasons.
See [Google's Audience documentation](https://support.google.com/cloud/answer/15549945).

Google's [personal-use exception](https://support.google.com/cloud/answer/13464323)
allows an app for your own use or a small group of personally known users
(fewer than 100 users) to remain unverified. This is not a general exemption
for public apps with fewer than 100 users. **Google hasn't verified this app**
is an expected warning for this setup, including after publishing. For your
own installation, choose Advanced and continue if Google offers that option.
The warning does not indicate Testing mode; do not switch back to Testing
or submit for verification solely to avoid the 7-day expiration.

Then use **Connect Gmail**, followed by **Sources -> Add source**.
If Gmail was originally connected while Testing, publish first and click
**Reconnect** once to obtain fresh authorization while keeping sources and
import history. **Disconnect** removes attached sources and their history.
Mailsluice cannot detect the Google project's publishing/verification status.

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
page except `/health` and the public GET/HEAD `/oauth-info` and `/privacy`
pages. Use a long random password and only over HTTPS.

`APP_PUBLIC_BASE_URL` is recommended whenever you run behind a reverse
proxy. It pins the OAuth `redirect_uri` so a forged Host header can't shift
the callback.

`_FILE` variants read the key from a file path (Docker secrets, systemd
`LoadCredentialEncrypted`).

## Data

SQLite WAL at `./data/mailsluice.db`. To back up: stop the app first, or
copy `mailsluice.db` together with `mailsluice.db-wal` and `mailsluice.db-shm`.
Tearing down the container does not touch `./data`.

## Update

Schema migrations run on startup; your data and admin login survive an
update. Back up first if you're paranoid (see **Data** above).

### Prebuilt image

```
docker pull ghcr.io/luskan/mailsluice:0.2
docker rm -f mailsluice
docker run -d --name mailsluice \
  -p 3000:3000 \
  -v mailsluice-data:/app/data \
  --env-file .env \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --restart unless-stopped \
  ghcr.io/luskan/mailsluice:0.2
```

`:0.2` rolls forward across `0.2.x`. Pin to `:0.2.1` if you want to stay
on a specific release.

### Build from source

```
./scripts/pull.sh --rebuild
```

The helper pulls the current branch with `--ff-only`, checks for a newer Docker
base image with `build --pull`, builds the image before
stopping the old container, then recreates it in the background. `.env`,
`./data/`, admin login, and history are preserved. Commit or stash local changes
first; add `--rebase` to rebase local commits if the branch has diverged.

Traefik mode is detected from the existing container; pass `--traefik` explicitly
if that container has been removed. Run `./scripts/pull.sh` without `--rebuild`
to update only the checkout. This helper is for source/Compose installations.

### Local (no Docker)

```
git pull
npm install
./scripts/run-local.sh
```

Rebuilds `dist/` and restarts. Without `--clear`, the SQLite file in
`./data/` is kept.

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
- CSRF on every mutation. Session IDs in signed cookies; session data lives
  in process memory and is lost on restart. IDs are regenerated on login
  and password change.
- Login limit: 5 / 15min per (user, IP); 20 / 15min per IP.
- `@fastify/helmet` for CSP, frame-ancestors, Referrer-Policy, no-sniff.
- Container runs as a non-root user with a read-only root filesystem, no
  Linux capabilities, and `no-new-privileges` (Compose and the `docker run`
  examples above).
- SSRF guard rejects loopback / RFC1918 / link-local / CGNAT / multicast
  source hosts (covers `169.254.169.254` cloud-metadata) unless
  `APP_ALLOW_PRIVATE_SOURCES=1`.
- OAuth `redirect_uri` is pinned to `APP_PUBLIC_BASE_URL` when set.
- Audit log (admin actions) and event log (sync activity) on separate pages.

## License

MIT. See [LICENSE](LICENSE).
