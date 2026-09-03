// ==========================================================================
// lib/naming.js — shared naming + output-path engine (v3.5).
//
// Ported from the sister project nh-dw-2.0 (PR #30 / commit 9f86426:
// `Downloader.ts` `sanitizeArtifactFilename` + `normalizeRawMasterFolder`,
// `options/nameTemplate.ts`, `utils.ts` `getDownloadName`/`cleanName`) and
// adapted to X post metadata. One file, three consumers:
//
//   - background.js  (service worker, via importScripts)
//   - sidepanel.html (settings UI + live preview, via <script>)
//   - tests/         (Node, via require)
//
// Settings this engine understands (chrome.storage.sync, written ONLY by the
// Side Panel settings card; every downloading context receives them through a
// plain settings bag — an offscreen document must never read storage itself):
//
//   rawMasterFolder  string  default "XMedia". Top-level folder that collects
//                            raw (loose file) downloads as
//                            <Master>/<post name>/001.jpg…  EMPTY STRING = OFF
//                            (the historical flat x-media/ layout, exactly).
//                            Slashes nest deeper ("XMedia/raw").
//   nameTemplate     string  default "{user} - {text} - {id}". Token template
//                            for the per-post base name (raw folder name and
//                            archive file name).
//   outputFormat     string  "raw" | "zip" | "cbz" | "pdf", default "raw".
// ==========================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XDLNaming = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Canonical checkbox order. Joined with " - ", the default checked set
  // (user, text, id) reproduces DEFAULT_NAME_TEMPLATE exactly.
  const TEMPLATE_TOKENS = ["user", "name", "text", "id", "date"];
  const DEFAULT_NAME_TEMPLATE = "{user} - {text} - {id}";
  const DEFAULT_RAW_MASTER_FOLDER = "XMedia";
  const DEFAULT_USER_FOLDERS = true;
  const OUTPUT_FORMATS = ["raw", "zip", "cbz", "pdf"];

  // Windows device names that cannot be used as file/folder names even with
  // an extension (CON.zip, NUL.jpg, COM1.png, …). Kept uppercase for
  // case-insensitive matching; prefixed with "_" so Chrome can still save.
  const RESERVED_WINDOWS_NAMES = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
  ]);

  // Copied from nh-dw-2.0 Downloader.ts: keep the subfolder structure
  // (a/b/c.jpg), strip control and reserved characters PER SEGMENT, drop
  // leading dots and trailing dots/spaces (Windows rejects those), bound
  // segment length, and fall back when nothing usable is left. Runs right
  // before chrome.downloads.download for every artifact. Never returns an
  // absolute path or a ".." segment (both are cleaned away).
  function sanitizeArtifactFilename(filename, fallbackStem) {
    const segments = String(filename).split("/");
    const cleanedSegments = [];
    for (const segment of segments) {
      let cleaned = segment
        .replace(/[\x00-\x1f\x7f]/g, "")
        // Invisible bidi/format control characters scramble mixed-script and
        // RTL folder names in file explorers (and in Chrome's own filename
        // handling). Strip them so a post with bidi controls does not yield a
        // "garbled" name. Keeps visible non-ASCII (CJK, emoji, Arabic, …).
        .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
        .replace(/[\\:*?"<>|]/g, "")
        .replace(/^\.+/, "")
        .replace(/[. ]+$/g, "");
      if (cleaned.length > 120) {
        cleaned = cleaned.slice(0, 120).replace(/[. ]+$/g, "");
      }
      if (cleaned !== "") {
        cleanedSegments.push(cleaned);
      }
    }
    let joined = cleanedSegments.join("/");
    if (joined === "" || joined === "/") {
      joined = sanitizeArtifactFilename(String(fallbackStem || "download"), "download");
    }
    return joined;
  }

  // undefined/null → the default master folder; an explicit empty (or
  // whitespace-only) string is meaningful: it DISABLES the master folder.
  function normalizeRawMasterFolder(value) {
    if (value === undefined || value === null) {
      return DEFAULT_RAW_MASTER_FOLDER;
    }
    return String(value).trim();
  }

  // Whitelist: a corrupt or legacy stored value must fall back to "raw"
  // (this extension's historical behavior), never to an archive format.
  function normalizeOutputFormat(value) {
    const normalized = String(value || "").toLowerCase();
    return OUTPUT_FORMATS.includes(normalized) ? normalized : "raw";
  }

  // ---- name template (checkbox UI helpers) --------------------------------

  // Which tokens the stored template uses (order-insensitive detection).
  function templateTokensInUse(template) {
    const result = {};
    const text = String(template || "");
    for (const token of TEMPLATE_TOKENS) {
      result[token] = text.indexOf("{" + token + "}") !== -1;
    }
    return result;
  }

  // True when the stored template is fully representable by the checkboxes:
  // only known placeholders plus whitespace / simple separators. Anything
  // else (literal words, custom ordering) is a "custom" template and the UI
  // falls back to a manual input so nothing is lost.
  function isTokenOnlyTemplate(template) {
    const stripped = String(template || "").replace(
      /\{(user|name|text|id|date)\}/g,
      ""
    );
    return /^[\s\-_,.()]*$/.test(stripped);
  }

  // Rebuild the placeholder string from the checked boxes, in the canonical
  // order, joined by " - ". No boxes checked = empty template (names then
  // fall back to the post id).
  function buildTemplate(checked, separator) {
    const parts = [];
    for (const token of TEMPLATE_TOKENS) {
      if (checked && checked[token]) {
        parts.push("{" + token + "}");
      }
    }
    return parts.join(separator === undefined ? " - " : separator);
  }

  // ---- template rendering --------------------------------------------------

  // Post text as a name fragment: URLs and @mentions dropped, hashtags kept
  // as words, whitespace collapsed, trimmed to ~40 chars on a word boundary.
  function textSnippet(text) {
    let cleaned = String(text || "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/@\w+/g, "")
      .replace(/#(\w+)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length > 40) {
      cleaned = cleaned.slice(0, 40);
      const lastSpace = cleaned.lastIndexOf(" ");
      if (lastSpace > 20) cleaned = cleaned.slice(0, lastSpace);
      cleaned = cleaned.trim();
    }
    return cleaned;
  }

  // {date} renders as YYYY-MM-DD; X serves created_at like
  // "Wed Aug 26 09:15:00 +0000 2026" and the DOM <time datetime> is ISO.
  function dateStamp(value) {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
  }

  // The engine analog of nh-dw's utils.getDownloadName: replace each token
  // with the post's field. Unknown text is left alone so custom templates
  // ("X {user} [{id}]") keep working. Empty fields can leave dangling
  // separators — collapseSeparators() cleans those up afterwards.
  function renderNameTemplate(template, fields) {
    const source = fields || {};
    let out = String(template === undefined || template === null ? DEFAULT_NAME_TEMPLATE : template);
    out = out.replace(/\{user\}/g, String(source.user || "").replace(/^@/, ""));
    out = out.replace(/\{name\}/g, String(source.name || ""));
    out = out.replace(/\{text\}/g, textSnippet(source.text));
    out = out.replace(/\{id\}/g, String(source.id || ""));
    out = out.replace(/\{date\}/g, dateStamp(source.date));
    return collapseSeparators(out);
  }

  // "user -  - id" (empty {name}) → "user - id"; also trims leading/trailing
  // separators left behind by empty tokens at the edges.
  function collapseSeparators(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/(?:\s*-\s*){2,}/g, " - ")
      .replace(/^[\s\-_,.]+/, "")
      .replace(/[\s\-_,.]+$/, "")
      .trim();
  }

  // Per-post base name: renders the template, forces a SINGLE path segment
  // (slashes in post text must not create folders), prefixes reserved
  // Windows device names, and falls back to the post id — then "post" — when
  // the rendered name degenerates to nothing.
  function makePostBaseName(template, fields) {
    const source = fields || {};
    let base = renderNameTemplate(template, source).replace(/[/\\]+/g, " ");
    // sanitizeArtifactFilename strips reserved characters, so a token whose
    // only content was such a character (e.g. text "???") would leave an empty
    // slot and a dangling " - " in the middle ("nasa -  - 111"). Collapse the
    // separators AFTER sanitizing so those gaps close up. This runs BEFORE the
    // reserved-name prefix is added, so a "_CON" prefix is never stripped.
    base = collapseSeparators(sanitizeArtifactFilename(base, "").split("/").join(" "));
    if (base === "" || base === "download") {
      base = collapseSeparators(String(source.id || "").trim());
    }
    if (base === "") base = "post";
    const stem = base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
    if (RESERVED_WINDOWS_NAMES.has(stem.toUpperCase())) {
      base = "_" + base;
    }
    return base;
  }

  // 0-based media index → zero-padded per-post file number ("001"…"004").
  function pageNumber(index) {
    const n = Number(index);
    const safe = Number.isFinite(n) && n >= 0 ? Math.floor(n) + 1 : 1;
    return String(safe).padStart(3, "0");
  }

  // One clean folder segment for the user the media is sourced FROM (the
  // owning post's author — reposts/quotes are already attributed to their
  // real owner upstream). Empty when no handle is known; the build functions
  // then fall back to the master-folder-root layout rather than an "unknown"
  // bucket. Must be a SINGLE segment: a malicious/odd handle can never create
  // nested folders.
  function userFolderName(fields) {
    const user = String(fields?.user || "").replace(/^@/, "").trim();
    if (!user) return "";
    return sanitizeArtifactFilename(user, "").split("/").join(" ");
  }

  // True when `base` already names the user (template contains {user} first):
  // avoids "nasa - nasa - …" when the username is prefixed automatically.
  function baseNamesUser(base, user) {
    if (!user || !base) return false;
    const lowerBase = base.toLowerCase();
    const lowerUser = user.toLowerCase();
    return lowerBase === lowerUser || lowerBase.startsWith(lowerUser + " ");
  }

  // Raw (loose file) download path for one media item of a post.
  //   Master folder ON, user folders ON (default)
  //      → <Master>/<user>/<base name>/001.jpg
  //     The per-user segment is the owning post's author, so media sourced
  //     from different pages (home timeline, profile, /media, single post)
  //     lands in the SAME user folder — the folder itself doubles as a visual
  //     dedupe: same user + same post name + same byte-verified media = one
  //     path, one file.
  //   Master folder ON, user folders OFF
  //      → <Master>/<base name>/001.jpg  (pre-v3.11 layout)
  //   Master folder OFF → the historical flat layout, byte-for-byte: the
  //                       caller passes legacyFilename (x-media/…), which is
  //                       returned unchanged so emptying the box restores the
  //                       old behavior exactly.
  function buildRawMediaPath(settings, fields, index, extension, legacyFilename) {
    const master = normalizeRawMasterFolder(settings ? settings.rawMasterFolder : undefined);
    if (master === "") {
      return legacyFilename || null;
    }
    const base = makePostBaseName(settings ? settings.nameTemplate : undefined, fields);
    const ext = String(extension || "bin").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    const leaf = pageNumber(index) + "." + ext;
    const user = settings && settings.userFolders === false ? "" : userFolderName(fields);
    const root = user ? master + "/" + user : master;
    return sanitizeArtifactFilename(
      root + "/" + base + "/" + leaf,
      DEFAULT_RAW_MASTER_FOLDER + "/" + (user ? user + "/" : "") + (String(fields && fields.id ? fields.id : "post")) + "/" + leaf
    );
  }

  // Archive (zip/cbz/pdf) file name for one post: "<base name>.<format>".
  // Blob archives are saved by an in-document anchor click (see
  // offscreen.js), whose download attribute cannot carry folders — archives
  // therefore always land at the download-directory root. Because a folder
  // per user is impossible for archives, the username is FORCED into the
  // file name when the user's template would omit it (e.g. a "{text} - {id}"
  // template gets "nasa - text - id.zip"), so files from different users can
  // always be told apart.
  function buildArchiveFilename(settings, fields, format) {
    let base = makePostBaseName(settings ? settings.nameTemplate : undefined, fields);
    const user = settings && settings.userFolders === false ? "" : userFolderName(fields);
    if (user && !baseNamesUser(base, user)) {
      base = user + " - " + base;
    }
    const ext = normalizeOutputFormat(format);
    return sanitizeArtifactFilename(base + "." + (ext === "raw" ? "zip" : ext), "post." + ext);
  }

  return {
    TEMPLATE_TOKENS,
    DEFAULT_NAME_TEMPLATE,
    DEFAULT_RAW_MASTER_FOLDER,
    DEFAULT_USER_FOLDERS,
    OUTPUT_FORMATS,
    sanitizeArtifactFilename,
    normalizeRawMasterFolder,
    normalizeOutputFormat,
    templateTokensInUse,
    isTokenOnlyTemplate,
    buildTemplate,
    textSnippet,
    dateStamp,
    renderNameTemplate,
    makePostBaseName,
    pageNumber,
    userFolderName,
    buildRawMediaPath,
    buildArchiveFilename
  };
});
