"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const WEEK = 7 * 24 * 60 * 60 * 1000;
const KEY = "reviewPromptLastShownAt";

function background(storage = {}, clock = { now: WEEK }, failures = {}) {
  let listener;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8"), {
    Date: { now: () => clock.now },
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener(callback) { listener = callback; } } },
      storage: { local: {
        async get(key) {
          if (failures.get) throw new Error("Storage unavailable");
          return { [key]: storage[key] };
        },
        async set(values) {
          if (failures.set) throw new Error("Storage unavailable");
          Object.assign(storage, values);
        },
      } },
    },
  });
  return () => new Promise((resolve) => {
    assert.equal(listener({ type: "open-igdownload:claim-review-prompt" }, {}, resolve), true);
  });
}

test("review prompt is limited to once per seven days across tabs and worker restarts", async () => {
  const storage = {};
  const clock = { now: WEEK };
  const claim = background(storage, clock);
  const concurrent = await Promise.all([claim(), claim(), claim()]);
  assert.deepEqual(concurrent.map((result) => result.show), [true, false, false]);
  assert.equal(storage[KEY], WEEK);

  const restarted = background(storage, clock);
  clock.now += WEEK - 1;
  assert.equal((await restarted()).show, false);
  clock.now += 1;
  assert.equal((await restarted()).show, true);
  assert.equal(storage[KEY], WEEK * 2);
});

test("storage failures suppress the prompt and do not break later requests", async () => {
  for (const operation of ["get", "set"]) {
    const failures = { [operation]: true };
    const claim = background({}, { now: WEEK }, failures);
    assert.equal((await claim()).show, false);
    failures[operation] = false;
    assert.equal((await claim()).show, true);
  }
});

test("moving the clock backwards does not show another review request", async () => {
  assert.equal((await background({ [KEY]: WEEK * 2 }, { now: WEEK })()).show, false);
});

function content({ visible = true, route = "home", response = { ok: true, show: true } } = {}) {
  const elements = [];
  const messages = [];
  function element() {
    const node = {
      children: [], attributes: {}, events: {}, isConnected: true,
      classList: { add() {}, remove() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(event, callback) { this.events[event] = callback; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      querySelector(selector) {
        return this.children.find((child) => `.${child.className}` === selector);
      },
      remove() { this.isConnected = false; },
      showModal() { this.open = true; },
      close() { this.open = false; this.events.close(); },
    };
    elements.push(node);
    return node;
  }
  const document = {
    visibilityState: visible ? "visible" : "hidden",
    body: element(),
    createElement: element,
    getElementById: (id) => elements.find((node) => node.id === id),
    querySelector: () => elements.find((node) =>
      node.className?.includes("oig-review-prompt") && node.isConnected),
  };
  const context = vm.createContext({
    OpenIGDownloadCore: { routeFor: () => route }, document,
    location: { href: "https://www.instagram.com/" },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
    chrome: { runtime: { getURL: (resource) => `chrome-extension://fixture/${resource}`, sendMessage(message, callback) {
      messages.push(message);
      if (response instanceof Error) throw response;
      callback(response);
    } } },
  });
  const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("  start().catch")) + `
    globalThis.showReview = maybeShowReviewPrompt;
  })();`, context);
  return { show: context.showReview, document, messages };
}

test("review request has the store review link and can be dismissed", async () => {
  for (const action of ["close", "review"]) {
    const ui = content();
    await Promise.all([ui.show(), ui.show()]);
    const prompt = ui.document.querySelector(".oig-review-prompt");
    assert.ok(prompt);
    assert.equal(prompt.open, true);
    assert.equal(prompt.attributes["aria-labelledby"], "oig-review-title");
    assert.equal(prompt.attributes["aria-describedby"], "oig-review-description");
    assert.equal(ui.messages.length, 1);
    assert.equal(prompt.children[0].children[2].textContent, "Support us with a 5-star review.");
    const actions = prompt.querySelector(".oig-review-actions");
    const link = actions.children[1];
    const dismiss = actions.children[0];
    assert.equal(dismiss.textContent, "Not now");
    assert.equal(dismiss.autofocus, true);
    assert.equal(link.textContent, "Leave a review");
    assert.equal(link.href, "https://chromewebstore.google.com/detail/open-igdownload-downloade/hchdkeahjmpahjkncgboenfpgllhnfem/reviews");
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    await ui.show();
    assert.equal(ui.messages.length, 1, "do not request another prompt while one is visible");
    (action === "close" ? dismiss : link).events.click();
    assert.equal(prompt.isConnected, false);
  }
});

test("hidden tabs and settings do not consume the weekly reminder", async () => {
  for (const options of [{ visible: false }, { route: "options" }]) {
    const ui = content(options);
    await ui.show();
    assert.equal(ui.messages.length, 0);
  }
});

test("ineligible or failed reminder requests do not show a prompt", async () => {
  for (const response of [{ ok: true, show: false }, { ok: false }, undefined, new Error("Disconnected")]) {
    const ui = content({ response: response ?? null });
    await ui.show();
    assert.equal(ui.document.querySelector(".oig-review-prompt"), undefined);
  }
});
