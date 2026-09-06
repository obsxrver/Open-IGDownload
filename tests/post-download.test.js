"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadContent(api, relay) {
  const context = vm.createContext({ URL, location: { href: "https://www.instagram.com/" },
    document: { querySelectorAll: () => [] }, setTimeout: (callback) => callback(), api, relay });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/lib.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  // Exercise the actual post resolver without starting the page UI.
  vm.runInContext(source.slice(0, source.lastIndexOf("  start().catch")) + `
    instagramJson = api;
    bridge = relay;
    globalThis.resolver = { mediaIdentity, postItems, collectProfileMedia, writeProfileMedia };
  })();`, context);
  return context.resolver;
}

function article({ annotation = "0", href = "/p/Dcfgq55AXr_/", slides = 5 } = {}) {
  const image = { naturalWidth: 1080, naturalHeight: 1440, clientWidth: 468,
    src: "https://scontent.cdninstagram.com/first.jpg" };
  const descendant = { getAttribute: () => "3972037082230127359" };
  return {
    getAttribute: () => annotation,
    closest: () => null,
    querySelector(selector) {
      if (selector.startsWith("a[")) return href ? { href } : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.startsWith("[data-")) return [descendant];
      if (selector.startsWith("._acnb")) return Array.from({ length: slides }, (_, i) => ({
        getAttribute: () => `Go to slide ${i + 1}`,
      }));
      if (selector === "img") return [image];
      // Only the first two of five slides are mounted in the supplied feed DOM.
      if (selector.startsWith("li.")) return Array.from({ length: Math.min(slides, 2) }, () => ({ querySelector: () => image }));
      return [];
    },
  };
}

function carousel(count = 5) {
  return { media_type: 8, carousel_media_count: 5, carousel_media: Array.from({ length: count }, (_, i) => ({
    pk: String(100 + i), media_type: i === 2 ? 2 : 1,
    ...(i === 2 ? { video_url: "https://scontent.cdninstagram.com/2.mp4" }
      : { display_url: `https://scontent.cdninstagram.com/${i}.jpg` }),
  })) };
}

test("home feed permalink overrides zero and child annotations and resolves every carousel item", async () => {
  const requests = [];
  const resolver = loadContent(async (url) => {
    requests.push(url);
    return { items: [carousel()] };
  }, () => { throw new Error("Unexpected fallback"); });
  for (const annotation of ["0", "3972035859867557829"]) {
    const post = article({ annotation });
    const identity = resolver.mediaIdentity(post);
    assert.notEqual(identity.id, annotation);
    const items = await resolver.postItems(post);
    assert.equal(requests.at(-1), `/api/v1/media/${identity.id}/info/`);
    assert.equal(items.length, 5);
    assert.equal(items.map((item) => item.pk).join(","), "100,101,102,103,104");
    assert.equal(items[2].mediaType, "video");
  }
});

test("zero annotation is skipped when a post has no permalink", () => {
  const resolver = loadContent();
  assert.equal(resolver.mediaIdentity(article({ href: null })).id, "3972037082230127359");
});

test("partial API carousels retry the shortcode loader", async () => {
  const resolver = loadContent(async () => ({ items: [carousel(1)] }), async (procedure, data) => {
    assert.equal(procedure, "load-post");
    assert.equal(data.shortcode, "Dcfgq55AXr_");
    return carousel();
  });
  assert.equal((await resolver.postItems(article())).length, 5);
  assert.equal((await resolver.postItems(article(), 2))[0].pk, "102");
});

test("failed or partial carousel lookups never silently download one DOM image", async () => {
  for (const response of [null, carousel(2)]) {
    const resolver = loadContent(async () => ({ items: [response] }), async () => response);
    await assert.rejects(resolver.postItems(article()), /Could not load all carousel media/);
  }
});

test("single-photo posts retain the DOM fallback", async () => {
  const resolver = loadContent(async () => { throw new Error("Unavailable"); }, async () => null);
  const items = await resolver.postItems(article({ slides: 1 }));
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://scontent.cdninstagram.com/first.jpg");
});

test("profile export keeps the current folder name across historical usernames", async () => {
  let page = 0;
  const resolver = loadContent(null, async (_procedure, { username }) => {
    assert.equal(username, "current_name");
    const owner = page++ === 0 ? "current_name" : "old_name";
    return { edges: [{ node: {
      pk: String(page), user: { username: owner },
      display_url: `https://scontent.cdninstagram.com/${page}.jpg`,
    } }], page_info: { has_next_page: page === 1, end_cursor: "next" } };
  });
  const progress = { update() {} };
  const { account, items } = await resolver.collectProfileMedia("current_name", progress);
  assert.equal(account.username, "current_name");
  assert.equal(items[1].username, "old_name");
  const filenames = [];
  const root = { async getDirectoryHandle(name) {
    assert.equal(name, "current_name");
    return { async getFileHandle(filename) {
      filenames.push(filename);
      return { async getFile() { return { size: 1 }; } };
    } };
  } };
  await resolver.writeProfileMedia(root, account, items, progress);
  assert.deepEqual(filenames, ["current_name_0_1.jpg", "old_name_0_2.jpg"]);
});
