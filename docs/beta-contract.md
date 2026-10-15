# Mobile cloud beta contract

Implementation contract for the desktop publisher, Supabase backend, and mobile reader.

## Snapshot v1

`CloudSnapshot` is `{ schemaVersion: 1, device: { id: string, name: string }, capturedAt: number, timezone: string, dashboard: Dashboard, pricing: PricingInfo, settings: SharedSettings, live: Live, claudeHooked: boolean }`.

Times in the payload are epoch milliseconds. SharedSettings contains only `currency`, `krwRate`, `monthlyBudget`, `budgetClaude`, and `budgetCodex`. The remaining desktop preferences are never synchronized. Do not include file paths, source logs, raw error text, login credentials, or provider tokens. Project labels must not include absolute local paths. Session identifiers may be irreversibly pseudonymized. Dashboard preserves existing aggregation semantics (including 35-day fine history and 500 recent sessions).

## Supabase

- `snapshots`: `user_id uuid`, `device_id uuid`, `device_name text`, `captured_at timestamptz`, `uploaded_at timestamptz`, `payload jsonb`; primary key `(user_id, device_id)`; RLS per authenticated owner. Read via REST. Publish via `publish_snapshot(p_device_id uuid, p_device_name text, p_captured_at timestamptz, p_payload jsonb)`; reject mismatched device/version, invalid/oversized payloads, timestamps far in the future, and older uploads. Identity comes from auth.uid(), never the client.
- `user_settings`: `user_id uuid` primary key, `settings jsonb`, `updated_at timestamptz`. Read via REST. Write through `save_user_settings(p_settings jsonb)` with allowlisted validated fields. Only display/budget settings.
- `refresh_requests`: `user_id uuid`, `device_id uuid`, `requested_at timestamptz`, `handled_at timestamptz` nullable; primary key `(user_id, device_id)`. `request_refresh(p_device_id uuid)` upserts a timestamp. Desktop reads pending requests and acknowledges through `acknowledge_refresh(p_device_id uuid, p_requested_at timestamptz)` only after successful refresh/publication. Requests expire after 10 minutes. Read access is owner-only. No arbitrary commands.
- All RPCs are authenticated only, set a safe search_path, and enforce auth.uid(). No service_role key in either client.
- Snapshot data and settings remain private. The frontend requires only Supabase URL + public/anon key, supplied via VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY or settings. No hosted backend is configured in this environment yet.

### RPC return values and beta bounds

- `publish_snapshot` returns the server `uploaded_at` as a timestamp string. A retry with the exact same capture, device name, and payload returns the original upload timestamp. An older capture or a changed payload at the same capture is rejected.
- `save_user_settings` returns a JSON object `{ user_id, settings, updated_at }`. All five fields are required in `p_settings`; `currency` is `USD` or `KRW`, `krwRate` is greater than zero and at most 1,000,000, and each budget is null or a number from zero to 1,000,000,000. Unknown settings fields are rejected.
- `request_refresh` returns a JSON object `{ user_id, device_id, requested_at, handled_at }`. It only targets the authenticated user's existing device. A pending request younger than 10 minutes is coalesced; a handled request younger than 60 seconds returns its existing handled row instead of creating a new command. Clients must use the returned server timestamp and handled state.
- `acknowledge_refresh` returns a boolean. It updates only the exact pending request timestamp, while younger than 10 minutes, and only after a successful snapshot upload at or after the request time. A stale, expired, already handled, or other user's request returns false.
- Snapshot JSON is limited to 4 MiB after JSONB serialization, requires schema version 1 and exact allowlisted model fields, and requires matching device ID/name and `capturedAt` within 1 ms of the RPC timestamp. Captures must be finite, at or after 1970, and at most 5 minutes ahead of server time. Device names contain 1–128 characters without surrounding whitespace or control characters. Raw live errors, unrecognized provider info fields, and absolute project paths are rejected. A database payload limit failure does not interrupt local desktop collection.
- Live info may contain only `windows`, `ts`, `planType`, `credits` (`hasCredits`, `unlimited`, optional `balance`), `resetCredits`, and `reached`. Public status page URLs are `https://status.claude.com` and `https://status.openai.com`; pricing `remoteUrl` is empty or the existing Token View pricing URL. Both clients use a publishable key (`sb_publishable_…`) or legacy `anon` JWT; secret keys (`sb_secret_…`) and JWTs whose role is `service_role` are forbidden.

## Desktop commands

Implement `cloud_status()`, `cloud_configure({url, anonKey, deviceName, enabled})`, `cloud_sign_in({email, password})`, `cloud_sign_out()`, and `cloud_sync_now()`.

Return `DesktopCloudStatus`: `{ configured: boolean, enabled: boolean, url: string, anonKey: string, deviceId: string, deviceName: string, email: string | null, authenticated: boolean, lastUploadAt: number | null, lastError: string | null, persistentSession: boolean }`.

Supabase sessions stay in native code and use Windows credential storage for persistence. Provider credentials never enter the frontend or cloud payload. Non-Windows builds may use an explicitly described memory-only session. API access/refresh tokens must not be emitted in status/errors or saved to SQLite. Persist only nonsecret cloud config in the local settings table.

The native scanner publishes after a completed scan; throttle automatic publication to at least 60 seconds, retry with backoff, and never block local collection on network failure. Reuse captured timestamps on retries; do not make stale data appear fresh. Poll pending refresh requests before a scan; force existing live refresh for a recent request; acknowledge only after its successful upload. Shared settings are pulled and merged into existing local UI settings. Keep cloud disabled until explicitly configured/signed in.

## Mobile reader

Reuse existing Dashboard/PricingInfo/Live TypeScript interfaces. Mobile reads owner-scoped snapshots and selects one device at a time; no silent summing across devices. It caches validated snapshots in IndexedDB, separated by backend/user/device. Sign out clears private data. A manual JSON import and an explicitly labeled demo mode work without a backend.

Poll every 180 seconds only while visible/online, refresh on return, deduplicate requests, and keep the last successful data during errors. Refreshing cloud data and requesting a PC refresh are distinct actions. Show capture time separately from fetch time; an old snapshot is never described as live. Direct provider retrieval is enabled only if supported auth and API behavior have been verified; do not expose provider token entry fields.

Mobile display/budget settings synchronize through user_settings. Desktop-only commands (rebuild, startup, statusline, updater, pricing recalculation) are not invoked by the browser. JSON download/import and mobile local preferences remain available offline.
