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

## Additional note

The previous handoff document referenced branch `arena/01a03699-twitter-batch-download`, while this Arena session is on `arena/01a036a9-twitter-batch-download`. This should be corrected during documentation cleanup.
