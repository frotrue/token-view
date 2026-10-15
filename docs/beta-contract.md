# Mobile cloud beta contract

Implementation contract for the desktop publisher, the Google Drive storage layout, and the mobile reader.

## Snapshot v1

`CloudSnapshot` is `{ schemaVersion: 1, device: { id: string, name: string }, capturedAt: number, timezone: string, dashboard: Dashboard, pricing: PricingInfo, settings: SharedSettings, live: Live, claudeHooked: boolean }`.

Times in the payload are epoch milliseconds. SharedSettings contains only `currency`, `krwRate`, `monthlyBudget`, `budgetClaude`, and `budgetCodex`. The remaining desktop preferences are never synchronized. Do not include file paths, source logs, raw error text, login credentials, or provider tokens. Project labels must not include absolute local paths. Session identifiers may be irreversibly pseudonymized. Dashboard preserves existing aggregation semantics (including 35-day fine history and 500 recent sessions).

## Google Drive (appDataFolder)

Each user's data lives in their own Drive, in the hidden per-project `appDataFolder` (scope `drive.appdata`; plus `openid email` for the account label). There is no server. All OAuth clients (desktop, web, future Android/iOS) must belong to the same Google Cloud project to share the folder.

- `tv-snapshot-<deviceId>`: gzip of the Snapshot v1 JSON, `mimeType application/gzip`. appProperties: `tv=snapshot`, `schema=1`, `enc=gzip`, `deviceId`, `deviceName` (trimmed to Drive's 124-byte key+value limit), `capturedAt` (ms, content capture), `checkedAt` (ms, last time the PC confirmed the content unchanged), optional `handled` (last request nonce served). Written only by that PC.
- `tv-request-<deviceId>`: metadata only. appProperties `tv=request`, `deviceId`, `nonce` (8–64 chars `[A-Za-z0-9_-]`), `at` (ms). Written by the phone. The PC serves each new nonce once, ignores requests older than 10 minutes, forces a live refresh and an upload, and records the nonce in `handled`.
- `tv-settings`: metadata only. appProperties `tv=settings`, the five shared settings as strings (`""` = null) and `rev`. Last writer wins; unpushed local edits win over a remote read.
- Duplicate names (concurrent creates) resolve to the newest `modifiedTime`; the PC deletes older duplicates.

## Private GitHub repository (alternative)

Same records and policy, stored as branches of a private repository the user owns, accessed with a fine-grained token (Contents: read & write on that one repository).

- Record = branch `tv-snapshot-<deviceId>` / `tv-request-<deviceId>` / `tv-settings` pointing at a single parentless commit. The commit message is the properties JSON (same keys as the Drive appProperties). The snapshot tree holds `snapshot.json.gz`; other records hold `meta.json`.
- Writes: blob → tree → commit (`parents: []`) → `PATCH git/refs/heads/<name>` with `force: true`, or `POST git/refs` when the branch does not exist yet (422/404). A properties-only update reuses the current tree. Nothing accumulates in history.
- Reads: `GET git/matching-refs/heads/tv-` once per poll; commit messages are fetched only for new commit SHAs; the snapshot via `GET contents/snapshot.json.gz?ref=<branch>` (raw).
- Connecting requires the repository to be private and non-empty. A 401 signs out (desktop) or asks for a new token (web). Disconnecting forgets the token; revoking it is done on GitHub.

### Upload policy (desktop)

- Fingerprint = SHA-256 of the payload without `capturedAt`, `dashboard.now` and every `ts` under `live`. Windowed series (`fine`, `hourly`, `limits`, `sessions`) are cut at a UTC day boundary 34 days back so the fingerprint is stable within a day.
- Changed content uploads at most every 5 minutes. Unchanged content only patches `checkedAt` every 5 minutes. A phone request or "sync now" uploads immediately.
- The reader shows `max(capturedAt, checkedAt)` as the capture time when `checkedAt` belongs to the same `capturedAt`, without re-downloading.
- Retries reuse the original capture time; errors back off up to 5 minutes and never block local collection. Uploads over 4 MiB (compressed) are refused.

## Desktop commands

`cloud_status()`, `cloud_configure({deviceName, enabled, clientId, clientSecret})`, `cloud_connect_github({repo, token})`, `cloud_sign_in()` (opens the browser; resolves after Google's loopback redirect or 3 minutes), `cloud_cancel_sign_in()`, `cloud_sign_out()` (revokes and deletes the token), `cloud_sync_now()`.

`DesktopCloudStatus`: `{ available, customClient, clientId, provider, githubRepo, enabled, deviceId, deviceName, email, authenticated, signingIn, lastUploadAt, lastCheckAt, lastUploadBytes, lastError, persistentSession }`.

The desktop uses an installed-app OAuth client (authorization code + PKCE + `127.0.0.1` loopback). The built-in client comes from `TOKEN_VIEW_GOOGLE_CLIENT_ID` / `TOKEN_VIEW_GOOGLE_CLIENT_SECRET` at build time; a user override is stored in the settings table. Tokens live only in native code and the Windows credential store, never in SQLite, status, errors or IPC. A sign-out tombstone is persisted before credential deletion. Granting sign-in without the Drive scope is rejected.

## Mobile reader

The web build uses the OAuth implicit redirect with a web client (`VITE_GOOGLE_CLIENT_ID`, or a user-entered id). Tokens last about an hour; on expiry the reader keeps showing cached data and offers a one-tap reconnect with `login_hint`. The OAuth `state` is verified and the URL fragment is removed immediately. A future native app should use PKCE with refresh tokens behind the same functions in `src/cloud/google.ts`.

The reader lists `appDataFolder` once per poll, selects one device at a time (no silent summing), downloads content only when `capturedAt` changed, validates it, and caches it in IndexedDB keyed by Google account + device. Disconnecting revokes the token and clears the cache; a change of account in another tab drops this tab's private data. Polling is every 180 seconds only while visible and online. JSON import/export and the labeled demo mode work without Google.
