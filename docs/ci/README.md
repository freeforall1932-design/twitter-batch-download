# CI workflow (manual install required)

`extension-tests.yml` is the offline CI workflow for this repo. Arena's
GitHub App lacks the `workflows` OAuth scope, so it CANNOT push files under
`.github/workflows/` — the branch push is rejected outright. Install it via
the GitHub web UI instead:

1. Open the repo on github.com → **Add file → Create new file**.
2. Name it exactly: `.github/workflows/extension-tests.yml`
3. Paste the full contents of `docs/ci/extension-tests.yml` (this folder).
4. Commit to `main` (or to the PR branch from the web UI).

The workflow is offline-only by design: GitHub-hosted runners cannot run
real-browser MV3 extension tests (Chrome Runtime.enable timeout / Brave
SIGTRAP — 100% failure rate where tried in nh-dw-2.0). Signed-in live-X
verification stays a local manual step (docs/SESSION_HANDOFF.md §5, §9).
