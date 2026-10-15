# Mobile cloud beta browser verification

Run date: 2026-10-15 (UTC). Browser: installed Chromium 154 through Playwright. Viewports: mobile 390 × 844 and desktop 1440 × 1000. Tests serve the production `dist` with Vite preview, including the generated service worker; they do not use the development snapshot endpoint.

## Final result

The complete browser run passed **30 of 30 checks** in 36.9 seconds on frozen build `index-CCmuU4YY.js`: 15 workflows at each viewport size. No browser issues remain open from this run.

## Coverage and evidence

| Area | Verification | Result |
| --- | --- | --- |
| Empty onboarding and explicit sample mode | Fresh context has no usage data; the sample banner remains explicit across overview, limits, statistics, and settings | Pass, both viewports |
| Responsive layout | Body, document, and main content have no horizontal viewport overflow; wide data tables keep their own scroll regions | Pass, both viewports |
| JSON files | Versioned snapshot import/download round trip; legacy dashboard import; malformed JSON, unsupported version, future capture, and files above 8 MB rejected while preserving valid data | Pass, both viewports |
| PC timezone | A September 30 UTC capture with October 1 Seoul daily aggregates displays October totals and capture-day statistics | Pass, both viewports |
| Offline app shell | Installed production service worker reloads the app and imported records with the browser offline; local budget changes survive; shell caches contain no usage JSON or backend responses | Pass, both viewports |
| Local deletion | Cancel keeps records; confirmed deletion clears IndexedDB and remains cleared after reload | Pass, both viewports |
| Connection validation | Administrator/service-role keys and HTTP backend URLs are rejected before saving configuration | Pass, both viewports |
| Cloud sign-in and PC selection | Mock password auth, two separate PC snapshots, no silent combining, selected PC retained on reload | Pass, both viewports; mocked backend |
| Shared settings | Mock settings read/save RPC synchronizes only the five display/budget fields and survives reload | Pass, both viewports; mocked backend |
| Stale and pending records | Capture time and fetch time shown separately; old capture labeled; PC request remains pending until the server acknowledges that exact request; transport errors retain the last valid record | Pass, both viewports; mocked backend |
| PC clock skew and request acknowledgement | A PC capture two minutes ahead cannot fulfil a request; an acknowledgement for an older request is ignored; the matching server acknowledgement clears the pending state | Pass, both viewports; mocked backend |
| Concurrent settings read/save | A held older settings response cannot overwrite a successful budget save; the saved budget also survives an offline reload | Pass, both viewports; mocked backend |
| Untrusted remote records | Invalid newly uploaded payload cannot replace or cache over the previous validated snapshot | Pass, both viewports; mocked backend |
| Offline cloud and sign-out | Cached selected PC reloads offline; sign-out clears both cached PC records, the auth session, and the displayed budget | Pass, both viewports; mocked backend |
| Sign-out during a response | Real second tab signs out while a new snapshot response is held; releasing the response cannot restore private records | Pass, both viewports; mocked backend |
| Polling | Fake time verifies 180-second cadence, pauses while hidden/offline, and refreshes on return | Pass, both viewports; mocked backend |

The cloud fixture intercepts every request to `https://beta-test.supabase.co` and supplies authored snapshots, fake auth sessions, settings, refresh RPC responses, and refresh-request acknowledgement records. Fixture generation is independent of the application's demo data. The hidden-state polling test emits a synthetic visibility event because the single headless page remains visible; offline changes use Playwright's actual browser network emulation.

Screenshots were captured and visually inspected for onboarding, overview, limits, statistics, settings, their lower scroll areas, and a stale cloud snapshot with a pending PC request. At 390 px, the fixed bottom navigation, stacked cards, file actions, and budget inputs remain usable. Desktop screenshots show readable multi-column cards and charts. There were no observed layout blockers.

## Issues found during QA

- **Fixed and verified:** offline asset cache lookups missed JavaScript/CSS with `Vary: Origin`, leaving a blank app on reload. The worker now reads only its allowlisted static paths from the current shell cache with `ignoreVary`.
- **Fixed and verified:** initial Supabase session recovery was handled like a cross-tab account change, clearing cached records and the selected PC. Startup recovery now preserves the session's existing selection/cache.
- **Fixed and verified:** the polling timer's first tick could miss the deadline after sign-in and delay refresh for another interval. It now schedules a timeout from the last attempt's deadline and reschedules on return to an online, visible page.
- **Fixed and verified:** a future PC clock could make an existing capture look like it fulfilled a newer refresh request. Completion now requires the server's acknowledgement for the exact request.
- **Fixed and verified:** an older settings read could overwrite a concurrent successful settings save. The completed save invalidates earlier reads before updating the current record and cache.

An earlier run was discarded because concurrent rebuilds changed asset hashes while the service worker installed. Subsequent runs exposed the issues above; the final complete result used a frozen build and clean browser contexts.

## Reproducing the run

```sh
npm ci
npm run build
npm run test:e2e
```

The config uses `/usr/bin/chromium` when present. Otherwise install Playwright's browser with `npx playwright install --with-deps chromium`, or set `PLAYWRIGHT_CHROMIUM_PATH` to an installed executable. The tests start Vite preview on loopback port 4173, or reuse an existing preview there. Keep `dist` unchanged until the run finishes.

The HTML report is generated in `playwright-report/`; screenshots, failed-test traces, and contexts are in `test-results/`. These generated directories are ignored by Git.

## Verification limits

These tests verify browser behavior against local production assets and mocked cloud APIs. They do not verify a deployed Supabase project, live email/password auth, deployed SQL/RLS isolation between real users, Windows desktop publication/credential storage, PC request execution, Claude/OpenAI provider auth or APIs, physical iOS/Android installation, or Safari rendering.
