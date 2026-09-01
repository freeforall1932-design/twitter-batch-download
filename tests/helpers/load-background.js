// Shared VM harness for background.js suites. tests/background.test.js keeps
// its own inline copy (it predates this helper and layers extra spies);
// new suites should require this one.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground(options = {}) {
  const stored = { ...(options.stored || {}) };
  const syncStored = { ...(options.syncStored || {}) };
  const downloadChangedListeners = [];
  const context = {
    Blob,
    TextEncoder,
    URL,
    URLSearchParams,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    clearTimeout,
    console,
    fetch: options.fetch || (async () => { throw new Error("Unexpected network request in unit test"); }),
    // Run the real lib/ files in the VM context, exactly like the worker.
    importScripts: (...files) => {
      for (const file of files) {
        const libSource = fs.readFileSync(path.join(__dirname, "..", "..", "extension", file), "utf8");
        vm.runInContext(libSource, context, { filename: file });
      }
    },
    setTimeout,
    chrome: {
      cookies: {
        get: (_details, callback) => callback(null),
        getAll: (_details, callback) => callback([])
      },
      downloads: {
        download: options.download || ((_downloadOptions, callback) => callback(1)),
        search: options.downloadsSearch || (async () => []),
        onChanged: { addListener: (listener) => downloadChangedListeners.push(listener) }
      },
      ...(options.offscreen ? { offscreen: options.offscreen } : {}),
      runtime: {
        lastError: null,
        onInstalled: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        sendMessage: options.runtimeSendMessage || (async () => {})
      },
      scripting: { executeScript: async () => [] },
      storage: {
        local: {
          get: async (key) => ({ [key]: stored[key] }),
          set: async (values) => { Object.assign(stored, values); }
        },
        sync: {
          get: (defaults, callback) => {
            const out = defaults && typeof defaults === "object" ? { ...defaults } : {};
            for (const key of Object.keys(out)) {
              if (key in syncStored) out[key] = syncStored[key];
            }
            callback(out);
          },
          set: async (values) => { Object.assign(syncStored, values); }
        }
      },
      tabs: { query: async () => [] }
    }
  };
  context.globalThis = context;
  context.global = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  context.emitDownloadChange = async (delta) => {
    await Promise.all(downloadChangedListeners.map((listener) => listener(delta)));
  };
  context.__syncStored = syncStored;
  context.__stored = stored;
  return context;
}

module.exports = { loadBackground };
