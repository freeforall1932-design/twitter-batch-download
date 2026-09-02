// Naming engine tests (extension/lib/naming.js): the template checkboxes'
// helpers, the render engine, per-segment sanitizing, master-folder path
// building, and the archive base name. Ported/adapted from the sister repo
// nh-dw-2.0 (nameTemplate + sanitizeArtifactFilename suites).

const assert = require("node:assert/strict");
const test = require("node:test");

const naming = require("../extension/lib/naming.js");

test("defaults: template, master folder, format whitelist", () => {
  assert.equal(naming.DEFAULT_NAME_TEMPLATE, "{user} - {text} - {id}");
  assert.equal(naming.DEFAULT_RAW_MASTER_FOLDER, "XMedia");
  assert.equal(naming.normalizeOutputFormat("zip"), "zip");
  assert.equal(naming.normalizeOutputFormat("CBZ"), "cbz");
  assert.equal(naming.normalizeOutputFormat("pdf"), "pdf");
  assert.equal(naming.normalizeOutputFormat("raw"), "raw");
  // Whitelist: corrupt/legacy values degrade to raw, never to an archive.
  assert.equal(naming.normalizeOutputFormat("folder"), "raw");
  assert.equal(naming.normalizeOutputFormat(undefined), "raw");
  assert.equal(naming.normalizeOutputFormat(42), "raw");
});

test("normalizeRawMasterFolder: undefined = default, empty string = OFF", () => {
  assert.equal(naming.normalizeRawMasterFolder(undefined), "XMedia");
  assert.equal(naming.normalizeRawMasterFolder(null), "XMedia");
  assert.equal(naming.normalizeRawMasterFolder(""), "");
  assert.equal(naming.normalizeRawMasterFolder("   "), "");
  assert.equal(naming.normalizeRawMasterFolder(" Stash "), "Stash");
});

test("sanitizeArtifactFilename keeps structure, cleans per segment", () => {
  assert.equal(naming.sanitizeArtifactFilename("XMedia/Some Post/001.jpg", "x"), "XMedia/Some Post/001.jpg");
  assert.equal(naming.sanitizeArtifactFilename("Post.zip", "x"), "Post.zip");
  // Reserved characters stripped per segment, structure preserved.
  assert.equal(naming.sanitizeArtifactFilename('My:Folder*/a?b/001.jpg', "x"), "MyFolder/ab/001.jpg");
  // Leading dots and trailing dots/spaces dropped (Windows rejects them).
  assert.equal(naming.sanitizeArtifactFilename("..secret/name. . /f.jpg", "x"), "secret/name/f.jpg");
  // Absolute paths and dot-dot segments cannot survive.
  assert.equal(naming.sanitizeArtifactFilename("/abs/path.jpg", "x"), "abs/path.jpg");
  assert.equal(naming.sanitizeArtifactFilename("../../up.jpg", "x"), "up.jpg");
  // Over-long segments capped at 120 chars.
  const long = "a".repeat(200);
  assert.equal(naming.sanitizeArtifactFilename(`${long}/f.jpg`, "x"), `${"a".repeat(120)}/f.jpg`);
  // Nothing usable left → fallback stem, then "download".
  assert.equal(naming.sanitizeArtifactFilename("???", "Backup"), "Backup");
  assert.equal(naming.sanitizeArtifactFilename(":::", "***"), "download");
  // Invisible bidi/format control characters are stripped so mixed-script and
  // RTL post text cannot scramble the folder name, while visible non-ASCII
  // (CJK / emoji / Arabic) survives. Regression for the naming degarble pass.
  assert.equal(naming.sanitizeArtifactFilename("nasa - M\u202Eabc\u202C [test] - 123/001.jpg", "x"), "nasa - Mabc [test] - 123/001.jpg");
  assert.equal(naming.sanitizeArtifactFilename("\u200Bok\u200E\u202E\u2066\u2069\uFEFFname", "x"), "okname");
  assert.equal(naming.sanitizeArtifactFilename("今天天气很好 这是一个测试帖子", "x"), "今天天气很好 这是一个测试帖子");
  assert.equal(naming.sanitizeArtifactFilename("🎉🎉🎉 big win", "x"), "🎉🎉🎉 big win");
});

test("template helpers: token detection, custom detection, rebuild order", () => {
  assert.deepEqual(naming.templateTokensInUse("{user} - {text} - {id}"), {
    user: true, name: false, text: true, id: true, date: false
  });
  assert.ok(naming.isTokenOnlyTemplate("{user} - {text} - {id}"));
  assert.ok(naming.isTokenOnlyTemplate(""));
  assert.ok(naming.isTokenOnlyTemplate("{id}_{date}"));
  // Literal words make it a custom template (manual input instead).
  assert.ok(!naming.isTokenOnlyTemplate("X {user} [{id}]"));
  assert.ok(!naming.isTokenOnlyTemplate("{unknown}"));
  // Checked boxes rebuild in canonical order, " - " separated; the default
  // checked set reproduces the default template byte for byte.
  assert.equal(
    naming.buildTemplate({ user: true, text: true, id: true }),
    naming.DEFAULT_NAME_TEMPLATE
  );
  assert.equal(naming.buildTemplate({ id: true, date: true, user: true }), "{user} - {id} - {date}");
  assert.equal(naming.buildTemplate({}), "");
});

const POST = {
  user: "nasa",
  name: "NASA",
  text: "Sunrise over the Pacific https://t.co/x #space @iss",
  id: "1834567890123456789",
  date: "Wed Aug 26 09:15:00 +0000 2026"
};

test("renderNameTemplate: tokens, text trimming, date stamp, separators", () => {
  assert.equal(
    naming.renderNameTemplate("{user} - {text} - {id}", POST),
    "nasa - Sunrise over the Pacific space - 1834567890123456789"
  );
  assert.equal(naming.renderNameTemplate("{name} ({date})", POST), "NASA (2026-08-26)");
  // Empty fields collapse dangling separators instead of leaving "a -  - b".
  assert.equal(
    naming.renderNameTemplate("{user} - {name} - {id}", { user: "bob", id: "7" }),
    "bob - 7"
  );
  // Custom literal text survives.
  assert.equal(naming.renderNameTemplate("X {user} [{id}]", { user: "@bob", id: "7" }), "X bob [7]");
  // {text} trims to ~40 chars on a word boundary.
  const longText = naming.renderNameTemplate("{text}", { text: "word ".repeat(30) });
  assert.ok(longText.length <= 40, `trimmed: ${longText}`);
});

test("makePostBaseName: single segment, reserved names, id fallback", () => {
  // Slashes in post text must not create folders.
  assert.equal(
    naming.makePostBaseName("{text} - {id}", { text: "a/b\\c", id: "9" }),
    "a b c - 9"
  );
  // Windows device names get prefixed so Chrome can still save.
  assert.equal(naming.makePostBaseName("{text}", { text: "CON", id: "9" }), "_CON");
  assert.equal(naming.makePostBaseName("{text}", { text: "com1", id: "9" }), "_com1");
  // A degenerate rendered name falls back to the post id, then "post".
  assert.equal(naming.makePostBaseName("{text}", { text: "???", id: "123" }), "123");
  assert.equal(naming.makePostBaseName("", { id: "123" }), "123");
  assert.equal(naming.makePostBaseName("", {}), "post");
  // A token whose only content gets stripped by sanitizing still collapses the
  // leftover separators so the folder name never shows a double empty gap
  // ("nasa -  - 111" → "nasa - 111"). Regression for the naming pass.
  assert.equal(
    naming.makePostBaseName(naming.DEFAULT_NAME_TEMPLATE, { user: "nasa", text: "???", id: "111" }),
    "nasa - 111"
  );
  assert.equal(
    naming.buildRawMediaPath({}, { user: "nasa", text: "???", id: "111" }, 0, "jpg", "legacy"),
    "XMedia/nasa - 111/001.jpg"
  );
});

test("buildRawMediaPath: master folder on/off/nested/sanitized", () => {
  const fields = { user: "nasa", text: "Hello world", id: "111" };
  // Default master folder.
  assert.equal(
    naming.buildRawMediaPath({}, fields, 0, "jpg", "x-media/legacy_1.jpg"),
    "XMedia/nasa - Hello world - 111/001.jpg"
  );
  // Custom name; slashes nest deeper.
  assert.equal(
    naming.buildRawMediaPath({ rawMasterFolder: "Stash/raw" }, fields, 3, "png", "x-media/legacy_4.png"),
    "Stash/raw/nasa - Hello world - 111/004.png"
  );
  // EMPTY STRING = OFF: the legacy flat filename comes back verbatim.
  assert.equal(
    naming.buildRawMediaPath({ rawMasterFolder: "" }, fields, 0, "jpg", "x-media/legacy_1.jpg"),
    "x-media/legacy_1.jpg"
  );
  // Weird user-typed folder names sanitize per segment.
  assert.equal(
    naming.buildRawMediaPath({ rawMasterFolder: 'My:Folder* ' }, fields, 1, "jpg", "x-media/legacy_2.jpg"),
    "MyFolder/nasa - Hello world - 111/002.jpg"
  );
});

test("buildArchiveFilename: templated base + whitelisted extension", () => {
  const fields = { user: "nasa", text: "Hello world", id: "111" };
  assert.equal(naming.buildArchiveFilename({}, fields, "zip"), "nasa - Hello world - 111.zip");
  assert.equal(naming.buildArchiveFilename({ nameTemplate: "{id}" }, fields, "cbz"), "111.cbz");
  assert.equal(naming.buildArchiveFilename({ nameTemplate: "{text}" }, { text: "???", id: "42" }, "pdf"), "42.pdf");
});
