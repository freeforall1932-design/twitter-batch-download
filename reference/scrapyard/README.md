# Scrapyard — abandoned X/Twitter media extensions (reference only)

Abandoned Chrome Web Store X-media extensions kept as **conceptual / pattern references only**
for the `extension/` project. They are not dependencies, are never shipped, and must not be
imported as black-box code.

**Policy (from docs/SESSION_HANDOFF.md and docs/WORKLIST.md):**

- Reimplement aligned behavior locally against this project's queue / parser / scheduler.
- Never import third-party login, license, activation, tier, or external API hosts
  (`apixbd.plucker.io`, ExtPay, etc.).
- Any code borrowed as a *pattern* is rewritten to fit this extension.

| Rank | Folder | Source | Use |
|---|---|---|---|
| **S** | `rank-s-plucker-xbd/` | Plucker XBD — X(Twitter) Media One-click Downloader | Live GraphQL/header intercept patterns — **partially adopted** (see `extension/injected.js` + capture bag in `background.js`). Remote license/plan gating rejected. |
| **A** | `rank-a-video-downloader/` | X/Twitter Video Downloader — Download Without Leaving X | Action-bar download UX, filename fallbacks — **partially adopted**. Good later for per-tweet "Add to queue". |
| **B** | `rank-b-x-exporter/` | X (Twitter) Exporter — Download Tweets, Followers, Media & Bookmarks | Weak UX; ExtPay licensing **ignored**. Low priority; supporting filter/batch ideas only. |

Each folder keeps the original unpacked extension as downloaded, plus the original
`comment and context.txt` notes and `HOW_TO_INSTALL.txt`.
