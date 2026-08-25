# Project Improvement Opinion

Prepared: 2026-08-25

## Summary

The project is already past the large-architecture stage. The most valuable next improvements should be driven by signed-in live X testing, not speculative feature work. The biggest risk is X GraphQL/header/response drift and rate-limit behavior, not the local queue scheduler.

## Recommended priorities

1. **Add Side Panel diagnostics/status**
   - Signed-in session detected: yes/no.
   - `ct0` present: yes/no.
   - `auth_token` present: yes/no.
   - Live capture warmed: yes/no.
   - Operation source: `capture` vs `bundle`.
   - Last captured operations such as `UserByScreenName`, `UserMedia`, and `TweetResultByRestId`.

2. **Add a sanitized copy-debug-report button**
   - Include target, error code, operation names, operation source, page count, found count, cursor state, and capture warm status.
   - Exclude cookies, authorization headers, CSRF tokens, and private response bodies.

3. **Make capture warm-up more deterministic**
   - Guide the user when capture is cold.
   - Avoid silently using the wrong X tab when multiple X tabs are open.
   - Surface messages such as: “Open target media page,” “Capture not warmed yet,” and “Refresh X tab, then retry.”

4. **Make discovery stop interrupt rate-limit waits**
   - Stop scan should cancel long retry/backoff waits quickly instead of waiting for the current countdown to finish.

5. **Improve live fixture workflow**
   - Replace or augment synthetic fixtures with sanitized live captures after P0 testing.
   - Consider a redaction template or helper later so live captures become regression tests.

6. **Use captured variable templates for `UserByScreenName` too**
   - `UserMedia` already benefits from captured variables.
   - `UserByScreenName` currently uses a fixed small variable shape and may be more fragile if X changes required variables/features.

7. **Improve queue grouping / scan identity**
   - Persistent queues can become confusing across multiple profile scans.
   - Future UX could include “clear current profile scan,” “queue source,” and “discovered this run.”

8. **Keep action-bar selector validation separate from Side Panel P0**
   - The Side Panel is the primary product.
   - Action-bar selector drift should not block the main batch queue unless single-tweet download is part of the release claim.

## Recommended live testing order

1. Load `extension/` unpacked.
2. Sign in to X.
3. Open a public profile `/media` page.
4. Open the Side Panel.
5. Discover with limit `20`, reposts off.
6. Confirm newest-first order, original photos, highest-bitrate MP4, unique multi-photo items, and clean termination below cap.
7. Repeat with reposts on.
8. Test stop scan, stop downloads, Side Panel reload, and extension reload.
9. Test protected, unavailable, logged-out, and rate-limited states if possible.

## Status of these recommendations (updated 2026-08-25, v3.2)

- **(1) Diagnostics / status** — partially done. The Side Panel now shows a live
  active-tab pill (route, posts on screen, pending video resolves, refresh
  warnings). The signed-in/cookie/capture-warm breakdown is still open.
- **(2) Sanitized copy-debug-report** — still open. Highest-value P1 item.
- **(3) Capture warm-up determinism** — largely superseded: capture is now
  always on with a replay buffer, so "cold capture" is far less likely. The
  multiple-X-tabs ambiguity for Remote fetch remains open.
- **(4) Stop interrupting rate-limit waits** — still open.
- **(5) Live fixture workflow** — still open; `tests/content.test.js` now gives
  live-failure regressions a home.
- **(6) Captured variables for `UserByScreenName`** — still open.
- **(7) Queue grouping / scan identity** — partially addressed via per-row
  remove and source-scoped lists.
- **(8) Action-bar validation separate from Side Panel P0** — still the right
  call; the action bar gained `Add to queue` in v3.2.

The stale-branch note previously recorded here is resolved: this session's
branch is `arena/01a03712-twitter-batch-download` and the handoff is correct.
