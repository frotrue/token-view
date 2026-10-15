# Provider authentication and mobile limit retrieval

Reviewed 2026-10-14 against the existing native collectors in `src-tauri/src/live.rs` and current public provider documentation. No personal credentials were accessed and no authenticated provider requests were made.

## Beta decision

The mobile PWA reads Token View cloud snapshots published by Windows. It does not offer Claude/ChatGPT provider login or token entry. There is no verified public authentication-and-API combination for this PWA to read an individual's current subscription limits directly. This is a finding about the reviewed public surfaces, not a claim that private partner integrations cannot exist.

| Data | Verified collection path | Direct PWA feasibility |
| --- | --- | --- |
| Claude subscription 5-hour / weekly percentages | Claude Code statusline JSON on the user's PC | No supported third-party Claude.ai login found; use synchronized values |
| Codex / shared Work allowance | Locally authenticated Codex `account/rateLimits/read` RPC | Documented local integration; a PWA cannot run the native app-server |
| Other ChatGPT limits | Provider's own usage UI | Codex buckets do not establish all ChatGPT message, image, file, or voice limits |
| Provider service health | Public status endpoints | Separate from private account usage; does not require provider credentials |

## Claude

Claude Code documents statusline fields `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`, and each window's `resets_at` in Unix seconds. A configured local command receives these values on stdin. This is the supported input already used by Token View's statusline connection; it does not require Token View to receive OAuth credentials. Missing fields must remain unavailable rather than be interpreted as zero. Collection freshness depends on Claude Code running and producing statusline data. [Claude Code statusline documentation](https://code.claude.com/docs/en/statusline).

Anthropic's current guidance restricts third-party Claude.ai login and collection, storage, or intermediation of Claude.ai credentials/session tokens. It permits users to sign in to the unmodified Claude Code binary through Anthropic's own flow; that does not authorize a new Token View browser sign-in flow. [Authentication and credential-use guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

The existing desktop opt-in collector reads Claude Code's credential file and calls `/api/oauth/usage`. It remains existing beta behavior, but this endpoint is not a documented public integration contract in the reviewed sources. Its presence in the code does not establish supported mobile authentication, browser CORS support, a refresh-token grant, or permission to host the credentials. The mobile beta must not extend this behavior into provider token upload or browser token storage.

Claude's documented analytics APIs are organization/admin surfaces with aggregated activity, not a replacement for an individual's live 5-hour/weekly quota. The Claude Code Analytics Admin API is unavailable to individual accounts and reports daily aggregates. [Claude Code Analytics API](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api).

## Codex and ChatGPT

OpenAI documents `account/rateLimits/read` and `account/rateLimits/updated`, including multiple metered buckets, current percentages, window lengths, and reset timestamps. Managed ChatGPT login is owned by the native app-server, which stores and refreshes its credentials. Existing local/open-source applications can continue using that authentication; the documentation explicitly excludes app-server authentication for commercial or hosted services. This supports Token View's PC collector and synchronization of its returned data, not placing an authenticated app-server behind a hosted PWA. [App-server auth and rate-limit documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

Sign in with ChatGPT now has an open-source/local-app preview, so a blanket statement that third-party ChatGPT authentication does not exist would be incorrect. Its dynamic-registration flow requires an HTTP `127.0.0.1` listener, PKCE, state, nonce, and validation of issued identity/permissions. A standard hosted PWA cannot start that local server. Credentials belong in protected native or self-hosted runtime storage; OpenAI explicitly says to keep them out of browser storage. Remotely hosted applications require a separate partner process. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [credential security](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#credential-security), [preview scope](https://developers.openai.com/siwc/token-sharing-open-source).

This preview grants eligible Responses API inference. Its app-server recipe supplies the OAuth access token to a custom Responses provider with `requires_openai_auth=false`; it does not document that those tokens authorize the separate `account/rateLimits/read` surface. Reviewed scopes and routes provide no verified personal-quota read grant. Do not invent a REST quota endpoint, reuse Codex's OAuth client ID, or use ChatGPT's private backend routes with this grant. [SIWC app-server configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server), [supported inference routes](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

The website SIWC guide requires a provisioned client and backend, describes identity scopes, and is limited to selected partners. Identity sign-in alone does not grant usage access. [Website SIWC](https://developers.openai.com/siwc/website). Codex/Work allowances and regular ChatGPT file, image, and voice caps also have distinct semantics; label synchronized buckets by their actual provider/bucket rather than advertising complete ChatGPT subscription coverage. [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

## Implementation implications

- Follow [the mobile cloud beta contract](beta-contract.md): provider credentials remain native; cloud payloads contain only allowlisted usage/limit snapshots and collection timestamps.
- Keep provider authentication separate from Token View's Google Drive sync account. Connecting Google Drive does not sign into Claude or ChatGPT.
- Show the PC's capture time and stale/offline state. A mobile “request PC refresh” action depends on the collector being online; cloud polling alone cannot make provider readings current.
- Preserve nullable/missing limits and separate measured values from existing estimates. Retain Codex `limitId` buckets and returned window durations; do not assume every plan has both a five-hour and weekly limit.
- A future direct connection needs verified client eligibility, an appropriate quota-read grant/API, an approved callback/runtime model, credential handling, and provider behavior tested with an explicitly authorized test account. Until then, no direct-provider feature flag should be presented as usable.

This note changes no collector or application behavior.
