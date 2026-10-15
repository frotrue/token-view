# Mobile beta verification (Google Drive / GitHub sync)

Run date: 2026-10-15. Host: Windows 11, Node 24, Rust stable. Browser: installed Google Chrome via `PLAYWRIGHT_CHROMIUM_PATH`. Viewports: mobile 390 × 844 and desktop 1440 × 1000. Browser tests serve the production `dist` with Vite preview, including the generated service worker.

## Results

| Suite | Command | Result |
| --- | --- | --- |
| Frontend unit | `npm test` | 10 passed |
| Browser | `npm run test:e2e` | 36 passed (18 workflows × 2 viewports) |
| Native | `cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml` | 22 passed |
| Build | `npm run build`, `cargo build` | passed |

Measured upload size on a real 4.9 GB-log database: snapshot JSON 594 KB → **94 KB gzip** (`cargo run --release --example cloud_size -- <usage.db>`).

## Native coverage (`src-tauri/src/cloud/tests.rs`)

- Loopback sign-in: PKCE S256 challenge, `state` check (a favicon probe without state does not end the flow), code exchange with `code_verifier`, session from `id_token`, credential persisted; cancellation stops waiting.
- Token handling: Drive scope required (granular consent), refresh keeps refresh token and identity, account change rejected, `invalid_grant` signs out; status never serializes tokens or the client secret.
- Upload policy against a mock Drive: first sync creates the gzip snapshot in `appDataFolder`; unchanged content only PATCHes `checkedAt`; changed content waits for the 5-minute window unless forced; failed uploads retry with the same capture.
- Phone requests: expired requests ignored, each nonce served once, the forced upload carries `handled`.
- Shared settings: remote values applied to local UI settings without touching desktop-only keys; unpushed local edits are durable and pushed to the existing file.
- GitHub backend against a mock API: parentless commits with properties in the message, force-moved branches (422 → create), marks reuse the snapshot tree, list fetches each commit once, connection refuses public or empty repositories and bad tokens, a rejected token signs out without leaking it.
- Sanitizing: paths, raw errors, provider tokens and unknown fields stripped; windowed series cut at a UTC day boundary so the fingerprint is stable; fingerprint ignores only capture/query timestamps.

## Browser coverage (`tests/e2e/beta.spec.ts`)

| Area | Result |
| --- | --- |
| Empty onboarding, explicit sample mode on every tab, no horizontal overflow | Pass |
| Versioned JSON import/download; malformed, future and oversized files rejected | Pass |
| Legacy dashboard import; PC timezone daily totals | Pass |
| Offline app shell with imported data and local budget; no Google responses in the shell cache | Pass |
| Local deletion with confirmation | Pass |
| Client id validation (only `*.apps.googleusercontent.com`) | Pass |
| Google redirect sign-in (implicit flow, `state` verified, fragment removed), PC selection, shared settings to `tv-settings` | Pass; mocked Google |
| Stale capture during errors; PC request pending until the PC's `handled` matches the nonce | Pass; mocked Google |
| Unchanged PC advances `checkedAt` → capture time refreshes without a download | Pass; mocked Google |
| Expired token keeps data and reconnects with `login_hint` | Pass; mocked Google |
| Delayed old read cannot overwrite a budget save or its offline cache | Pass; mocked Google |
| Invalid Drive content cannot replace the validated record | Pass; mocked Google |
| Offline reload from cache; disconnect clears caches and token | Pass; mocked Google |
| Disconnect in another tab cancels a delayed download | Pass; mocked Google |
| 180-second polling pauses when hidden/offline | Pass; mocked Google |
| GitHub: connect with token, read snapshot, PC request completes on `handled`, shared settings, disconnect clears data | Pass; mocked GitHub |
| GitHub: public repository, malformed token and rejected token refused, nothing stored | Pass; mocked GitHub |

## Verification limits

Not verified here: a real GitHub repository and token, a real Google Cloud project, consent screen and publishing status, live Drive API behavior (including appDataFolder sharing between the desktop and web clients of one project), Windows Credential Manager persistence across restarts, physical iOS/Android installation, and Safari rendering.
