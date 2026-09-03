// Exercise the real extension/injected.js (MAIN-world network observer) inside
// a VM with a minimal window/XHR/fetch/history shim. Two behaviours are pinned:
//   1. The cheap media-marker walk forwards only media-bearing GraphQL payloads
//      (no full JSON.stringify of every non-media response).
//   2. The replay buffer stays bounded (count AND bytes) so a burst of large
//      timeline responses cannot pin the MAIN-world heap.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadInjected() {
  const posts = [];
  const listeners = [];
  // A media-bearing GraphQL payload (timeline-shaped, marker nested deep).
  const mediaBody = {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [{
                entries: [{
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: "Tweet",
                          rest_id: "1001",
                          legacy: {
                            full_text: "a media post",
                            extended_entities: {
                              media: [{
                                id_str: "m1",
                                type: "photo",
                                media_url_https: "https://pbs.example.com/media/m1.jpg"
                              }]
                            }
                          }
                        }
                      }
                    }
                  }
                }]
              }]
            }
          }
        }
      }
    }
  };
  // A non-media GraphQL payload (e.g. a metrics poll / empty profile metadata).
  const nonMediaBody = {
    data: { user: { result: { legacy: { screen_name: "demo", name: "Demo" } } } }
  };

  const context = {
    URL,
    console,
    Date,
    setTimeout,
    clearTimeout,
    location: { href: "https://x.com/home", origin: "https://x.com" },
    postMessage: (message) => { posts.push(message); },
    addEventListener: (type, fn) => { listeners.push({ type, fn }); },
    history: { pushState() {}, replaceState() {} },
    XMLHttpRequest: function () {},
    // fetch returns a Response-like that the patch clones + parses.
    fetch: async (_resource, _init) => {
      const resource = String(_resource && _resource.url ? _resource.url : _resource || "");
      const isMediaOp = /\/graphql\/[^/]+\/(UserMedia|UserPhotoTimeline|UserVideoTimeline|TweetResultByRestId)/.test(resource);
      return {
        url: resource,
        clone: () => ({ json: async () => (isMediaOp ? mediaBody : nonMediaBody) })
      };
    }
  };
  context.window = context;
  context.globalThis = context;
  context.global = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "injected.js"), "utf8");
  vm.runInContext(source, context, { filename: "injected.js" });

  // The MAIN-world observer gates on `event.source === window`. In the browser
  // that is the same window; in the VM the contextified `window` is a distinct
  // object from the Node `context` reference, so grab the real one to dispatch.
  const windowRef = vm.runInContext("window", context);
  const messageListener = listeners.find((l) => l.type === "message")?.fn;
  const requestReplay = (since) => {
    assert.ok(messageListener, "message listener registered");
    messageListener({ source: windowRef, data: { source: "XDL_CONTENT", type: "xdlRequestReplay", since } });
  };
  const graphqlUrl = (op) => `https://x.com/i/api/graphql/abc123/${op}?variables=x`;

  return {
    context,
    posts,
    graphqlUrl,
    requestReplay,
    typePosts: (type) => posts.filter((p) => p.type === type)
  };
}

test("injected forwards media-bearing payloads and skips non-media ones before stringify", async () => {
  const injected = loadInjected();

  await injected.context.fetch(injected.graphqlUrl("UserMedia"));
  // Non-media op same shape but no marker → must not be forwarded.
  await injected.context.fetch(injected.graphqlUrl("UserByScreenName"));

  const graphqlPosts = injected.typePosts("xdlGraphqlResponse");
  assert.equal(graphqlPosts.length, 1, "only the media-bearing payload is forwarded");
  assert.equal(graphqlPosts[0].data.operationName, "UserMedia");
  // The forwarded entry is the parsed JSON body, not a pre-serialized string.
  assert.equal(typeof graphqlPosts[0].data.json, "object");
  assert.ok(graphqlPosts[0].data.json.data.user.result.timeline_v2, "media body forwarded intact");
});

test("injected replay buffer is bounded by count during a burst of media responses", async () => {
  const injected = loadInjected();

  // 45 media-bearing responses: the buffer keeps at most REPLAY_MAX (40) newest.
  for (let i = 0; i < 45; i++) {
    await injected.context.fetch(injected.graphqlUrl("UserPhotoTimeline"));
  }

  const forwarded = injected.typePosts("xdlGraphqlResponse");
  // Limit the check to non-replay forwards (the "live" emissions).
  const liveCount = forwarded.filter((p) => !p.replay).length;
  assert.equal(liveCount, 45, "every media response is forwarded live");

  injected.requestReplay();
  const replayed = injected.typePosts("xdlGraphqlResponse").filter((p) => p.replay).length;
  assert.equal(replayed, 40, "replay buffer holds at most 40 entries");
  const replayDone = injected.typePosts("xdlReplayDone")[0];
  assert.equal(replayDone.data.count, 40);
});

// v3.7: the isolated world now asks for a replay "since" the newest sequence
// number it already handled, because shallow fetch passes run on every tab open
// and route change. Without the filter each pass re-structured-cloned the whole
// (up to ~8 MB) buffer across worlds again.
test("injected replays only what the isolated world has not seen yet", async () => {
  const injected = loadInjected();

  await injected.context.fetch(injected.graphqlUrl("UserMedia"));
  await injected.context.fetch(injected.graphqlUrl("UserMedia"));
  const live = injected.typePosts("xdlGraphqlResponse").filter((post) => !post.replay);
  assert.equal(live.length, 2);
  assert.deepEqual(live.map((post) => post.data.seq), [1, 2], "entries carry a monotonic seq");

  injected.requestReplay(1);
  const replayed = injected.typePosts("xdlGraphqlResponse").filter((post) => post.replay);
  assert.equal(replayed.length, 1, "only seq 2 is newer than the caller's cursor");
  assert.equal(replayed[0].data.seq, 2);
  assert.equal(injected.typePosts("xdlReplayDone")[0].data.count, 1);
  assert.equal(injected.typePosts("xdlReplayDone")[0].data.lastSeq, 2);

  // A caller with no cursor (older content script) still gets everything.
  injected.requestReplay();
  assert.equal(injected.typePosts("xdlGraphqlResponse").filter((post) => post.replay).length, 3);
});
