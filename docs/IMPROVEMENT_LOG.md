# Improvement Log

## 2026-09-03 — Follow-up: archive-specific tests retargeted to `source/archive-enabled/`

The split left the archive-specific historical suites pointing at the stripped
`extension/` worker, so they could not run: `tests/archive-lib.test.js`,
`tests/pdf-builder.test.js` and `tests/zip-writer.test.js` required
`extension/lib/{archive,zipWriter,pdfBuilder}.js` — files that no longer exist —
and the archive-path tests inside `tests/downloader.test.js` and
`tests/media-kinds.test.js` ran against the v3.12 worker, which always forces
`outputFormat = "raw"` and never invokes the archive pass (8 failures total;
one "unknown format degrades to raw" test only passed by accident).

The follow-up keeps every archive test runnable and pins it to the PRESERVED
source variant instead of deleting it:

- `tests/helpers/load-background.js` gains an `extensionRoot` option (default
  `"extension"`) so a suite can load the worker + `lib/` from
  `source/archive-enabled/chrome-extension` with the exact same VM harness.
- New `tests/archive-background.test.js` (16 tests) hosts the archive-pass
  coverage moved out of the shipped-worker suites: worker data-URL
  ZIP/CBZ/PDF bytes and naming, "videos still raw + stored default" and
  unknown-format degradation, archive failure semantics, offscreen job relay,
  media-kind rules (`archivedKinds`/`effectiveGroupFormat`/
  `archiveEntryExtension`), queueStart archive warnings, mixed-post PDF→ZIP,
  `archiveGifs`/`archiveVideos`, and the offscreen GIF-entry job shape.
- `tests/downloader.test.js` keeps the raw-mode path tests (9) for the v3.12
  worker; `tests/media-kinds.test.js` keeps quality/GIF-identity/raw-GIF tests
  (5). The raw-run "warnings stay silent" assertion stayed with the shipped
  suite; its "single-format photo archive post" half moved with the archive
  suite.
- The three library suites now require
  `source/archive-enabled/chrome-extension/lib/*` and say so in their headers.

Validation: `node --test tests/*.test.js` → **168 pass / 0 fail** (~4 s;
+1 from the raw/archive warning-test split, no archive coverage lost).
`source/archive-enabled/README.md` now documents the test wiring, and the
stale shipped-build README (which still advertised ZIP/CBZ/PDF in the UI,
permissions and layout) was corrected. No `extension/` or `firefox-extension/`
file changed, so the manifest stays 3.12.0.

## 2026-09-03 — Split archive-enabled source from the stripped shipped extension

The prior archive retirement was completed physically. ZIP/CBZ/PDF runtime files (`offscreen.*`, `lib/archive.js`, `lib/zipWriter.js`, and `lib/pdfBuilder.js`) were removed from both shipped extension folders, along with the offscreen permission and archive library loads. The shipped UI and manifests now expose only separate original-resolution downloads.

For users who need the former four-format implementation as source/reference, it is preserved under `source/archive-enabled/` and is explicitly not a Load unpacked target. This keeps the production extension small and prevents stale archive code from being accidentally invoked.

The existing archive-specific tests now belong to that source variant and need a follow-up harness relocation; the production extension syntax checks pass.


## 2026-09-03 — Fetch/rescan review: do not count unacknowledged queue items

Reviewed the previous session's shallow fetch, mutation harvest, deep fetch, rescan, and queue dedupe paths. The ID/media-key/source-URL dedupe layers are correctly complementary: the content tab suppresses repeated submissions, while the worker remains authoritative across DOM, GraphQL, scroll, remote fill, and rescans. One reporting bug was found: `submitDomItems()` optimistically counted all candidates when `safeSend()` returned no response, including an invalidated extension context or rejected worker message. That could make fetch/rescan status claim media was listed when it was not.

Fixed in both browser ports to count only a numeric `addedCount` acknowledgement; missing responses now contribute zero. Existing accepted rows, duplicate suppression, clean-slate rescans, and downloaded-item explanations are unchanged. Syntax checks and the full **167-test** suite pass.


## 2026-09-03 — v3.12 archive-output retirement and original-resolution downloads

A codebase review confirmed that the per-post ZIP/CBZ/PDF path added substantial worker/offscreen/archive plumbing, UI state, and warning logic for a feature no longer wanted. The download purpose is now deliberately simpler: every selected item is saved as its own file. Queue startup forces `outputFormat` to `raw`, queue processing no longer invokes the archive pass, and the UI format controls now expose only separate original-resolution files. The manifests are v3.12.0.

The existing media resolver remains responsible for quality: photo URLs force X's `name=orig`, while video variants select the highest bitrate. GIFs retain their existing real-GIF conversion preference when available, with MP4 fallback on conversion failure. Duplicate URL/byte verification and per-user folders remain unchanged. Archive implementation files and offline archive tests are retained temporarily as isolated repository test/compatibility material, but are no longer loaded or reachable by the shipped queue UI.

Validation: JavaScript syntax checks pass and the full offline suite remains **167 pass / 0 fail**. Live Chrome output verification is still required.


## 2026-09-03 — Post-v3.11 code review: unknown author could create a fake user folder

A review of the v3.11 changes found one misalignment that the existing tests did not cover. `namingFieldsForItem()` used the literal `"unknown"` when a queue item had naming metadata but no author. `buildRawMediaPath()` then treated that as a real user and produced `XMedia/unknown/<post>/...`, contradicting the v3.11 rule that missing authors omit the user segment and never create an `unknown` bucket.

Fixed in both `extension/background.js` and the Firefox port: absent authors now remain an empty template field, so the naming engine falls back to `XMedia/<post>/...`. This preserves the existing legacy-row path handling and does not alter discovery error labels or filename fallbacks that legitimately use `unknown`. Syntax checks pass and the full suite remains **167 pass / 0 fail**.

Still open: live Chrome output review is required before declaring the random-name issue or per-user-folder behavior verified.


Chronological implementation record for X Media Downloader.

## 2026-09-03 — v3.11 per-user folders in the master folder + random-naming flagged PENDING REVIEW

**Branch:** `arena/01a0667d-twitter-batch-download` · **Manifest 3.10.0 → 3.11.0** ·
**Tests 164 → 167** (+3) · **Committed, NOT pushed/PR'd — pending the user's
review of the output** (per the session instruction that the random-naming
result stays pending review).

**Session input (verbatim intent):** the extension's own master folder
(`XMedia`) should contain **one folder per user** the media is sourced from —
`XMedia/<user>/<post name>/001.ext` — so all of a user's batch-archived media
lives together; media from different sources (home timeline, profile, `/media`
page) of the same user lands in the same folder (which doubles as dedupe);
when a folder is impossible (ZIP/CBZ/PDF archives) the username must at least
appear in the file name; and the **random/"garbled" file name problem goes on
the work list as PENDING REVIEW — NOT fixed until the user tests and
confirms**.

### Part 0 — random file names: PENDING REVIEW, root cause UNCONFIRMED

What v3.6.3/v3.10 already did (deterministic fallback ladder, bidi/format
control strip, byte+URL save-time verification) is **not** being claimed as
the fix — offline tests cannot reproduce the live symptom, so the root cause
remains unconfirmed. The user's instruction is explicit: it goes on the work
list as **pending review** and may only be closed after a real-browser test
confirms the names are clean. Remaining suspect if it still garbles:
`conflictAction:"uniquify"` (Chrome's `(1)`-suffix) plus whatever live post
shape feeds `makePostBaseName`. See `docs/WORKLIST.md` → P0 → "Random file
name / garbled name — ⚠ PENDING REVIEW".

### Part 1 — per-user folders (new default layout)

`lib/naming.js`:

- `DEFAULT_USER_FOLDERS = true`.
- `userFolderName(fields)` — strips a leading `@`, trims, sanitizes to ONE
  segment (an odd/malicious handle can never create nested folders); empty
  handle → `""`, and the builders fall back to the master-folder-root layout
  instead of an "unknown" bucket.
- `baseNamesUser(base, user)` — case-insensitive exact or `"user "` prefix
  match, so a `{user}`-template base (`nasa - Hello world - 111`) is never
  doubled to `nasa - nasa - …` by the forced prefix.
- `buildRawMediaPath` now builds `<master>/<user>/<base>/NNN.ext`
  (`XMedia/nasa/nasa - Hello world - 111/001.jpg`) unless
  `userFolders === false` (restores `XMedia/<base>/NNN.ext`); `rawMasterFolder: ""`
  still returns the legacy flat filename untouched.
- `buildArchiveFilename` forces the username into the name whenever the
  template would omit `{user}`: `{id}` → `nasa - 111.cbz`, while
  `{user} - …` stays as-is. Archives are saved by an anchor click whose
  `download` attribute cannot carry folders, so the *name* is the only
  differentiator — this is the user's "when folders are impossible" rule.

`background.js`:

- `OUTPUT_SETTINGS_DEFAULTS.userFolders = true`, normalization
  `merged.userFolders = merged.userFolders !== false`.
- `rawPathForItem`: legacy rows (no naming metadata) read the author directly
  from `item.author` (NOT `namingFieldsForItem`, which would have invented an
  "unknown" bucket); user segment omitted when `userFolders:false` or no
  author.
- Archive naming call passes `userFolders` through.

`sidepanel.js` / `sidepanel.html` (both ports):

- New **One folder per user (XMedia/<user>/…)** checkbox in Output settings,
  default checked, persisted to `storage.sync.userFolders`, live preview
  shows `Downloads/XMedia/nasa/<post>/001.jpg` (archive preview shows the
  forced username too).

### Part 2 — "doubles as dedupe"

The same user's media found on the home timeline, a profile and its `/media`
page now shares ONE folder (per-user segment = owning post's author, and
repost/quote attribution is already resolved upstream), so even a repeat
listing of the same media becomes visibly the same path — on top of the
v3.10 byte + source-URL verification, which is unchanged.

### Tests + validation

- `tests/naming.test.js` — rewritten expectations for the per-user layout;
  new `userFolderName` and default-ON / toggle-OFF / no-author cases; archive
  username-forcing (`{id}` → `nasa - 111.cbz`) + `userFolders:false` restore.
- `tests/downloader.test.js` — per-user path for real worker runs; new test:
  media from two DIFFERENT users lands in separate user folders; new test:
  `userFolders:false` restores the pre-v3.11 master layout.
- `tests/media-kinds.test.js` — path assertions updated.
- Legacy flat-path expectations for `rawMasterFolder: ""` kept byte-for-byte.
- Full suite: **167 pass / 0 fail**.
- `firefox-extension/` re-synced (`lib/naming.js`, `background.js`,
  `sidepanel.js`, `sidepanel.html`; `content.js` keeps its intentional
  MAIN-world injection shim).

### Still open (deliberate)

- **Random-name issue: pending review — do not close until the user tests.**
- Live spot-check of the per-user layout (WORKLIST P0 v3.11 section) and the
  Firefox about:debugging master-folder-subpath check.
- No release zip cut for v3.11 yet (`releases/x-media-downloader-v3.10.0-ci.zip`
  is stale); cut + offline-verify after the user confirms the layout.

## 2026-09-03 — v3.10 byte-identical + source-URL duplicate verification (no more double saves under renamed files)

**Branch:** `arena/01a0667d-twitter-batch-download` · **Manifest 3.9.0 → 3.10.0** ·
**Tests 150 → 164** (+8 dedupe-pipeline, +5 dedupe unit, +1 naming — net +14 in the
offline suite)

**Session input (verbatim intent):** "The file naming still resulted in garbled
random word and number text and then if that were to happen duplicate would
occur due to different name but byte identical from same post url address
happen can you also look into implementing that 2 verification like byte
identical and url source to avoid duplications."

Two things were asked: (1) the file-name fallback must never produce random
"garbled word + number" text again, and (2) before saving a file, verify it
against what was already downloaded by **byte content** and by **source URL**
so a byte-identical file that ends up under a different name (Chrome uniquify,
fallback rungs, size variants, CDN mirrors) is never saved a second time.

### Part 1 — naming: already deterministic, closed the two remaining leak paths

The v3.6.3 pass already removed the random `media_<timestamp>` fallback
(`buildFallbackFilenames` now uses a deterministic `x-media/download_<stem>`
ladder). This pass closed the two paths that could still scramble a name:

- `background.js sanitizeFilePart` and `content.js sanitizeFilename` (the
  legacy flat `x-media/…` naming used when the master folder is OFF) now strip
  the same invisible bidi/format controls `lib/naming.js` strips
  (U+200B/200E/200F/202A-202E/2066-2069/FEFF), so mirror/RTL post text cannot
  render as scrambled characters in the file name.
- Duplicates are now *prevented* rather than uniquified away, so Chrome's
  `(1)` / `(2)` suffixes (the "random word and number" aftermath of a re-save)
  no longer appear for the same media.

### Part 2 — the two verifications (`lib/dedupe.js`)

New shared `lib/dedupe.js` (UMD → `XDLDedupe`, loaded by background.js /
offscreen.html / tests — no npm, no crypto.subtle dependency):

| Check | Identity | Catches |
|---|---|---|
| **Source URL** | `canonicalSourceUrl()` = scheme + host + path (delivery params `name`/`format`/`v` stripped, host case + default ports normalized) | the same media address arriving with different query strings, or re-listed after the queue was cleared |
| **Byte-identical** | Streaming SHA-256 of the actual bytes (incremental `Sha256`, chunked via `response.body.getReader()`, 512 MB bound — large videos are never held in memory) | different URLs / mirrors / size variants carrying byte-identical content |

**Record store** — the legacy `downloadedMediaIdsV1` (ids only) is kept and
stays in sync; a new `downloadedMediaRecordsV1` holds
`{ id, mediaKey, url, urlKey, hash, size, filename, at }` with in-memory
indexes by URL key, hash and mediaKey (capped 20 k, pruned like the old list).
**Reset downloaded history** clears both stores.

**Where the checks run:**

- `mergeQueueItems` — the canonical URL is a third identity alongside `id` and
  `mediaKey`, so two rows carrying the same media address collapse at list
  time even when the old items lack a `mediaKey`; the same URL key is also
  checked against the downloaded-record store (`alreadyDownloadedUrls`) for
  "Skip already downloaded".
- `downloadFile` — before `chrome.downloads.download`, the source URL is
  checked first (zero network), then the bytes are streamed and SHA-256'd; a
  hash hit (persisted or in-flight `pendingDigests`) skips the download with
  `{ skipped: true, reason: "duplicate_url" | "duplicate_bytes" }` and marks
  the queue row `completed · duplicate`. A verification failure (offline,
  huge/CORS-blocked fetch) degrades to the historical direct download — dedupe
  is best-effort and never loses a file.
- Completion — `chrome.downloads.onChanged` (queue rows) and a pending-record
  map (direct one-click saves, which have no queue item) write the SHA-256 +
  canonical URL + real saved filename into the record store, so the NEXT time
  the same media is listed it is caught by URL or bytes even after clearing
  the list.
- Archive pass — before assembling, if every media item of a post is already
  verified, the whole ZIP/CBZ/PDF group is skipped (no re-save). On success,
  each entry's digest AND the assembled archive's digest are recorded
  (offscreen and worker fallback both return them).

**Output settings** — new `verifyDuplicates` toggle (default ON) in the Side
Panel Output settings card ("Skip duplicates (byte compare + source URL)");
the queue pass, direct saves and the archive pre-check all respect it.

**Live-X caveats:** the digest path fetches the media URL once before the
download (streamed, so memory-safe) — a deliberate second network pass that
only buys the byte check; `verifyDuplicates` can be switched off. Real-browser
verification still pending (WORKLIST P0 items 12/14).

**Deliverables:** `extension/lib/dedupe.js` + `firefox-extension/lib/dedupe.js`
(byte-identical), background/offscreen/content/sidepanel changes mirrored to
the Firefox port, `offscreen.html` loads `lib/dedupe.js`, manifest
3.9.0 → 3.10.0 in both ports, regression + pipeline tests
(`tests/dedupe.test.js`, `tests/dedupe-pipeline.test.js`, +2 in
`tests/background.test.js`), release zip re-cut.

## 2026-09-03 — v3.9 virtualization-proof capture (posts that leave the DOM are no longer lost)

**Branch:** `arena/01a065c5-twitter-batch-download` · **Manifest 3.8.0 → 3.9.0** ·
**Tests 140 → 150**

**Session input (verbatim intent):** "Don't forget to add function that filter the
same post will not be added into list so there won't be duplication when it's
rescan or listen fetch when I scroll the website normally also did the previous
fetch already fill the gap of not adding the existing post into the list since if
I scroll and the page load only the 'new' post was added the existing post before
that was not added and not listed at all."

Two questions in one: *is dedupe airtight?* and *did the earlier work already fix
the "only new posts get listed" gap?* The answers turned out to be **yes** and
**no** — and the second one was a real, measurable data-loss bug.

### Part 1 — dedupe was already airtight (proved, not assumed)

Three layers already existed and each is now pinned by a test:

| Layer | Key | Catches |
|---|---|---|
| content.js `listedMediaIds` / `listedMediaKeys` | `tweetId-mediaKey`, CDN leaf | re-sending a post this tab already listed (every scan, every harvest, every rescan) |
| content.js per-article `seenUrls` + `mediaEntryToItem` dedupe context | URL / id+key | the same photo twice inside one post, and GraphQL items vs DOM items |
| background `mergeQueueItems` | `knownIds` **and** `knownKeys` across the whole live queue | the same media arriving from the DOM *and* from GraphQL with different id shapes, and — since v3.7 — from the scroll list *and* the remote fill |

Measured across every harness configuration below: **0 duplicate ids**. New tests:
`harvesting the same post twice lists it exactly once`, `the same photo at
different sizes lists once` (X swaps `name=small` → `900x900` → `orig`; the CDN
leaf is the identity, not the query string), `a rescan after a rescan adds nothing
new`, `the same media is one row across the scroll and remote lists`,
`queueRemove drops several rows at once`, `a removed row is allowed back, and says
why when it is not`.

### Part 2 — the gap was real: capture was scan-only, and X virtualizes

`scanVisibleMedia()` reads `article[data-testid="tweet"]` **from the live DOM**,
driven by a coalesced 150 ms MutationObserver scan plus a 2.5 s interval scan. X
removes articles that scroll off-screen, so a post inserted *and* removed between
two scans was never in the DOM at any instant a scan ran — it was never listed at
all. That is precisely the reported symptom: the newly rendered posts at the
bottom got added, the ones that had already scrolled past did not.

**Measured** (throwaway jsdom harness, 120-post fake timeline = 103 photo posts /
207 photos + 17 video posts, articles trimmed to a fixed window as new ones
arrive, so nothing is in the DOM for long):

| Scroll pattern | Photos listed **before** | **after** | Unique photo posts | Videos | Duplicate ids |
|---|---|---|---|---|---|
| window 20, batch/300 ms (normal) | — | **207 / 207** | **103 / 103** | 17 / 17 | 0 |
| window 6, batch/40 ms (fast auto-scroll) | **81** | **204** | **39 → 101** | **1 → 17** | 0 |
| window 3, batch/10 ms (extreme) | — | 199 | 99 | 17 | 0 |

So on a fast pass roughly **60% of the media was being silently dropped**, and
**16 of 17 videos** with it. The GraphQL replay path cushions this in real use
(a timeline response lists its posts whether or not they are still rendered), but
it cannot cover a view X served from cache without a network call — which is
exactly the case v3.7's per-post video resolve was added for.

### The fix — harvest the mutation records themselves

`harvestMutationArticles(mutations)` runs inside the MutationObserver callback,
before the coalesced scan is even scheduled, and reads articles out of
**`addedNodes` and `removedNodes`**:

- `addedNodes` catches a post the instant it arrives — earlier than any scan, and
  `img.src` is already the CDN URL even before the image decodes.
- `removedNodes` is the guaranteed last chance, and the reason this works even in
  the hardest case: X (or a fast auto-scroll) can insert and trim in the **same
  task**, so the node is never in the document at any point a scan could observe.
  A mutation record still holds it, and a detached subtree stays fully queryable.
- Containers are walked (`node.querySelectorAll`) and non-element nodes skipped,
  so a fragment of ten articles is one harvest and a whitespace text node cannot
  throw.

It cannot create duplicates: `makeDomQueueItems` marks `listedMediaIds` /
`listedMediaKeys` as it builds each item, so an article harvested on the way in
and again on the way out lists once — and the worker's id+mediaKey dedupe is the
second line of defence. `submitDomItems()` was factored out of `scanVisibleMedia`
so the harvest and the scan share one submission path and their counting, status
text and dock refresh cannot drift apart.

**Videos came along for free, and they were the bigger win.** A harvested video
post has no usable direct URL, so it goes into `pendingVideoTweets` for the
bounded per-post resolve. Before this change a video post that virtualized away
was never even *queued* for resolving, which is why the fast-scroll run listed 1
video instead of 17. The harness confirms all 17 now resolve (`pendingVideos`
drains 12 → 6 → 0, 15 `getTweetMedia` calls + 2 from the replay buffer).

### Two harness artifacts I fixed instead of "fixing" the extension

Both looked like extension bugs and neither was:

1. The fake page built tweet ids as `1800000000000000000 + index`, which is past
   `Number.MAX_SAFE_INTEGER` — every post collapsed to one id, so "unique photo
   posts" read 1. Base lowered to `1800000000000000`.
2. The fake `getTweetMedia` returned `…/720x1280/fake.mp4` for **every** video, so
   all 17 shared the media key `fake` and correctly deduped into one row. Real X
   leaves are unique per video, so the fake was wrong, not the dedupe.

The tempting "fix" — stop deduping videos by media key — would have made reposted
and quoted videos list twice. **Do not weaken production dedupe to satisfy an
unrealistic fixture**; fix the fixture. (Recorded because the measurement was
misleading for a moment and the wrong conclusion was one edit away.)

### Small honesty fix found on the way

`scrollRescan` answered `rescanning: true` even when it refused a second
concurrent rescan, so the panel would claim work that was not happening. The
handler now reports `ok: false` + the guard's reason. Pinned by
`a rescan after a rescan adds nothing new`.

### Validation

- `node --test tests/*.test.js` → **150 pass / 0 fail** (+10). The test shim
  gained `emitMutations(records)` (delivers `{addedNodes, removedNodes}` to every
  observing MutationObserver), `nodeType: 1`, `matches()` and `remove()` on its
  elements — the harvest path reads all four.
- Real-DOM jsdom harness (throwaway, NOT committed): the three scroll patterns in
  the table above, plus re-runs of the interactive dock smoke, the rescan/restore
  smoke and the full hybrid deep fetch — `shallow(15) → scroll → discoveryStart
  @nasa → 24 media found → "Fetch complete — 15 listed from this tab. @nasa
  silent fill: 24 media found → Remote fetch tab."` All zero errors.
- `node --check` on every shipped script in both folders; `firefox-extension/`
  re-synced (diff back to exactly the 17 + 55 pre-existing compat lines); both
  manifests **3.9.0**; `releases/x-media-downloader-v3.9.0.zip` cut and verified.

### Still open (live X)

- One signed-in pass of a **fast** auto-scroll on a long profile: the count in the
  panel should now match what the timeline actually contained. Compare against
  the post count X shows on the profile's `/media` tab — that is the only ground
  truth available.
- Confirm the harvest does not list **placeholder/skeleton** articles as media on
  a real timeline (they yield no items in the harness because they have no
  `tweetPhoto`/`videoPlayer` node, but real X skeletons are worth one look).
- Watch CPU on a very long scroll: the harvest runs per mutation batch. It is
  bounded by `listedMediaIds` (each article yields items at most once) but has
  never been profiled against a real 1000-post timeline.
- Deliberately NOT done: no `scroll`-event listener (mutation records already
  fire on every virtualization change, and a scroll handler would double the
  work), and no change to the 150 ms coalescing or the 2.5 s interval scan.

## 2026-09-03 — v3.8 Rescan restores deleted rows (+ Remove selected)

**Branch:** `arena/01a065c5-twitter-batch-download` · **Manifest 3.7.0 → 3.8.0** ·
**Tests 135 → 140**

**Session input (verbatim intent):** "Can you also add rescan function it's like
fetch but re adding the post into the list say I delete the list then I'll press
fetch or make a new button and it will rescan the available post into my queue
list that I can pick which one to delete manually."

### Diagnosis — Rescan already existed and still could not do this

v3.7 shipped a **Rescan tab** button wired to `scrollRescan`, so the button the
user asked for was already there — but pressing it after deleting rows did
*nothing*, which is why it read as missing. Capture keeps a per-tab memory of
what it has already sent (`listedMediaIds`, `listedMediaKeys`,
`resolvedVideoTweets`) so a scan that runs on every DOM mutation does not
re-post the whole timeline each time. That memory is a **performance guard with
no expiry**: it lived for the tab's lifetime and had no way to be cleared from
the UI. The worker side was never the problem — `mergeQueueItems` dedupes
against `state.items` only, so a row the user removed was always welcome back.
The block was entirely in the content script.

`lastReplaySeq` had the same shape of problem: v3.7 made replay incremental, so
an explicit rescan only asked for responses *newer* than the last one handled.
X virtualizes timelines — posts that scrolled out of the DOM exist **only** in
the MAIN-world replay buffer — so an incremental rescan could not restore them
even with the dedupe sets cleared.

### What changed

1. **`forgetListedMedia()` (content.js)** clears both dedupe sets, the video
   resolve sets and attempt budget, and resets `lastReplaySeq` to 0 so the whole
   buffer is re-delivered. Called by exactly two things: **Rescan tab** and the
   start of a **deep fetch** (dock button or panel `Fetch media`) — the user
   described both ("I delete the list then I'll press fetch"). Automatic passes
   (load, route change) deliberately stay incremental; a busy timeline would
   otherwise re-clone ~8 MB of buffered GraphQL on every mutation tick.
   **Rule: automatic passes are incremental, explicit clicks start clean.**
2. **`shallowFetchPass(reason, { fresh })`** carries the flag, so the same code
   path serves both behaviours instead of a second scan implementation.
3. **`startRescan()` + `rescanNote()`** — the rescan is async (video posts can
   take seconds to resolve) so the handler answers immediately with
   `rescanning: true` and the panel's existing 1.5 s status poll replaces the
   hint with the outcome. The note always states a result, including the
   uninteresting ones: `Rescan — 15 media items re-listed into the queue.`,
   `Rescan — nothing new; the items already in the queue are unchanged.`, or
   `Rescan — nothing re-listed: N items are already downloaded. Untick "Skip
   already downloaded" to list them again.` Silence after a click is what makes
   a working feature look broken.
4. **`skippedDownloaded` reporting (background.js)** — `mergeQueueItems` now
   returns `{ added, skippedDownloaded }` instead of a bare count, propagated
   through `addQueueItems`, the `queueAdd` response and the
   `localTimelineCapture` response. "Nothing came back" previously could not
   distinguish *already in your list* (fine) from *held back by a setting*
   (actionable).
5. **`Remove selected` (Side Panel)** — the other half of "pick which one to
   delete manually". Ticking rows only fed **Download selected** before; the new
   button sends the existing `queueRemove` with an `ids` array (the worker
   already accepted it — no new command, so the contract test stays green).
   Confirm-guarded, and its copy says files on disk are untouched and Rescan
   brings rows back.
6. **Panel busy state** — `rescanning` disables Fetch/Auto-scroll/Rescan while a
   pass runs but leaves **Stop** disabled: a rescan is a short read-only pass
   with nothing to cancel, and offering a Stop that does nothing is worse than
   not offering one. The status pill gained a `Re-listing this tab` state.

### A bug the first implementation had (kept as a lesson)

The first cut kept one shared `passTally` object that each pass zeroed at its
start. It reported "nothing new" immediately after re-listing a whole page: an
automatic load pass (`armLoadFetch()` fires at 900/2200/4000 ms) landed inside
the rescan's `await sleep()` and wiped the numbers before the note was written.
Overlapping passes are normal, not exotic — the fix is that the counters are
**cumulative and never reset**, and each pass reports the delta between its own
start and end snapshots. Same reason a rescan now records its outcome in its own
`lastRescan` field rather than in `lastPass` (which honestly means "whatever pass
ran most recently", and that is usually not the rescan).

### Validation

- `node --test tests/*.test.js` → **140 pass / 0 fail** (+5 new, 1 rewritten).
  New: rescan re-lists deleted rows (same ids come back), rescan asks for the
  whole replay buffer (`since: 0`), Fetch media also starts clean, a rescan that
  adds nothing names the setting that held items back (`lastRescan` record
  included), a rescan that restores says how many. The v3.7 incremental-replay
  test was **rewritten** to drive a *route change* instead of a rescan — the
  incremental property belongs to automatic passes now, and asserting it through
  `scrollRescan` would have pinned the wrong behaviour.
- `tests/content.test.js` shim gained `setQueueResponder(fn)` so a test can stand
  in for the worker's dedupe/skip decision (`addedCount: 0` + `skippedDownloaded`)
  instead of the optimistic "takes everything" default.
- **Real-DOM smoke (throwaway, NOT committed):** the harness fake worker was
  corrected to dedupe against its live queue (it used a permanent `seen` set, so
  it simulated the *old* behaviour and could never have shown this bug). Running
  the real `content.js` + `sidepanel.js` in jsdom: load lists 15 with no
  scrolling → **Clear list** → Rescan restores all 15 with identical ids →
  a second rescan reports "nothing new" and creates no duplicates → delete one
  row → rescan restores exactly 1 → dock **Fetch media** after a clear re-lists
  15 → panel renders 3 seeded rows, ticking one enables **Remove 1 selected**,
  clicking removes exactly that row and leaves the other two. Zero runtime
  errors.
- `dbg2.js` re-run to confirm no regression in the v3.7 hybrid flow:
  shallow(15) → scroll → `discoveryStart @nasa` → 24 media found →
  `Fetch complete — 15 listed from this tab. @nasa silent fill: 24 media found →
  Remote fetch tab.`
- `node --check` on every shipped script in both folders; `firefox-extension/`
  re-synced (sidepanel.js/html/css/injected.js copied — identical at HEAD;
  content.js rebuilt as its compat prefix + shared body; background.js re-patched
  because it carries intentional `_executeScriptCompat` swaps). Remaining diff is
  exactly the pre-existing 55 + 17 compat lines. Both manifests **3.8.0**;
  `releases/x-media-downloader-v3.8.0.zip` re-cut and offline-verified.

### Still open (live X)

- One signed-in pass: delete rows from the queue, press **Rescan tab**, confirm
  they return on a real profile (including posts scrolled out of view, which only
  exist in the replay buffer — the 40-entry / ~8 MB bound caps how far back that
  reaches). Confirm **Remove selected** on a multi-selection and that a rescan
  during a running fetch is refused cleanly rather than racing it.
- Deliberately NOT done: no "undo remove", no trash/history of removed rows, and
  no change to how the two lists stay separate. Rescan is the undo.

## 2026-09-03 — v3.7 Fetch button: auto shallow fetch on tab open, in-page Fetch dock, hybrid deep fetch

**Branch:** `arena/01a065c5-twitter-batch-download` · **Manifest 3.6.3 → 3.7.0** ·
**Tests 125 → 135**

**Session input (verbatim intent):** "when I open new tab into someone profile it
doesn't automatically fetch until I scroll down and it load — can you add fetch
button, look up my other repo rule34 one, there's already deployed fetch function
although it's broken, or just make it from scratch specifically for Twitter/x
website. This button should trigger automatic fetch as if I was scrolling and the
page load. Or should I just reload the page again to trigger my extension? Can you
look up the logic code in extension and see if there's any missing logic or broken
code after previous session."

Decisions the user made up front (asked before writing code): the button lives
**both** in-page and in the Side Panel; a **shallow** fetch fires by itself on tab
open/route change while the deep one stays a click; and the deep fetch is
**hybrid** — scroll first, then silently page the profile.

### Diagnosis — why a new profile tab looked dead until you scrolled

Capture has been always-on since v3.2, but it was purely **reactive**: it listed
whatever X had already rendered or already fetched, and nothing in the extension
ever made X load *more*. X renders roughly one screenful of a profile and only
requests the next batch when the viewport approaches the bottom, so a freshly
opened tab legitimately had nothing more to give — the only driver was the Side
Panel's **Start auto-scroll**, which requires the panel to be open and attached to
that tab. Open a profile in a new tab without the panel and nothing ever scrolls.

Four real defects made that worse (all found in this audit, all fixed below):
a dead extension context wedged the video resolver forever, a route change only
ran two of its three intended scans, one failed video resolve blacklisted that
post for the rest of the tab's life, and a replay re-cloned the entire buffered
GraphQL payload across worlds every time.

### Sister repo check — `freeforall1932-design/rule34video`

Read its deployed fetch: `panel-queue.js startCrawl()` →
`adapter.describe(route)` (learn total pages) → `adapter.fetchPage(route, page)`
per page over a `1-99` / `all` range, with `videoAdapter.fetchText()` scraping
paginated HTML and `worldAdapter.request()` POSTing a JSON search API — i.e. a
**remote paginated crawler**, not a scroll driver. That pattern does not port to
X (no paginated HTML listings), but this repo already has its X-native twin:
`background.js runProfileDiscovery()` cursor-pages `UserMedia` GraphQL with
live-captured query IDs/features. So instead of importing the rule34 code, v3.7
**reuses the existing discovery engine** as the second phase of the new deep
fetch — the rule34 idea, expressed in the only way X allows.

### What was built

1. **Two-level fetch in `content.js`.**
   - `shallowFetchPass()` — no page movement: `requestReplay()` (pull whatever
     GraphQL the tab already buffered), `scanVisibleMedia()` (DOM photos +
     queue video posts), then await the rate-bounded per-post video resolve.
     Runs **by itself** on load (`shallowFetchPass("load")` + `armLoadFetch()`
     at 900/2200/4000 ms) and on every SPA route change. This is the piece a
     new profile tab was missing.
   - `startDeepFetch()` — shallow → `autoScrollLoop()` (the existing,
     live-tested engine) → `runRemoteFill()`. Click-only, never automatic.
2. **In-page Fetch dock** (`.xdl-fetch-dock`, bottom-right) replacing the
   auto-scroll-only badge: one widget that starts a fetch, shows the phase
   (`Reading this view` / `Scrolling the timeline` / `Silently fetching @handle`)
   with a live listed-count, turns its main button into **Stop** while running,
   and has an **×** to dismiss it for that tab. A *running* fetch always shows
   the dock even when the button is switched off, so the user can never lose
   control of a tab the extension is scrolling.
3. **Silent gap-fill (`runRemoteFill`).** After the scroll, the profile handle
   is read from the URL (`remoteFillTarget()` — profiles and `/media`,
   `/with_replies`, `/highlights` only; never a single post, never `home`/
   `search`/`i`) and `discoveryStart` is sent to the worker with the panel's own
   limit/repost/quoted settings. The run is polled (`discoveryGet`, 1 s) so the
   dock shows progress, and Stop sends `discoveryStop`. Rows land in the
   **Remote fetch** list — the two lists stay separate by standing decision.
4. **Side Panel Scroll-capture card:** `Fetch media` (primary), `Stop`,
   `Auto-scroll only`, `Rescan tab`, plus two switches — **Then fetch the rest
   silently** (`deepFetchRemote`) and **Show the Fetch button on X pages**
   (`showFetchButton`) — and a **Reload tab** button that appears in the status
   pill when the active X tab has no live content script. The status pill now
   reports the fetch phase; `scrollStatus` grew `fetching`, `fetchPhase`,
   `fetchNote`, `fetchTarget`, `deepFetchRemote`, `showFetchButton`,
   `dockHidden`, and `scans`.

### Bugs found in the audit (each fixed + regression-tested)

1. **`safeSend()` never released awaiting callers when the context was dead.**
   `if (!chrome.runtime?.id) return;` skipped the callback, so after an
   extension reload/update on an already-open X tab, `initEnv()`/`getTweetMedia()`
   promises hung forever and `drainPendingVideoTweets` wedged with
   `resolvingVideos` stuck `true` — no video post in that tab was ever listed
   again until the page was reloaded. That is precisely the user's "should I
   just reload the page again to trigger my extension?" symptom; the answer is
   now no. Fixed: the callback always fires (`null`), plus `runtimeAlive()` and
   a `withTimeout()` budget (90 s, covering the slowest legitimate path — an
   offscreen GIF conversion) on every `sendMessage` round trip.
2. **A route change only ran two of its three staged scans.**
   `scheduleScan(700); scheduleScan(1800);` — `scheduleScan` coalesces (correct
   for the MutationObserver), so the second call was silently dropped and a view
   X rendered in stages lost its last pass. Fixed with an uncoalesced
   `scheduleScanAt(delay)`; `scans` in the status payload makes it observable.
3. **One failed video resolve blacklisted the post for the tab's lifetime.**
   `resolvedVideoTweets.add(tweetId)` happened *before* the fetch and was never
   rolled back on error, so a rate-limited or transient failure meant that
   post's video never listed. Fixed with a bounded retry budget
   (`VIDEO_RESOLVE_ATTEMPTS = 2`, `videoResolveAttempts` map) — recoverable, but
   never a per-scan hammer.
4. **Stop + immediate restart could leave two loops scrolling one tab.**
   `autoScrollRunning` was a shared boolean, so the loop that was supposed to be
   stopping re-read the *new* run's `true` and kept going. Fixed with per-run
   tokens (`autoScrollRunId` / `deepFetchRunId`, the same pattern as the
   worker's `discoveryRunSerial`); a superseded run returns without touching
   shared state, and `stopCapture()` cancels an in-flight silent fill itself
   (the abandoned poll loop can no longer report the Stop).
5. **Every replay re-cloned the whole buffer across worlds.** `requestReplay()`
   asked for everything (up to 40 entries / ~8 MB) each time, and v3.7 makes
   replays frequent. `injected.js` entries now carry a monotonic `seq`; the
   content script tracks `lastReplaySeq` and asks `xdlRequestReplay {since}`,
   and `replayAll(since)` sends only newer entries (`xdlReplayDone` reports
   `{count, lastSeq}`). A caller with no cursor still gets everything, so an
   older content script against a newer MAIN world keeps working.
6. **`scrollRescan` was a documented hook with no sender.** The panel's new
   **Rescan tab** button sends it, and `tests/background.test.js`'s contract
   test now checks *content.js* handlers for reachability too (its stale
   `allowedUnreachable` exception for `scrollRescan` is gone).
7. **Dead state:** `window.__xdl_active` was set to `false` and never updated —
   now `true` once init completes (the guard tests `!== undefined`).
8. **`profileHandleFromUrl` could throw on a non-http origin.** It passed
   `window.location.origin` as the URL base; on `file:`/`about:` documents that
   is the literal string `"null"`, and the WHATWG constructor parses the base
   first, so even an absolute input threw (caught → silent "not a profile").
   Base removed. Found by the jsdom harness, kept fixed because a swallowed
   throw is how features go quietly missing.

### Validation

- `node --test tests/*.test.js` → **135 pass / 0 fail** (+10: fresh-tab shallow
  fetch, staged-scan count, incremental replay, dock click → deep fetch, dock
  switch/× behaviour, panel `scrollFetch` + Stop, `scrollRescan`, dead-context
  recovery, plus the injected `since` replay test). The dead-context test was
  verified to **fail against the old `safeSend`** before being kept.
- `tests/content.test.js` shim upgraded (still backwards compatible): element
  `addEventListener` now records and `el.emit(type)` dispatches, `dataset` is a
  real proxy over `data-*` attributes (content.js writes `dataset.role` and
  queries `[data-role="main"]`), `loadContentScript({href})` can start on a
  profile URL, and `runTimeouts(rounds)` drives delayed passes.
- **Real-DOM smoke (throwaway, NOT committed):** the actual `extension/content.js`
  and `extension/sidepanel.js` were run inside jsdom against a fake X profile
  page with a mock background. Result: zero runtime errors; the dock renders and
  reports a live count; clicking it walks shallow → scroll → remote →
  "Fetch complete — 15 listed from this tab. @nasa silent fill: 24 media found →
  Remote fetch tab."; Stop, the × dismissal, both switches, `Rescan`, and every
  new panel element id all behave. jsdom's only complaint was its unimplemented
  `window.scrollBy`.
- `node --check` on every shipped script in both folders; `firefox-extension/`
  re-synced (byte-identical except its intentional MAIN-world `<script>` shim
  and manifest), both manifests at **3.7.0**; `scripts/package-release.sh`
  re-cut (`releases/x-media-downloader-v3.7.0.zip`).

### Still open (live X, cannot be done offline)

- One signed-in pass of the Fetch button on a real profile: fresh-tab shallow
  fetch listing without scrolling, the dock's three phases, Stop mid-scroll and
  mid-fill, the silent fill's rows appearing in the Remote fetch list, and the
  rate-limit wording if X pushes back on the extra crawl.
- WORKLIST P0 items 12 / 14 / 15 (quote card, v3.5–v3.6 output, `{name}`) are
  unchanged and still pending; v3.7 adds item 16.
- Deliberately NOT done: auto-starting the *deep* fetch on tab open (the user
  chose shallow-auto + click-for-deep), merging the two lists, and any change to
  `background.js` — the whole feature rides the existing `discovery*` contract.

## 2026-09-03 — Firefox port — separate folder, feasibility analysis, MV2 manifest

**Branch:** `arena/01a064df-twitter-batch-download` · **Session input:** create separate folder for Firefox extension, port chrome extension folder into Firefox compatible, check codebase if possible and what would be needed, after reading 3 documents, add task into work list first.

### Documents read

- `docs/SESSION_HANDOFF.md` page 1 says extension version 3.6.3, MV3, sidePanel, offscreen, background service_worker, no build, always-on capture, SPA route watcher + replay buffer, per-post ZIP/CBZ/PDF via offscreen anchor, GIF → real .gif via offscreen canvas.
- `docs/WORKLIST.md` page P3 says Firefox MV3; avatar/banner; content-type extension detection — listed as robustness item, not yet implemented.
- `docs/IMPROVEMENT_LOG.md` newest entry says naming-degarble + perf queue tasks 1-5 done, 125 tests green, manifest 3.6.3.

### Codebase analysis method

1. Listed `extension/` files: manifest.json, background.js (103k), content.js (37k), injected.js (12k), offscreen.html/js, popup, sidepanel, lib/* (naming, zipWriter, pdfBuilder, gifEncoder, archive).
2. Parsed manifest.json: manifest_version 3, permissions sidePanel/offscreen/scripting/cookies/downloads/storage/activeTab, host_permissions x.com/twitter.com/twimg, background.service_worker, content_scripts world MAIN for injected.js + isolated for content.js, side_panel default_path.
3. Grepped chrome.* usage: `chrome.downloads`, `chrome.storage.local/sync`, `chrome.cookies`, `chrome.tabs.query`, `chrome.scripting.executeScript`, `chrome.offscreen.createDocument/hasDocument`, `chrome.runtime.sendMessage/onMessage`, `chrome.sidePanel.open`, `chrome.downloads.onChanged/search`.
4. Checked Firefox WebExtensions compatibility via web_search: Firefox MV3 supports service_worker but sidePanel is Chrome-only (Firefox uses sidebar_action), offscreen is Chrome-only (Firefox background has DOM), world MAIN not supported in MV2, scripting API limited, browser.* namespace preferred.

### Result — feasibility

- Port is possible. 80% code shared. 20% adaptation required.
- Blockers in Chrome-only APIs:
  - `sidePanel` → `sidebar_action` in MV2
  - `offscreen` → background page fallback already exists (buildArchiveInWorker uses lib/archive.js + data: URL) — usable in Firefox, but GIF conversion degrades to MP4
  - `world: MAIN` → inject via <script> tag with runtime.getURL
  - `chrome.scripting.executeScript` → wrapper _executeScriptCompat() using scripting if present else tabs.executeScript
  - `chrome.sidePanel.open()` → `browser.sidebarAction.open()` with fallback
  - `host_permissions` separate → merged into permissions for MV2
  - `action` → `browser_action` for MV2

### Changes made

1. Added P0 Firefox port section to `docs/WORKLIST.md` with feasibility table, required adaptations, and task checklist (create folder, manifest variant, background adapt, injection, sidebar open, test, CI, docs).
2. Created `firefox-extension/` folder via `cp -r extension firefox-extension`.
3. Wrote `firefox-extension/manifest.json` MV2 variant: manifest_version 2, browser_specific_settings gecko id x-media-downloader@example.com strict_min_version 109.0, permissions includes hosts, background scripts array lib/* + background.js, browser_action + sidebar_action pointing to sidepanel.html, content_scripts only content.js, web_accessible_resources injected.js + lib/*.
4. Edited `firefox-extension/content.js`: prepended Firefox MAIN-world injection shim that creates <script src=runtime.getURL('injected.js')> when browser namespace or Firefox UA detected, avoids double injection via dataset flag.
5. Edited `firefox-extension/popup.js`: added _api = browser||chrome, sidebarAction.open() first, sidePanel.open() second, window.close fallback; also changed tabs.query/sendMessage to use _api where needed.
6. Edited `firefox-extension/background.js`: added compatibility shim at top — _extApi = browser||chrome, alias chrome=browser if chrome undefined, guarded importScripts (only if function exists), _executeScriptCompat wrapper handling both MV3 scripting and MV2 tabs.executeScript; replaced two scripting.executeScript call sites with wrapper; ensureOffscreenDocument already returns false when offscreen undefined, so archive path uses worker fallback.
7. Added `firefox-extension/README.md` documenting why separate folder, what changed table, Firefox install steps (about:debugging Load Temporary Add-on), known limitations (GIF conversion MP4 fallback, data URL archive), next steps to full parity (background canvas GIF decode, blob filename handling, web-ext lint).

### Validation

- `ls -la firefox-extension` — folder exists, 10 files + lib/
- `node --check firefox-extension/*.js firefox-extension/lib/*.js` — syntax clean (Chrome + Firefox)
- `node --test tests/*.test.js` — 125 pass / 0 fail (extension/ unchanged)
- Manifest parse: Chrome MV3 valid, Firefox MV2 valid, no sidePanel/offscreen in Firefox manifest
- Worklist task added and ticked as created, not yet fully tested live

### Still open

- Live Firefox test: about:debugging load, scroll capture on x.com, sidebar queue, download selected with master folder, ZIP/CBZ/PDF via data URL fallback
- GIF conversion in Firefox background: implement <video>+canvas decode in background page (has DOM in MV2) using lib/gifEncoder.js, mirroring offscreen.js logic
- Remove offscreen.html/js from Firefox folder after GIF conversion parity, or keep for reference
- Add web-ext lint step to CI for firefox-extension/

## 2026-09-02 — Naming-degarble + perf queue — v3.6.3 (Tasks 1–5 of the live queue)

**Branch:** `arena/01a06058-twitter-batch-download` · **Session input:** the user
confirmed the v3.5–v3.6.2 pipeline was already live-tested OK **before** the
naming feature landed; the naming feature itself produced the **"garbled random
text"** seen in saved names. Instruction: put every task/suggestion on
`docs/WORKLIST.md`'s new active queue and work them **one by one**, so the next
session picks up where this one stops.

### Root cause (two, both confirmed by reproduction)

1. **`buildFallbackFilenames`'s last resort was literally random text.** When
   Chrome rejects a naming path, the ladder ended in
   `x-media/media_<Date.now().toString(36)>.<ext>` — the anonymous random
   stem the user saw. Reproduced: `buildFallbackFilenames("XMedia/nasa - My
   Post - 123/001.jpg")` → `…/x-media/media_mtjmkxme.jpg`.
2. **Invisible Unicode bidi/format controls survived sanitization.** A folder
   `"nasa - M\u202Eabc\u202C [test] - 123"` kept U+202E/U+202C (and similar)
   through `sanitizeArtifactFilename`, which scrambled mixed-script/RTL names.

### Fixed (Tasks 1–5), one at a time

1. **Bidi/format-control strip (Task 1).** `sanitizeArtifactFilename` now
   removes invisible bidi/format controls
   (`\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff`) while keeping visible
   non-ASCII (CJK/emoji/Arabic). +3 regression assertions in `tests/naming.test.js`.
2. **Deterministic fallback (Task 2).** `buildFallbackFilenames` no longer emits
   `media_<timestamp>`; the last rung is now `x-media/download_<stem>.<ext>`,
   uniqueness handled by the unchanged `conflictAction: "uniquify"`. The ladder
   is run-to-run deterministic and can never show random text. +1 regression in
   `tests/background.test.js`.
3. **Throttled `queueChanged` (Task 3).** New `broadcastQueueChanged()` (a
   leading-edge emit plus one trailing emit per 250 ms) replaces the raw
   `chrome.runtime.sendMessage({action:"queueChanged"})` in **both**
   `saveQueueState()` and `saveDiscoveryState()`. A download's
   `chrome.downloads.onChanged` byte-delta ticks used to broadcast per tick and
   force a full `sidepanel.refresh()` each time. +1 regression (20-save burst
   coalesces to ≤4 broadcasts).
4. **Extractor consolidation (Task 4).** A single
   `resolveTweetMedia(item)` now returns the CDN URL (photo forced to `orig`,
   video to the highest-bitrate MP4), the media kind/extension, and the GIF
   flag. **Both** `getTweetMedia`'s `collectTweetMediaEntries` and
   `mediaItemsFromTweetObject` call it, so the single-post and timeline paths can
   never drift on media rules. +2 regressions (resolution rules + path agreement).
5. **Replay bound + cheap marker (Task 5).** `injected.js` now runs an
   early-exit `containsMediaMarker` object walk **before** any
   `JSON.stringify`, so non-media GraphQL payloads (metrics polls, profile
   metadata) skip serialization entirely. The replay buffer is bounded by both
   count (40) and total serialized bytes (~8 MB) via `replayBytes`. New
   `tests/injected.test.js` (+2) pins both behaviors.

### Review pass after the cut (Task 4 diff audit)

The user asked to re-review the diff from this session for remaining missing
logic / misaligned code / error bugs. Everything else in the diff checked out
(buildFallbackFilenames dedupe, the queueChanged throttle, buildRunNotices
archive-kind filter, injected.js byte budget + marker walk, naming.js bidi strip
+ separator collapse), but **one real bug and cross-path divergence** was found
and fixed in the extractor consolidation:

- **`resolveTweetMedia` produced a garbage photo extension for bare CDN URLs.**
  The photo-extension fallback was
  `url.match(/[?&]format=([^&]+)/)?.[1] || url.split("?")[0].split(".").pop() || "jpg"`.
  For a URL with no `format` param and no file extension (e.g.
  `https://pbs.example.com/media/abc?name=orig` or `…/abc`),
  `url.split("?")[0].split(".").pop()` returned the **whole host path**, which
  after the `[^a-z0-9]` strip became `commediaabc` — so discovery filenames
  gained `….commediaabc`. Meanwhile the DOM path (`content.js
  getPhotoExtension`) safely defaults to `jpg` for the same URL, so the two
  extractors could name the same photo **differently** (the exact drift the
  consolidation was meant to remove). Fixed by a dedicated
  `photoExtensionFromUrl()` that mirrors `getPhotoExtension` exactly: explicit
  `format` param wins (`jpeg → jpg`), then a known `png`/`webp` pathname
  extension, then `jpg`. `resolveTweetMedia` now returns the same extension as
  the DOM path for every URL shape. (Note the earlier `format === "jpeg" ? "jpg"`
  mapping was *not* a bug — `extensionForItem` derives from the filename, and
  the filename is built from `resolved.extension`, so both resolve to `jpg`.)
  +1 regression in `tests/background.test.js` (`photo extension matches
  content.js getPhotoExtension for bare CDN URLs`).

### Validation

- `node --test tests/*.test.js` — **125 pass / 0 fail** (was 124): +1
  photo-extension consistency regression added during the review pass.
- `node --check` clean on all `extension/*.js` and `extension/lib/*.js`.
- Manifest **3.6.2 → 3.6.3** (Tasks 1–5 are the user-visible fixes: no more
  garbled names, quieter Side Panel during downloads, one media resolver,
  bounded replay). `scripts/package-release.sh` →
  `releases/x-media-downloader-v3.6.3.zip`, offline-verified: `manifest.json`
  at the zip root, `diff -r` byte-identical to `extension/`, full resource set
  present. Tasks 6–7 remain holds pending live-jank evidence. (Note: the review
  pass edited `extension/background.js` *after* the zip was cut; re-run
  `scripts/package-release.sh` before shipping to keep the release in sync.)

### Still open (from WORKLIST queue)

- Tasks 6–7 are **holds** to decide only after a big-queue session shows real
  jank (`content.js` 2.5s re-scan sweep; `background.js` 2.3k-line split).
- Live-X still needed: one signed-in run of the v3.5–v3.6.2 output + naming path
  (WORKLIST P0 12/14/15) and a sanitized `UserMedia` request+response to confirm
  `core.user_results.result.legacy.name` is the live display-name field.

## 2026-09-02 — Naming-engine + archive-warning review pass — v3.6.2

**Branch:** `arena/01a06058-twitter-batch-download` · **Session input:** review the
whole codebase for missing logic / sloppy code, with the naming system the
primary suspect (the sister repo's rule-34 downloader found bugs after its own
naming feature landed). Read the three docs in `docs/`, walked the naming engine
and every consumer (`background.js`, `offscreen.js`, `sidepanel.js`, `content.js`,
`injected.js`, `lib/`), and ran the offline suites before changing anything.

### Bugs found and fixed

1. **Post-folder names could carry a double empty " - " gap.** When a token's
   only content was characters that `sanitizeArtifactFilename` strips (e.g. a
   post whose text is `"???"`), `renderNameTemplate` collapsed separators for
   *empty fields* but the sanitize step ran *after* that collapse. So
   `{user} - {text} - {id}` rendered `nasa - ??? - 111`, sanitize removed the
   `?`, and the folder became `XMedia/nasa -  - 111/001.jpg`. Real path seen in
   tests. Fixed in `makePostBaseName` by collapsing separators again **after**
   sanitizing (and before the reserved-name prefix is applied, so a `_CON`
   prefix is never stripped). Now `nasa - 111`.
2. **`buildRunNotices` raised a false "mixed-media" warning.** A post carrying,
   say, photos + a video while "Include videos in archives" is OFF produces a
   clean photo-only ZIP plus a separate raw MP4 — that is *not* a mixed single
   archive. The old code counted any post whose media kinds totaled >1, so a
   photo+video post warned even when the video was never packed. `buildRunNotices`
   now counts "mixed" only among kinds actually in the archive
   (`archivedKindsForPost`); photo-only ZIPs and photo+raw-video runs stay
   silent, while photo+GIF (GIFs archive by default) still correctly warns.
   Also tightened the PDF→ZIP fallback count to the same archived-kind set.
3. **DOM-scanned photos dropped the display name (`{name}` token) entirely.**
   This was the inconsistency the first review pass left as a known limitation.
   GraphQL-captured items carry `displayName`; DOM-scanned photos hardcoded
   `displayName: ""`, so a template using `{name}` named the same post
   differently depending on how it was captured. `content.js` now reads the
   display name from the same header block as the handle
   (`[data-testid="User-Name"]`, first `<span>` that is not `@handle` — the
   selector several 2026 X/DOM scrapers use) and `makeDomQueueItems` sets it on
   every DOM item. Falls back to `""` (the template renders nothing) when the
   block is absent, so capture can never throw on an unknown header shape.

### Also reviewed (not changed)

- **Flat-layout (`master == ""`) legacy names differ by source.** Discovery
  filenames keep the `@` (`x-media/@nasa_…`), content-script filenames drop it
  (`x-media/nasa_…`). Irrelevant in practice because mediaKey dedupe means only
  one source row survives, and it only shows when the master folder is emptied.
- **Master folder isn't reserved-name guarded.** Setting `rawMasterFolder` to
  `CON`/`NUL` would hit the invalid-filename fallback ladder rather than save
  under a `_CON` folder. Niche (a user would have to type a device name) and
  safely degraded by the ladder, so left as a note.
- **Side Panel archive preview prepends `Downloads/`.** Archives actually land at
  the download root (the anchor can't carry folders); the preview example is
  cosmetic and was not touched.

### Validation

- `node --test tests/*.test.js` — **119 pass / 0 fail** (was 116): +1 naming
  regression (double-gap collapse for `???` text), +1 `buildRunNotices`
  regression (photo+raw-video does not warn; photo+GIF and opt-in video do),
  +2 content regressions (DOM-scanned photo carries the display name; a missing
  `User-Name` header falls back to `""`).
- `node --check` clean on all 11 shipped scripts.
- Manifest 3.6.1 → **3.6.2** (all three fixes are user-visible: cleaner folder
  names, fewer misleading archive warnings, consistent `{name}` naming).
- `scripts/package-release.sh` → `releases/x-media-downloader-v3.6.2.zip`,
  offline-verified: `manifest.json` at the zip root, `diff -r` byte-identical
  to `extension/`, all 19 manifest-declared + runtime-resolved resources present.

### Still open (live-X)

The `{name}` selector was cross-checked against public 2026 X/DOM scrapers, but
has NOT run in a signed-in browser. See WORKLIST P0 — a live DOM snapshot is
needed to confirm `[data-testid="User-Name"] span:first-child` still returns the
display name on current X, plus confirmation that the GraphQL `displayName`
field (`core.user_results.result.legacy.name`) matches it for the same post.

## 2026-09-02 — CI follow-up: actions v4→v5, two packaging exit-code bugs, release-zip verification

**Branch:** `arena/01a06027-twitter-batch-download` · **Session input:** follow-up to
the v3.6.1 run. GitHub logged a deprecation **warning** (not a failure) because
`actions/checkout@v4` / `actions/setup-node@v4` declare the `node20` runtime and
runner images now force node20 actions onto node24. Bump both to `@v5` in the two
byte-identical CI copies. Separately, confirm
`releases/x-media-downloader-v3.6.1.zip` loads when unzipped.

### Changes

1. **Deprecation warning cleared — `@v4` → `@v5` in both copies.**
   Verified against the upstream `action.yml` before choosing the target:
   `@v4` declares `runs.using: node20`; `@v5` (and v6/v7) declare `node24`, so
   v5 is the smallest bump that removes the warning with no input changes
   (`node-version: 22` is unchanged). Applied in
   `.github/workflows/extension-tests.yml` and re-copied over
   `docs/ci/extension-tests.yml` (`cp`, not hand-edit, so the byte-identical
   guarantee is structural) — `diff` confirms identity. A short comment records
   *why* v5, so the next bump is not guesswork.
2. **`scripts/package-release.sh` exited 141 even though it succeeded.**
   Its last line was `unzip -l "$OUT" | head -n 15`. The listing is 24 lines, so
   `head` closed the pipe early, `unzip` died of SIGPIPE, and `set -o pipefail`
   turned that into a **141 exit** — a red step/CI for a script that had already
   written a correct zip. Reproduced deterministically (5/5 runs) before fixing.
   Swapped `head -n 15` for `sed -n '1,15p'`, which drains the whole listing, so
   the exit code stays honest. Now 5/5 runs exit 0. This was latent in the very
   step the previous session added to CI ("Release zip packages cleanly") —
   it passes on a runner only when `unzip` finishes writing before `head`
   closes the pipe, i.e. it was a race, not correctness.
3. **CI's packaging assertion broke on a second zip.** The step ended with
   `test -f releases/x-media-downloader-v*.zip`; with two zips present the glob
   expands to two operands and `test` fails with `binary operator expected`
   (exit 2) even though the artifact exists. CI is safe today only because its
   workspace is fresh — any local `package-release.sh` run before the workflow,
   or a second tagged zip, would turn the step red. Replaced with the
   glob-safe `nullglob` + count guard already used by the syntax-check step.
4. **Release zip verified offline (WORKLIST P0, "cut the first release zip").**
   `scripts/package-release.sh` → `releases/x-media-downloader-v3.6.1.zip`,
   unzipped to a scratch dir: `manifest.json` sits at the zip root (no wrapper
   folder), `diff -r` against `extension/` is byte-identical with no missing or
   extra files, and every manifest-declared *and* runtime-resolved resource
   resolves on disk — `background.service_worker`, both content scripts
   (MAIN + isolated), `icons`, `action.default_popup`/`default_icon`,
   `side_panel.default_path`, plus the files the manifest does not declare but
   Chrome loads anyway (`offscreen.html`, `offscreen.js`, all five `lib/*`), and
   every `importScripts`/`<script src>` target. The remaining slice of that P0
   item is the one click only a browser can make (Load unpacked on the unzipped
   folder); the packaging side is now proven.

### Validation

- `node --test tests/*.test.js` — **116 pass / 0 fail** (unchanged; no
  extension file was touched).
- `node --check` clean on all 11 shipped scripts; `bash -n` clean on
  `scripts/package-release.sh`.
- Workflow YAML parses (`yaml.safe_load`) in both copies; `diff` byte-identical.
- The CI packaging step was executed verbatim with two zips present: exit 0.
- Release zip: root-level manifest, `diff -r` identical, 23/23 resource checks OK.
- **No `extension/` file changed, so the manifest stays at 3.6.1** — this is a
  CI/packaging-only pass and is not user-visible.

### Note for the next session

`@v5` is what was asked for and it clears the warning, but it is already two
majors behind: upstream is at `actions/checkout@v7.0.1` (2026-07-20) and
`actions/setup-node@v7.0.0` (2026-07-14), both on `node24`. For this workflow's
usage (checkout with no inputs; setup-node with only `node-version`) a jump to
v7 is a two-line change — left at v5 deliberately, pending a user decision.
Do not bump past a major without checking that action's release notes: v6/v7
of these actions are where input renames live, and the docs' "no npm" guardrail
means CI is the only automated gate this repo has.

**Branch:** `arena/01a05f98-twitter-batch-download` · **Session input:** review the
CI workflow and the whole codebase (after reading the three docs in
`docs/`), find errors / missing logic / misaligned or rotten code, clean the
CI YAML up in both source and docs, and write less code for the same output
without changing behavior.

### Bugs found and fixed

1. **Archive plumbing existed twice and could drift.** `background.js`
   (worker fallback) and `offscreen.js` (primary path) carried near-identical
   `fetchImageBytes` / `preparePdfImage` / `bytesToBase64` / ZIP-PDF assembly
   copies (~120 lines duplicated). Extracted into a single
   **`lib/archive.js`** (`XDLArchive`: fetch, PDF page prep, base64,
   `buildArchiveBytes`) loaded by both contexts and the Node VM suites.
   Byte-level output is pinned to the same writers by the new
   `tests/archive-lib.test.js` (ZIP/CBZ/PDF parity, MIME, PDF page size,
   unknown-format degradation).
2. **Stop scan did not cancel the 429/503 countdown.** `discoveryStop` only
   set `stopRequested`; `sleepWithRateLimitCountdown` kept waiting up to 60 s
   and `fetchWithRetry` kept retrying — the stop button looked dead (the
   documented P1/item 4 in PROJECT_IMPROVEMENT_OPINION.md). Now
   `fetchWithRetry`/`sleepWithRateLimitCountdown` accept a `shouldAbort`
   callback that the discovery run wires to `stopRequested` + run-id
   staleness; an aborted retry returns `{ aborted: true }`, `callDiscoveryGraphQL`
   throws code `stopped`, and the run's catch reports a clean
   "Discovery stopped — N media found" instead of an error.
3. **Storage save chains were poisonable.** `queueSaving`,
   `downloadedSaving` and `discoverySaving` chained
   `previous.then(() => chrome.storage.local.set(...))`; one rejected write
   permanently rejected the chain, so every later save silently stopped
   happening (in-memory state diverged from storage). Each chain step now
   catches; a failed write is skipped without breaking later saves.
4. **`queueStart` re-queued failed items without a fresh attempt budget.**
   An item that exhausted its 3 attempts stayed at `attempts: 3`, so
   "Download selected" re-queued it and it failed instantly (only "Retry
   failed" worked). `queueStart` now resets `attempts`/`error` for every item
   it moves into the queue — a user-triggered start is a fresh run.
5. **Dead state removed.** `injected.js`'s `replayedKeys` /
   `__xdlInjectedReplayKeys` were written but never read (replay dedupe is
   done downstream by item id/CDN key); `content.js`'s `scanStats.photos`/
   `scanStats.videos` were write-only; `collectTweetMedia` returned
   `safeName`/`media`/`handle` that no caller used.

### CI cleanup (both copies, byte-identical)

`.github/workflows/extension-tests.yml` and `docs/ci/extension-tests.yml`
were cleaned up together: read-only `permissions`, a `concurrency` group that
cancels superseded runs, `timeout-minutes`, a syntax-check glob guard so an
empty match fails instead of passing silently (`nullglob` + count check), and
a packaging step that only installs `zip` when missing and asserts the
generated artifact exists. The workflow itself still runs offline suites only
(no real-browser MV3 job — see docs/ci/README.md).

### Validation

- `node --test tests/*.test.js` — **116 pass** (was 106): +6
  `tests/archive-lib.test.js` (shared engine parity) and +4 background
  regressions (abort on Stop, `stopped` classification, attempt-budget reset,
  storage-write recovery).
- The three new behavior tests fail against the pre-fix tree by design
  (abort path, attempt reset, second-save visibility).
- `node --check` clean on every shipped script; packaging smoke produced a
  v3.6.1 zip carrying `lib/archive.js`.
- Manifest 3.6 → **3.6.1** (user-visible fixes: Stop now interrupts backoff,
  Download selected retries exhausted items).

## 2026-09-01 — Media-kind upgrade: GIF stays a GIF, quality guarantees, archive rules + warnings — v3.6

**Branch:** `arena/01a05aab-twitter-batch-download` (same PR as v3.5) ·
**Session input:** review the v3.5 diff for missing/misaligned logic, then:
photos at highest quality, GIFs saved as GIFs (not MP4), videos at highest
quality; multi-GIF posts archive like photo posts but ZIP/CBZ only (never
PDF) and optional; GIF+photo mixes default to ZIP/CBZ; multi-video posts
ZIP/CBZ only and optional; warn when zipping video posts or mixed-media
posts; then clean up leftover code and keep the directory purpose-separated.

### Review findings fixed

- `normalizePhotoUrl` only added `name=orig` when no `name` param existed —
  a pre-sized GraphQL variant (`name=small`) would have downloaded small.
  Now forces `orig` on every source, matching the DOM path in `content.js`.
- GIF identity was lost end to end: `animated_gif` collapsed into
  `type:"video"` and saved as `.mp4`. Items now carry `isGif` (type stays
  `"video"` so the photo/video capture filter keeps working); the Side Panel
  shows a `gif` badge.
- `content.js` had two ~55-line near-identical GraphQL-entry→item builders
  (scroll resolver vs action-bar buttons). Consolidated into one
  `mediaEntryToItem()` so the paths can never drift again.
- Offscreen messaging generalized into `sendOffscreenRequest()` (one timeout/
  lastError wrapper for archive + GIF jobs); output settings normalized
  centrally (`normalizeOutputSettings`) so corrupt stored values can't flip
  toggles.

### GIF → GIF (new pipeline)

- New `lib/gifEncoder.js`: dependency-free streaming GIF89a encoder (median-
  cut 256-color palette from frame 1, nearest-color cache, spec-timed LZW,
  NETSCAPE loop-forever). Verified in tests by a spec-faithful decoder —
  pixels round-trip, including a noisy frame that forces LZW code-width
  growth.
- `offscreen.js` decodes X's silent MP4 clip through `<video>` + canvas
  (12 fps, bounded ≤30 s / ≤360 frames / ≤720 px / ≤40 MB) and feeds the
  encoder frame-by-frame (one RGBA buffer alive at a time). Raw-mode GIFs
  return as base64 and download via `data:` URL — which, unlike the anchor,
  honors the master-folder subpath. Every failure (no offscreen API,
  timeout, oversized result) degrades to the original MP4, never a dead item.
- New sync setting `gifOutput` (`"gif"` default | `"mp4"`).

### Archive kind rules + toggles + warnings

- `archivedKinds()`: photos always archive; GIFs when `archiveGifs` (default
  ON); videos only when `archiveVideos` (default OFF). Non-archived kinds
  stay in the raw pass.
- `effectiveGroupFormat()`: PDF is photos-only — a post whose archive holds
  a GIF or video degrades PDF→ZIP for that post; ZIP/CBZ allowed. Entries
  are named per kind (`002.gif`, `003.mp4`); a failed in-archive GIF
  conversion renames its entry back to `.mp4` so archives are never
  mislabeled. The worker fallback (no DOM) embeds GIF sources as `.mp4`.
- `buildRunNotices()` at `queueStart` → `state.notices`, rendered as an
  amber alert box in the dock: video posts being packed, mixed-media posts
  (photos+GIFs+videos in one post), and PDF→ZIP fallbacks are announced
  before the first byte downloads. Raw runs never warn.

### Plumbing

- Manifest 3.5 → 3.6. Queue state persists `notices`; `publicQueueState`
  exposes them. `downloadFile` (single-post button) runs through the same
  `prepareRawDownload()` as the queue, so one-off GIF downloads convert too.
- Side Panel Output settings: GIF format select + two archive-inclusion
  checkboxes (written ONLY there, relayed as a settings bag everywhere,
  offscreen included). Dock picker renamed "Save posts as".

### Validation

- 106 offline tests green (`node --test tests/*.test.js`): +5 GIF encoder
  round-trip, +13 media-kind suites (quality forcing, gif identity, kind
  rules, warnings, mixed-post pipelines, offscreen GIF relay, toggles), all
  93 previous tests unchanged.
- `scripts/package-release.sh` smoke: v3.6 zip carries `lib/gifEncoder.js`
  + updated offscreen files. Not yet live-verified on x.com (WORKLIST P0
  item 14 now covers v3.6).

## 2026-09-01 — Media output upgrade: master folder, ZIP/CBZ/PDF per post, naming checkboxes — v3.5

**Branch:** `arena/01a05aab-twitter-batch-download` · **Session input:** port
three proven features from the sister repo
[nh-dw-2.0](https://github.com/freeforall1932-design/nh-dw-2.0) (PR #30 /
commit `9f86426` raw master folder; `Downloader.ts` save pipeline +
`sanitizeArtifactFilename`; `pdfBuilder.ts`; `nameTemplate.ts` +
`getDownloadName`; `extension-tests.yml`).

### Feature 1 — Master folder for loose (raw) downloads

Raw files now save as `Downloads/XMedia/<post name>/001.jpg…` instead of
flooding a single flat folder with hundreds of files.

- New sync setting `rawMasterFolder` (default `"XMedia"`). **EMPTY STRING =
  OFF**: raw items then keep their legacy `x-media/…` filename byte-for-byte
  (pinned by test). Slashes nest deeper (`XMedia/raw`).
- Core trick (proven in nh-dw): `chrome.downloads.download({ filename })`
  accepts RELATIVE subpaths and auto-creates folders when "ask where to
  save" is off. Never absolute, never `..` — `sanitizeArtifactFilename`
  (copied from nh-dw `Downloader.ts`) cleans every path segment: control
  chars + `\:*?"<>|` stripped, leading dots and trailing dots/spaces
  dropped, segments capped at 120 chars, never empty.
- The empty string is SAVABLE: the Side Panel field is wired manually with a
  `change` listener storing `.value.trim()` verbatim (nh-dw's generic input
  widget dropped empties, which made "off" impossible — do not regress this).
- Paths are computed at download time in `background.js`
  (`rawPathForItem`), not at item-creation time, so the settings apply to
  items already sitting in the queue. Items persisted by pre-3.5 versions
  (no `mediaIndex`/`text` metadata) keep their stored leaf name under the
  master folder rather than guessing.

### Feature 2 — ZIP / CBZ / PDF output for multi-picture posts

A post can carry up to 4 photos; the new formats bundle them into ONE file
per post, named `<post name>.zip|cbz|pdf`, entries `001.jpg…004.png` at the
archive root in post order.

- `lib/zipWriter.js`: minimal STORE-only ZIP writer (CRC-32, central
  directory, EOCD) written locally instead of adding JSZip — the repo's
  "no npm / no build step" guardrail outweighs the sister repo's dependency
  choice, and photos are already compressed.
- `lib/pdfBuilder.js`: nh-dw's dependency-free PDF 1.4 writer ported
  VERBATIM (its test suite came along, mocha → node:test): JPEG embedded
  as-is (DCTDecode, dims from SOF frames), byte-exact xref. PNG/WebP (and
  CMYK JPEGs) re-encode via `createImageBitmap` + `OffscreenCanvas`
  flattened on white.
- Assembly runs in a new **offscreen document** (`offscreen.html/js`,
  `offscreen` permission, reason `BLOBS`): fetch images → build Blob →
  object URL → click an in-document `<a download>` anchor. The anchor is
  mandatory (nh-dw v3.2.1 hard-learned): some Chromium builds ignore the
  `filename` arg for `blob:` URLs and save a UUID. Anchor downloads cannot
  carry folders, so archives land at the Downloads root.
- Offscreen documents expose ONLY `chrome.runtime` (verified on real Chrome
  in nh-dw): settings travel inside the job message; the document never
  touches storage/downloads/scripting.
- Service-worker fallback when `chrome.offscreen` is missing: build in the
  worker, hand a base64 `data:` URL to `chrome.downloads` (data: URLs do
  respect `filename`). Acceptable only because a post is ≤4 images; this is
  also the path the window-less VM tests exercise.
- Format whitelist everywhere (`raw|zip|cbz|pdf`, corrupt → `raw`). The
  per-job dock picker ("Save photo posts as") seeds from the stored default
  and never writes it back. Videos always stay raw MP4s.
- **Scope note on the "no ZIP" guardrail:** the removed feature was the
  multi-GB whole-batch archive. This is a per-post archive of at most four
  images, explicitly requested this session; the batch ZIP stays banned.

### Feature 3 — Naming-scheme checkboxes

- New sync setting `nameTemplate` (default `"{user} - {text} - {id}"`).
  Tokens: `{user}` handle, `{name}` display name, `{text}` post text
  (~40 chars, URLs/@mentions stripped), `{id}` post id, `{date}`
  YYYY-MM-DD. The stored value is the TEMPLATE STRING; the UI renders one
  checkbox per token in canonical order joined by " - ", with a live
  "Example file name" preview (nh-dw `nameTemplate.ts` pattern).
- A stored template that is not pure checkbox tokens shows a manual input
  instead, so hand-typed templates are never lost.
- The rendered name applies to BOTH the raw per-post folder and the archive
  base name. Empty renders fall back to the post id (then "post");
  Windows-reserved device names (CON, NUL, COM1…) get a "_" prefix.
- Per-file numbering inside a post (001…004) is automatic — an `{index}`
  token was deliberately not offered because the template names per-POST
  artifacts (folder/archive), where an index would split one post across
  names.

### Plumbing

- Queue items now carry `text`, `displayName`, `mediaIndex` (all three
  producers: background GraphQL parser, content DOM scan, per-post resolve);
  `getTweetMedia` entries gained `displayName`/`date`/`mediaIndex` with the
  index counted per owning post (quote-card media numbers restart).
- `queueStart` accepts `format`; the effective format persists as queue
  state (`outputFormat`) so a worker restart mid-run cannot silently switch
  archive photos back to raw.
- `downloadFile` runtime message accepts the owning `item` so the on-post
  Download button honors the master folder too (always raw — archives are a
  Side Panel batch feature).
- `content.js`/`sidepanel.js` senders unchanged in shape — no new runtime
  actions, so the message-contract test needed no allowlist changes.

### Tests / CI

- +33 tests → **88 passing**: `tests/naming.test.js` (template engine,
  sanitizer, master-folder paths, reserved names, id fallback),
  `tests/zip-writer.test.js` (CRC-32 vector, headers, central directory
  walk), `tests/pdf-builder.test.js` (ported verbatim),
  `tests/downloader.test.js` (real background.js in a VM: default/custom/
  empty/weird master folder, zip/cbz/pdf end-to-end through the data-URL
  fallback with byte-level archive checks, offscreen job relay, video
  passthrough, corrupt-format degradation, failure marking).
- Test harnesses now run the real `lib/` files through `importScripts` and
  stub `chrome.storage.sync`; shared loader in
  `tests/helpers/load-background.js`.
- New CI workflow `extension-tests.yml`: offline only (syntax +
  `node --test` + packaging smoke). GitHub-hosted runners cannot run
  real-browser MV3 tests (Chrome `Runtime.enable` timeout / Brave SIGTRAP —
  100% failure rate in the sister repo), so signed-in verification stays a
  local manual step.

### Validation

- All 88 offline tests green; `node --check` clean on every shipped script;
  `scripts/package-release.sh` produces a v3.5 zip containing `lib/` and the
  offscreen files. Manifest 3.4 → 3.5 (single manifest in this repo; the
  release zip is generated, so there is no second built tree to diff).
- **Not yet live-verified** (needs a signed-in browser): folder
  auto-creation on a real 4-photo post, archive anchor saves on current
  Chrome, and the v3.4 quote-card spot-check that was already pending.

## 2026-08-26 — Quoted-post media capture (the "mentioned post" card) — v3.4

**Commits:** `08e68d0` (feature) + `b943a84` (review pass) on
`arena/01a03ae9-twitter-batch-download` · **Round-3 context:** items 1–11 of
the live checklist passed the same day (user report: all functions work, no
double entries, UI/UX decent for deployment); this entry closes the one gap
that test found.

### Report (live round 3)

Live testing of v3.3 against real X: **all functions work, no double entries,
UI/UX decent enough for deployment** — except one gap: *"mentioned post didn't
get fetched — say this post is a GIF or video reaction to the mentioned post;
there should [be a] small box post with thumbnail image and text from the
post."* The user asked whether fetching that card's media is impossible and
pointed at the scrapyard database code and community GitHub for comparison.

### Root cause — deliberate exclusion, not an X limitation

The quoted post's full payload (author, text, thumbnail, and every media
variant, including GIF/video MP4s) is embedded **in the same GraphQL response**
under `legacy.quoted_status_result.result` — the exact card X renders. Both
scrapyard references prove it:

- **Rank S (Plucker XBD):** media resolution ladder per timeline tweet —
  own/RT media → **quoted post's `extended_entities` as fallback** → card
  `binding_values.media_entities`, with an `is_quote` flag and an
  "only himself" filter that excludes `is_rt || is_quote`.
- **Rank B (X Exporter):** dedicated `tr()` extractor over
  `legacy.quoted_status_result.result`.

This repo skipped it on purpose: `collectTweets` pruned
`quoted_status_result` subtrees (`background.js` v3.3 line ~1375), pending an
explicit include option (see the 2026-08-24 "Deliberate boundaries" entry).
So it was never impossible — it was switched off.

### Changed

- **`background.js`**
  - `mediaFromTweet(tweet, handle, options)` now takes an options object
    (`{ includeRetweets, includeQuoted }`; a bare boolean still means
    `includeRetweets`, so old call sites/tests keep working). The per-tweet
    mapping moved into `mediaItemsFromTweetObject(source, { isRepost, isQuote,
    fallbackAuthor, fallbackDate })`, shared by own/RT/quoted media.
  - New `quotedTweetFrom(tweet)` resolves `quoted_status_result.result` with
    soft unwrap — a deleted/protected/NSFW quoted card skips quietly instead
    of aborting the page. One level only (no quote-of-quote chasing), same as
    Rank S.
  - **Attribution:** quoted media lists as its own row owned by the *quoted*
    post — `id: quotedTweetId-mediaId`, quoted author, quoted text in the
    filename, `isQuote: true`. If the same quoted post later appears in the
    timeline directly, the CDN `mediaKey` collapses the two into one row.
  - Scroll capture (`handleLocalTimelineCapture`) passes
    `includeQuoted: message.includeQuoted !== false` — **on by default**,
    because the quote card is media the user visibly scrolled past.
  - Remote fetch passes `includeQuoted: options.includeQuoted !== false`.
  - `getTweetMedia` (per-post resolve + action-bar Download/Add to queue) now
    returns the quoted card's media too, with **per-item attribution**
    (`username`, `tweetId`, `text`, `isQuote` on each video/photo entry). This
    covers the SPA-cache case where the page never re-issued the timeline
    GraphQL: the outer post resolves once and both the reaction and the quoted
    media come back.
- **`content.js`**
  - New `includeQuoted` state (default on), persisted as
    `scrollIncludeQuoted`, updated by `scrollSettings`/`scrollStart`, reported
    in `statusPayload`, and forwarded with every `localTimelineCapture`.
  - `drainPendingVideoTweets` and `collectTweetMedia` (action bar) build ids,
    filenames, authors, and `isQuote` from each media item's owning post
    instead of always the outer tweet id.
- **Side Panel** — new **Include quoted** checkbox in both tabs (Scroll
  capture options row; Remote fetch next to *Include reposts*), both default
  on, persisted (`scrollIncludeQuoted` / `includeQuoted`). Queue rows for
  quoted media show a violet **quote** badge beside the existing repost badge.
- `manifest.json` → **3.4**.

### Deliberately kept

- Quotes are one level deep; a quote-of-quote's nested card is not chased.
- DOM-scan photos inside a quote card still attribute to the outer article
  (no stable selector separates them today); the GraphQL-attributed copy wins
  the mediaKey dedupe whenever both arrive, so no double row ever appears.
- Replies remain excluded — still awaiting their own explicit switch.

### Validation

- `node --test tests/*.test.js` — **55** pass (was 48). Seven new tests:
  quote-reaction capture lists both media; per-capture switch-off; text
  reaction quoting a media post (the Rank S fallback case); repost-of-quote
  attribution; quoted photo vs DOM row collapse (no double entry);
  `getTweetMedia` per-item attribution; content-script setting flow
  (default on → switch off).
- Verified as real regressions: the five behaviour tests **fail** against the
  pre-change tree; the two guard tests pass on both trees by design.
- `node --check` clean on all five extension scripts. No new runtime actions,
  so the message-contract test needed no changes.
- **Post-commit review pass (same day):** re-audited every hunk for missing
  logic after an interrupted session. Confirmed complete: `injected.js`
  media-marker pre-filter is a regex over the *serialized* JSON, so
  quote-nested media still forwards; `publicQueueState()` passes whole items,
  so `isQuote` reaches the badge; popup.js untouched and compatible. Found and
  fixed: the refactor had dropped the outer-post `rest_id` fallback for a
  repost target without its own id (restored via `fallbackTweetId`; quoted
  media never falls back — mis-attribution would corrupt skip-history).
  README feature list now documents Include quoted. Known untested seam: the
  discovery loop's `includeQuoted` pass-through is not exercised end-to-end
  (the unit harness cannot yet satisfy its cookie/auth preconditions); the
  identical default expression is covered via the scroll-capture test.

### Still not verified

Nothing here ran in a signed-in Chrome. Live items: quote card with a video
or GIF listed with the `quote` badge and correct author; Include quoted off
suppresses card media in both tabs; action-bar Download on a reaction post
fetches reaction + quoted media.


## 2026-08-25 — Full pre-release code review (WORKLIST checklist) — contract gaps found and closed

### Motivation
Before declaring v3.2 ready for live round-3 testing, the `WORKLIST.md`
code-review checklist was run end to end. It had not been run in full previously;
only the reported `appendChild` crash had been investigated.

### Verified clean (each re-checked against the shipped tree, not the docs)

- **No third-party hosts / license / tier gates.** The only `plucker` / `tier`
  matches in `extension/` are code comments; no external API host.
- **No ZIP path.** The only `zip` match is a comment explaining why ZIP was dropped.
- **No manual token/password input.** No `type="password"`, no token/cookie prompt.
- **No build tooling, no non-X permissions.** No `package.json`/`tsconfig`/lockfile
  outside `reference/`; manifest hosts are x.com, twitter.com, and three twimg/X CDNs.
- **Every deprecated symbol is gone.** `downloadZip`, `fetchAsArrayBuffer`,
  `getVideoUrl`, `downloadVideo`, `zipBuffers`, `ZipWriter`, `useZip`, `bulkId`,
  `webRequest` — 0 hits in `extension/`.
- **`TweetDetail` is request-metadata only.** It sits in `injected.js`
  `TRACKED_OPS`, which is explicitly documented as *not* gating response parsing
  (`injected.js:100` returns the parsed payload regardless). `getTweetMedia`
  still reads only `getCapturedOperation("TweetResultByRestId")`.
- **Capture bag never stores cookies** (`background.js:242-243` skips the
  `cookie` header) and **fresh CSRF from cookies overrides a stale capture**
  (`background.js:317-318`).
- **Discovery stop conditions all present** in one guard
  (`background.js:1621`): no cursor, repeated cursor, and `emptyPages >= 2`;
  plus cap (`state.found < limit`), user stop (`!state.stopRequested`), and
  `isCurrentDiscoveryRun()` staleness checks at 14 points in the loop.
- **No missing DOM ids.** Every `$("#id")` in `sidepanel.js` exists in
  `sidepanel.html`, and both `popup.js` ids exist in `popup.html` — so no
  `null.addEventListener` crash class. (`remoteTabBtn`, `scrollTabBtn`,
  `tabStatusDot`, `downloadNotice` look unused by id but are wired via the
  `.tab` class + `data-tab` or are static CSS/text — not dead markup.)
- **No unused functions** in `content.js`, `injected.js`, `sidepanel.js`.

### Found and fixed

1. **Two message-contract commands were unreachable.** `background.js` handled
   `queueClearFinished` (line 1030) and `queueClearDownloadedHistory` (line 1023),
   and `SESSION_HANDOFF.md` §4 lists both in the contract — but **nothing in the
   Side Panel ever sent either**. `queueClearFinished` was a real user-facing
   control in the 2026-08-24 "Persistent Side Panel batch queue" entry and was
   lost in the v3.2 rework; the `Clear list` button sends `queueClearAll`
   instead. `queueClearDownloadedHistory`'s *handler* was covered by a test, but
   no button could reach it, so the documented "resettable" skip-history was not
   actually resettable by a user.
   - **Fixed:** added `Clear finished` and `Reset downloaded history` buttons to
     the queue-maintenance toolbar (`sidepanel.html`), wired in `sidepanel.js`.
     Both handlers already returned `publicQueueState()`, so no background change
     was needed. Chosen over deletion because the docs advertise both.
2. **`getCapturedHeaders()` has no shipped caller.** Declared at
   `background.js:275`, used only by `tests/background.test.js:690` as a test
   seam. Left in place deliberately; recorded so it is not mistaken for dead code.
3. **`scrollRescan` is handled in `content.js:929` but never sent.** Read-only
   rescan hook documented in the contract; harmless, left wired for a future
   panel control and allowlisted explicitly in the new contract test.

### Added

- **A structural contract test** (`tests/background.test.js`): cross-checks the
  shipped sources so every `action:` the UI sends has a handler in
  `background.js` or `content.js`, and every `background.js` handler has a sender
  (allowlist: `scrollRescan`). This is the test that should have existed when
  v3.2 dropped those two controls.
- **`queueClearFinished` behaviour test** — completed/failed rows are dropped,
  unfinished rows survive.
- Both new tests were verified to fail against the pre-fix tree: unwiring the new
  `clearFinishedBtn` listener makes the contract test report
  `"queueClearFinished" is handled in background.js but no UI sends it`.

### Validation

- `node --test tests/*.test.js` — **48** pass (was 46).
- `node --check` clean on all five extension scripts and both test files.
- Id audit and message-contract audit both report zero unhandled/missing entries.
- `extension/manifest.json` bumped **3.2 → 3.3**: two new toolbar buttons plus the
   crash fix are user-visible, per the WORKLIST rule on version bumps. No release
   zip cut yet — `scripts/package-release.sh` should run only after round 3 passes.

### Still not verified (unchanged)

Nothing here was run in a signed-in Chrome. The live-X round-3 checklist in
`WORKLIST.md` remains the gating item before P0 can be called complete.

## 2026-08-25 — Reported `appendChild` on null crash: traced, partly already fixed, residual gap closed

### Report
A live error was reported against `https://x.com/real_loonarae/media`:

```
Uncaught TypeError: Cannot read properties of null (reading 'appendChild')
  content.js:105
```

Line 105 of the reported file is `document.head.appendChild(style);` — the
unguarded stylesheet injection.

### Findings

1. **The reported file is a pre-v3.2 build, not this repo's `content.js`.** The
   copy that produced the trace is 754 lines and still contains the
   `localCaptureWatch/Start/Stop/Status` handlers, the popup `start` / `stop` /
   `getStatus` bulk loop, `mainLoop()`, and `getVisibleMediaTweets()`. All of
   those are listed as *removed in v3.2* in `SESSION_HANDOFF.md` §4. The current
   `extension/content.js` is 924 lines and contains none of them
   (`grep -n "localCapture\|mainLoop\|getVisibleMediaTweets" extension/content.js`
   returns nothing). **Anyone still seeing this trace is running a stale unpacked
   folder — reload the extension, or confirm the folder is this repo's
   `extension/`.**
2. **The exact crash the user hit (null `<head>`) was already addressed.** The
   injection had become `(document.head || document.documentElement).appendChild(style);`.
   Verified by loading the real script with `document.head === null`: no throw,
   stylesheet lands on `<html>`. This is the documented `document_start` case —
   `<head>` may not exist yet while `<html>` does.
3. **But the guard was incomplete and untested.** At `document_start` both
   `document.head` *and* `document.documentElement` can be null. Loading the real
   script in that state still threw the identical
   `TypeError: Cannot read properties of null (reading 'appendChild')`, now at
   `content.js:234`, killing the whole IIFE so capture never started on that tab.
   `tests/content.test.js` never caught this because its DOM shim hardcodes a
   non-null `head` *and* `documentElement`, so the null branch was never executed.
   No doc recorded the fallback either.

### Changed

- `extension/content.js`: stylesheet injection is now `injectStyles()` — it tries
  `document.head`, then `document.documentElement`, and if neither exists yet it
  arms a non-subtree `MutationObserver` on the `Document` node plus a
  `DOMContentLoaded` listener and retries. It never throws, so a null root can no
  longer abort the script and silently kill capture.
- `tests/content.test.js`: `loadContentScript()` takes a `documentOptions`
  override (`head` / `documentElement` / `body`) and the `MutationObserver` shim
  now records instances, so a `document_start` with a missing root is testable.
  Three regression tests added: null `<head>`; null `<head>` *and* null `<html>`
  (retry via observer); deferred attach via `DOMContentLoaded` alone. Each also
  asserts capture still lists media afterwards, since the old throw killed
  capture, not just styling.

### Validation

- `node --test tests/*.test.js` — **46** pass (was 43).
- The three new tests were run against the pre-fix line to confirm they are real
  regressions: the two null-root tests fail without the fix, the null-`<head>`
  test passes without it (proving finding #2 — that case was already handled).
- `node --check` clean on all five extension scripts.

## 2026-08-25 — Session handoff rewritten as a review-driven document

### Motivation
The handoff described state but not *process*. A new session had no explicit
instruction to review the improvement log and worklist first, and no rule about
writing findings back, so context was rediscovered each time.

### Changed
- `docs/SESSION_HANDOFF.md` rewritten with a numbered structure and a new
  **"Start here"** section: a table explaining what each of the three docs
  answers, plus the six-step review loop (read log → read worklist → read
  handoff → apply user input → work + test → write back to all three).
- Added a **"User input carried into the next session"** slot so live-test
  feedback and open product questions survive the session boundary. Current
  open questions recorded: did v3.2 fix homepage/route capture, is "Fast" fast
  enough, should the two tab lists be unified, are per-batch subfolders wanted.
- Added **"Design decisions that are deliberate — do not simplify these away"**:
  six items (no response allowlist, unconditional capture start, SPA route
  watcher + replay, rate-bounded video resolve, single download action, popup
  has no loop), each tied to the live failure it fixes.
- Expanded the removed/deprecated list with the v3.2 removals
  (`localCapture*`, popup bulk commands, `Watch current tab`, auto-scroll limit,
  `Download all in tab`) and documented the MAIN ↔ isolated world message pairs.
- Corrected stale content: branch, v3.1-era architecture notes, the
  "popup auto-scroll remains supported" line, and the duplicated
  commands/testing sections.
- `docs/WORKLIST.md`: added a **Session workflow** section mirroring the loop and
  pointing at the do-not-simplify list; marked the manifest-version P0 item done.

### Unchanged
- No extension code touched. Docs only; 43 tests still pass.

## 2026-08-25 — Live-testing fixes: always-on capture, SPA routes, one download action

Driven entirely by signed-in live-X testing feedback against v3.1.

### Root causes found

1. **Capture required an explicit "watch" command.** `content.js` only listed
   media after the Side Panel sent `localCaptureWatch` to whichever tab was
   active. Any other tab, and any view reached without the panel re-issuing the
   command, captured nothing.
2. **Response parsing was gated by an operation-name allowlist.** Both
   `injected.js` (`TRACKED_OPS`) and `background.js` dropped every GraphQL
   payload whose operation was not on a fixed list. Home timeline operations
   were never on it, which is why the homepage never captured at all.
3. **Nothing reacted to SPA route changes.** X changes `/user` → `/user/media`
   and opens posts via `history.pushState`, with no document load. The old code
   only re-armed on a real page load, so a route change in the same tab left
   capture pointing at the previous view — exactly the reported "only works
   after a reload, a new tab, or several minutes" behaviour.
4. **Two engines fought over the page.** The popup ran its own scroll+download
   loop that downloaded each item before scrolling further, while the Side Panel
   ran a separate listing loop.

### Changed

- **Capture is always on.** `content.js` starts listing at `document_start` in
  every X tab, with no watch command. `Watch current tab` is gone.
- **No operation allowlist for responses.** `injected.js` forwards any GraphQL
  response containing media markers; `handleLocalTimelineCapture` parses any
  payload. The allowlist survives only for *request metadata* used by Remote
  fetch. Home timeline, profile, `/media`, and post detail all capture now.
- **SPA route watcher.** `injected.js` patches `pushState`/`replaceState`/
  `popstate` (Rank S pattern) and emits `xdlUrlChanged`; `content.js` re-scans
  and requests a replay on every route change, with a 2.5s reconciliation sweep
  as a backstop.
- **Replay buffer.** `injected.js` keeps the last 40 media-bearing GraphQL
  payloads and replays them on request, so an extension reload, a late listener,
  or an SPA view served from X's cache without a new request still lists media.
- **Video posts resolve per-post.** DOM-visible video posts that never produced
  a GraphQL payload are resolved through `TweetResultByRestId`, rate-bounded to
  one per 700ms. This is why a profile's posts now list, not just `/media`.
- **One download action.** `Download all in tab` was removed as redundant with
  `Select all` + `Download selected`.
- **Auto-scroll rewritten.** Content-driven pacing (waits for the timeline to
  grow rather than sleeping a fixed interval), no item limit, and it never waits
  on downloads. A floating in-page badge shows progress with a Stop button.
- **Popup is a launcher.** Its competing scroll/download loop is deleted.
- **Rank A action-bar insight adopted:** every media post now gets both
  `Download` and `Add to queue`, plus toasts. Reimplemented locally.
- **Rank S "Ignore saved" adopted:** completed downloads are remembered by id
  (`downloadedMediaIdsV1`, ids only) and skipped on re-listing. Toggleable via
  `Skip already downloaded`.
- **Cross-source dedupe.** Every item carries a `mediaKey` derived from the CDN
  path, so the same photo found in the DOM and in a GraphQL payload collapses
  into one row.
- **Per-row remove**, post deep-link, and a live active-tab status pill showing
  route, posts on screen, and pending video resolves.

### Validation

- **43** Node tests pass (was 27). New `tests/content.test.js` runs the real
  `content.js` in a DOM shim and reproduces each reported failure: homepage
  capture, in-tab route change, duplicate suppression, filter behaviour, and
  auto-scroll start/stop.
- `node --check` clean on all five extension scripts.
- Side Panel ids/messages cross-checked: no unhandled message, no missing id.

## 2026-08-25 — Repo restructure: load-unpacked layout + release packaging

### Motivation
The repo root mixed the shippable extension (in `x-video-downloader-master/`, a leftover source-zip name), project docs, tests, and the abandoned-extension scrapyard (whose rank A/B folders were accidentally nested inside the rank S folder, and whose rank A extension was double-nested).

### Changed
- Project folder renamed to **`extension/`** — the single **Load unpacked** target (`manifest.json` at its root). It now contains only browser-loaded files + icons.
- Docs moved to `docs/` (`WORKLIST.md`, `SESSION_HANDOFF.md`, `IMPROVEMENT_LOG.md`); tests to `tests/`; `LICENSE` and the full `README.md` to the repo root.
- Scrapyard flattened to `reference/scrapyard/{rank-s-plucker-xbd, rank-a-video-downloader, rank-b-x-exporter}`; each rank keeps its original `comment and context.txt` and `HOW_TO_INSTALL.txt`; `reference/scrapyard/README.md` documents the reference-only policy and rank table.
- Added `scripts/package-release.sh`: reads the version from `extension/manifest.json` and zips the finished `extension/` folder (manifest at zip root) to `releases/x-media-downloader-v<version>.zip` (optional date tag). Windows/PowerShell fallback documented. `releases/*.zip` is gitignored; `releases/README.md` explains the artifacts.
- `tests/background.test.js` now loads `../extension/background.js`.
- README, WORKLIST (new "P0 — repo layout & release packaging" section), and SESSION_HANDOFF (layout map, branch, commands, priorities) updated to the new paths.

### Unchanged
- Extension code, manifest, and permissions — no product change. Still **no build step**; the release script is distribution packaging only, not a build.

### Validation
- `node --check` on all five extension scripts; all **27** local Node tests pass (`node --test tests/background.test.js`).
- Sample release zip produced and verified with `manifest.json` at the zip root.

## 2026-08-24 — Persistent Side Panel batch queue

**Commit:** `b211e8b Add side panel batch queue foundation`

### Added
- Chrome Side Panel declaration and an **Open batch queue** popup action.
- Side Panel target input for `@username` or an X profile/media URL.
- Default scan cap of **9,999**. This is an upper limit, not an expected result count.
- Persistent queue stored in `chrome.storage.local`.
- Individual item checkboxes, Select all, queue filter, Download selected, Download all, and Clear finished controls.
- Queue rows designed for thumbnail, author, timestamp, media type, and status.
- A one-or-two concurrent download scheduler. A replacement item is scheduled only after Chrome reports an active download terminal (`complete` or `interrupted`).
- Stop behavior that prevents future scheduling while leaving already active Chrome downloads alone.

### Important implementation notes
- The queue state key is `batchDownloadQueueV1`.
- Queue additions use the `queueAdd` runtime message and deduplicate by queue item ID.
- Side Panel UI uses `queueGet`, `queueSelect`, `queueSelectVisible`, `queueStart`, `queueStop`, `queueSetConcurrency`, and `queueClearFinished`.

## 2026-08-24 — Worklist and reference review

**Commit:** `58c2f32 Document queue discovery implementation worklist`

### Added
- `WORKLIST.md` with implementation audit, priority sequencing, reference findings, and validation checklist.

### Reference review completed
- **yt-dlp:** Current `TweetResultByRestId` operation still used query ID `2ICDjqPd81tulZcYrtpTuQ` at review time. It is a reference for single-tweet authenticated GraphQL requests, not a complete profile-media crawler.
- **EltonChou/TwitterMediaHarvest:** Its response cache supports `UserMedia`, `UserTweets`, replies, Likes, Bookmarks, Search, and timeline instruction parsing. This validates an instruction/cursor-based scanner design.
- **afkarxyz/Twitter-X-Media-Batch-Downloader:** Its newest-first media review, selection, status, repost, and progress UX informed this Side Panel direction. Its native-extractor/manual-token architecture is intentionally not copied.

## 2026-08-24 — Profile media discovery connector

**Commit:** `3947598 Add profile media discovery to side panel`

### Added
- Target normalization for `@username`, X profile URLs, and `/media` URLs.
- Discovery state persisted as `profileDiscoveryV1`.
- Signed-in X session check using the existing extension cookie/session mechanism; no manual token, password, or API-key field.
- Runtime operation metadata discovery from JavaScript bundles in an open X tab for:
  - `UserByScreenName`
  - `UserMedia`
- User profile resolution, paginated `UserMedia` requests, bottom-cursor extraction, deduped queue insertion, and terminal conditions:
  - configured cap reached;
  - no cursor;
  - repeated cursor;
  - user stops the scan.
- Discovery UI states: resolving, reading page metadata, fetching page, found count, completed, stopped, and error.
- `Include reposts` now affects profile-media discovery.
- Stop scan control.

### Deliberate boundaries
- Quoted media is intentionally excluded until there is a visible **Include quoted media** option.
- Replies are not yet a separate source mode.
- The implementation requires live X validation: query IDs can be discovered dynamically, but the exact operation variable and response shapes remain subject to X frontend changes.

## 2026-08-24 — Queue retries and download progress

**Commit:** `5ee8ad3 Add queue retry and download progress states`

### Added
- Up to three attempts when a download fails to start or Chrome reports it interrupted.
- **Retry failed** queue action.
- Attempts, byte counts, and total byte counts stored on queue items.
- Per-item percentage display when Chrome publishes `bytesReceived` and `totalBytes` changes.
- Failure reason is retained as a queue-item tooltip.

### Remaining limitation
- Chrome does not always expose total bytes for a CDN transfer; percentage may be unavailable even while a file downloads.
- Retry/backoff timing needs live browser validation against actual CDN failures and rate limiting.

## 2026-08-24 — Exact discovery caps and deterministic counting

### Fixed
- Discovery now counts unique media encountered during the current scan instead of inferring the count from the mutable global queue length.
- The final page is trimmed to the remaining capacity, so a scan cannot overshoot its configured media limit.
- Media repeated across cursor pages no longer consumes the cap more than once.
- Queue additions now reject duplicate IDs within a single incoming batch as well as IDs already in the queue.

### Validation
- Added local Node tests for exact cap selection, cross-page deduplication, and same-batch queue deduplication.
- No live X data or signed-in session is required for these deterministic tests.

## 2026-08-24 — Stable newest-first discovery ordering

### Fixed
- Older cursor pages are now placed after media from earlier, newer pages instead of being prepended ahead of them.
- A scan maintains the order supplied by the profile timeline rather than sorting potentially unreliable timestamps.
- Media already present in the queue is moved into the current scan's authoritative order, while unrelated queue records retain their relative order behind the scanned group.

### Validation
- Added local tests covering multiple discovery pages, an existing unrelated queue record, and repair of matching records left in an older incorrect order.

## 2026-08-24 — Serialized download scheduling

### Fixed
- Queue scheduling passes are now serialized so runtime commands, retry timers, and simultaneous Chrome terminal events cannot reserve slots concurrently.
- Items in both `starting` and `downloading` states consume concurrency slots, preventing a slow `chrome.downloads.download()` callback from allowing extra starts.
- The existing one-or-two active download policy and terminal-event refill behavior remain unchanged.

### Validation
- Added delayed-download tests that issue overlapping scheduling requests and verify only two downloads start, then exactly one replacement starts after a terminal event.
- Added a focused test confirming a `starting` item blocks the sole slot when concurrency is one.

## 2026-08-24 — Atomic discovery startup

### Fixed
- Discovery now claims and persists its running state before tab lookup, authentication, metadata extraction, or network requests begin.
- Concurrent first-use state loads share one initialization promise, preventing two rapid starts from receiving separate state objects.
- Each scan receives a run ID; stale async continuations cannot overwrite the status, errors, or completion state owned by a newer run.
- Discovery-state writes are serialized snapshots so older writes cannot land after newer state.

### Validation
- Added a gated-tab test proving simultaneous Discover requests launch only one scan.
- Added a stale-run test proving an older failed lookup cannot replace newer discovery state.

## 2026-08-25 — Service-worker restart queue reconciliation

### Fixed
- When a service worker restarts, persisted `downloading` items are no longer blindly reset to `queued`. `chrome.downloads.search()` is used to inspect the stored download ID and reconcile the real state:
  - `in_progress` keeps the item as `downloading` and preserves its `downloadId`, so the scheduler does not start a second copy of the same URL.
  - `complete` marks the item `completed`, clears the `downloadId`, and applies the final byte counts.
  - `interrupted` returns the item to `queued` when retry attempts remain, otherwise marks it `failed` and preserves Chrome's error.
  - No matching Chrome download resets the item to `queued` and clears the ghost `downloadId`.
- Persisted `starting` items (a worker killed while `chrome.downloads.download()` was in flight) are now recovered to `queued` instead of being stranded forever.
- Added `chrome.runtime.onStartup` and `chrome.runtime.onInstalled` hooks that reconcile and resume a still-running queue after the browser or extension restarts.

### Validation
- Added a dual callback/promise helper for `chrome.downloads.search()` so the extension works on both modern and legacy Chrome downloads APIs.
- Added local tests covering stranded `starting`, active `in_progress` slot preservation, `complete`, retryable and exhausted `interrupted`, missing download recovery, and restart resume without duplicating an active download.
- All 14 local Node tests pass; no live X data or signed-in session required.

## 2026-08-25 — Direct filenames by post username and text (ZIP export dropped)

### Decision
- ZIP output from the Side Panel queue is intentionally out of scope. A large queue could bundle into a multi-GB archive, so media stays as direct individual files.

### Fixed
- Added `sanitizeFilePart()` and `makeMediaFilename()` helpers.
- Queue downloads are now named `x-media/{username}_{post-text}_{tweetId}_{index}.{ext}` instead of being grouped for a ZIP.
- Multi-photo/video posts remain separate files, numbered by their media index, with `conflictAction: "uniquify"` preventing overwrites.

### Validation
- Added tests that verify a photo and animated GIF from one post use the post username/text in their filenames and that username/text sanitization is deterministic.
- No live X data or signed-in session required.

## 2026-08-25 — Community cap and abandoned-extension scope

### Decision
- Drop the idea of unlocking a "paid tier" or bypassing a third-party license gate. This project is self-hosted and uses only the signed-in X session.
- The abandoned Chrome Web Store X-media extension is a **conceptual reference only** (batch fetch then download, sidebar-style review surface). It has no public source or verifiable license, so it is **not** unpacked, decompiled, or copied. Any aligned behavior is reimplemented locally.
- No third-party account, subscription, activation, or tier-checking service is added. Host permissions remain X/Twitter-only.

### Changed
- Community discovery cap raised from 9,999 to **99,999** in Side Panel, popup, and background discovery.
- Added `normalizeDiscoveryLimit()` for a single deterministic cap rule (invalid/blank → 99,999; zero/negative → 1; higher values clamped to 99,999).

### Validation
- Added a regression test for `normalizeDiscoveryLimit()`.
- All local Node tests pass; no live X data or signed-in session required.

## 2026-08-25 — P0 discovery hardening (errors, countdown, fixtures)

### Added
- `classifyDiscoveryError()` maps transport/API failures to stable codes:
  `rate_limited`, `auth_expired`, `auth_required`, `protected`, `nsfw`,
  `not_found`, `operation_metadata`, `invalid_target`, `unknown`.
- `resolveUserResult()` classifies protected/suspended/missing profiles from
  `UserByScreenName` payloads (`UserUnavailable`).
- Visible rate-limit retry countdown during discovery:
  - `fetchWithRetry()` publishes wait windows via `rateLimitStatusListener`
  - discovery state carries `retryAfterMs`, `retryUntil`, and `errorCode`
  - Side Panel shows a live yellow countdown and keeps it ticking between
    `queueChanged` messages
- Sanitized regression fixtures under `tests/fixtures/`:
  - `user-by-screen-name-ok.json`
  - `user-by-screen-name-protected.json`
  - `user-media-page1.json` (multi-photo, video bitrate pick, repost, tombstone, bottom cursor)
  - `user-media-page2.json` (cursor page)

### Changed
- Discovery GraphQL `features` / `fieldToggles` expanded toward current X web
  timeline request shape (aligned with Rank S Plucker captures; still needs
  live signed-in verification).
- `UserMedia` variables now include `withV2Timeline`, `withVoice`, and
  `withQuickPromoteEligibilityTweetFields`; page size set to 20 to reduce 429s.
- Timeline instruction extraction accepts both `timeline_v2` and legacy
  `timeline` paths.
- Bottom-cursor finder prefers the last `TimelineTimelineCursor` / `Bottom`
  entry (Plucker-style).
- Soft-unwrap skips deleted/NSFW individual timeline entries without aborting
  the whole scan; profile-level failures still stop discovery.
- Session check now also requires an `auth_token` cookie (not only `ct0`).
- Side Panel shows a small **repost** badge on reposted queue items.

### Rank S scrapyard review (supporting only)
- **Plucker XBD (RANK S):** Feature-rich batch UI + media timeline intercept, but
  depends on `apixbd.plucker.io` license/plan gating. Reused only conceptual
  patterns (features blob, cursor entry shape, filename ideas). No third-party
  auth/tier code imported.
- **Rank A action-bar downloader:** Clean local filename/folder helpers and
  action-bar UX; useful later for per-tweet “Add to queue”, not required for P0.
- **Rank B exporter:** Supporting filter/batch code; lower priority UI.

### Validation
- All **23** local Node tests pass (`node --test tests/background.test.js`).
- No live X data or signed-in session required for these tests.
- Live-X checklist in WORKLIST remains open before declaring P0 complete.

## 2026-08-25 — Rank S/A stability review (live capture + download fallbacks)

### Review priority applied
1. **Rank S (Plucker XBD)** first — battle-tested intercept of live GraphQL query IDs, features/variables, and request headers (`authorization`, `x-csrf-token`, `x-client-transaction-id`). Rejected its `apixbd.plucker.io` / plan_code / daily-limit gates.
2. **Rank A** second — Invalid-filename download ladder, photo `format=` extension detection, safer path sanitization.
3. **Rank B** last — ExtPay licensing ignored; no useful GraphQL scanner to port.

### Added
- `injected.js` MAIN-world network bridge (document_start) that observes XHR/fetch GraphQL calls and posts operation metadata + safe headers to the isolated content script.
- `content.js` forwards `xdlNetworkCapture` to the service worker (`networkCapture` message).
- `background.js` capture bag (`__xdlNetworkCapture`) with 30-minute freshness:
  - prefers live `UserMedia` / `UserPhotoTimeline` / `UserVideoTimeline` / `UserByScreenName` query IDs over bundle scrape
  - merges live features/fieldToggles/variables templates into discovery requests
  - reuses `x-client-transaction-id` and other captured X headers
  - never stores Cookie header values in the capture bag
- `downloadFile()` retries with safer path ladder on Chrome `Invalid filename` (Rank S/A pattern).
- `normalizePhotoUrl()` forces `name=orig` while preserving `format=`.
- Discovery stops after repeated empty pages (in addition to missing/repeated cursor).
- Manifest v3.1: MAIN-world content script, dropped unused `webRequest` permission.

### Deliberately not ported
- Any third-party account, license, activation, tier, or daily download counter.
- Plucker’s external webapp task pipeline.
- Rank B ExtPay payment hooks.

### Validation
- All **27** local Node tests pass.
- No live X session required for unit tests; live signed-in validation still required for P0 complete.

## 2026-08-25 — Deprecation cleanup after big rewrite

### Removed (no longer fits product)
- Entire ZIP path: `lib/zip-writer.js`, `importScripts` of zip-writer, `zipBuffers`, runtime handlers `downloadZip` and `fetchAsArrayBuffer`.
- Legacy unused runtime handlers: `getVideoUrl`, `downloadVideo` (nothing in-tree called them).
- Dead bulk flags in `content.js`: `useZip`, `bulkId`.
- Accidental single-tweet fallback to `TweetDetail` operation name (incompatible variables/response vs `TweetResultByRestId`).

### Fixed / clarified
- `getTweetMedia` stays on `TweetResultByRestId` only; may still use a **live-captured query id** for that operation.
- Header comment and architecture docs no longer claim ZIP packaging is active.
- Handoff/worklist now include an explicit “code-review checklist” for missing logic and accidental shipment.

### Still intentional (not deleted)
- Popup DOM auto-scroll bulk mode — legacy but still product-supported until a Side Panel migration.
- Public Bearer fallback + bundle scrape — fallbacks when live capture is cold.
- Rank S capture bridge — local reimplementation, not third-party.

### Validation
- Syntax check + full Node test suite after cleanup.

## 2026-08-25 — Side Panel scroll-capture first UX

### Motivation
Live testing showed the remote paste-link profile crawler works but is subpar as the primary UX because background fetching can trigger X rate limits more readily than user-driven scrolling. The popup bulk flow also made scroll capture and the Side Panel queue feel like separate products.

### Changed
- Side Panel now opens to a two-tab layout:
  - **Scroll capture** (default): watches the active X tab while the user scrolls and lists captured media for review/download.
  - **Remote fetch**: keeps the existing paste-link GraphQL discovery as an advanced fallback.
- Added optional Side Panel auto-scroll controls for the default Scroll capture tab while keeping manual scrolling as the main path.
- Added an **× clear target** button to the Remote fetch input.
- Added **Clear history** for the current Side Panel tab instead of only clearing completed/failed items.
- Queue actions now operate against the active tab source, so scroll-captured and remote-fetched items are reviewed separately in the Side Panel.
- MAIN-world network capture now also observes GraphQL responses from X's own page requests and forwards media timeline content to the extension so user scrolling can populate the queue without initiating a separate profile crawl.
- Content script now sends visible DOM photo items to the queue while Scroll capture is watching, covering already-rendered photos in addition to response-captured timeline media.

### Validation
- `node --check extension/background.js extension/content.js extension/popup.js extension/sidepanel.js extension/injected.js`
- `node --test tests/background.test.js` — all 27 tests pass.

### Notes
- Video listing from manual scrolling is strongest when X timeline GraphQL responses are captured; already-rendered photos are additionally detected from the DOM.
- The old popup remains available for now, but the Side Panel is now the primary scroll-capture/review/download surface.
