"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// A small DOM fixture for exercising observer records and tile decoration.
class Element {
  constructor(tag = "div", className = "") {
    this.tag = tag;
    this.className = className;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.listeners = {};
    this.scans = 0;
    this.classList = { add: (name) => {
      if (!this.className.split(" ").includes(name)) this.className += ` ${name}`;
    } };
  }
  get isConnected() {
    return this.tag === "body" || Boolean(this.parentElement?.isConnected);
  }
  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parentElement) {
      const children = this.parentElement.children;
      children.splice(children.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }
  matches(selectors) {
    return selectors.split(",").some((selector) => {
      selector = selector.trim();
      if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
      if (selector.startsWith("#")) return this.attributes.id === selector.slice(1);
      const link = selector.match(/^a\[href\*='([^']+)'\]$/);
      if (link) return this.tag === "a" && this.attributes.href?.includes(link[1]);
      return this.tag === selector;
    });
  }
  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (current.matches(selector)) return current;
    }
    return null;
  }
  querySelectorAll(selector) {
    this.scans++;
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    if (selector.startsWith(":scope > ")) {
      return this.children.find((child) => child.matches(selector.slice(9))) || null;
    }
    return this.querySelectorAll(selector)[0] || null;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  hasAttribute(name) { return name in this.attributes; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

function makeRow(count = 5, media = true) {
  const row = new Element("div", "_ac7v");
  for (let i = 0; i < count; i++) {
    const tile = row.appendChild(new Element()).appendChild(new Element("a"));
    tile.setAttribute("href", `/sample/${i % 2 ? "reel" : "p"}/ABC${i}/`);
    if (media) tile.appendChild(new Element("img"));
  }
  return row;
}

function record(target, addedNodes = [], removedNodes = []) {
  return { target, addedNodes, removedNodes };
}

function loadContent(rowCount = 12) {
  const body = new Element("body");
  const main = body.appendChild(new Element("main"));
  const grid = main.appendChild(new Element());
  for (let i = 0; i < rowCount; i++) grid.appendChild(makeRow());
  const observers = [];
  const timers = [];
  const location = { href: "https://www.instagram.com/sample/" };
  const context = vm.createContext({
    Element, URL, location,
    document: {
      body,
      createElement: (tag) => new Element(tag),
      querySelector: (selector) => selector === "main" ? main : main.querySelector("._ac7v"),
      querySelectorAll: (selector) => main.querySelectorAll(selector.replaceAll("main ", "")),
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.disconnected = true; this.target = null; }
    },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/lib.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("  start().catch")) + `
    globalThis.ui = { state, observeProfileGrid, installObserver, addGridButtons };
  })();`, context);
  const ui = context.ui;
  ui.state.route = "profile";
  ui.installObserver();
  return { ...ui, body, main, grid, observers, timers, location };
}

test("profile observer decorates the initial rows and watches only direct row changes", () => {
  const ui = loadContent();
  assert.equal(ui.observeProfileGrid(), true);
  assert.equal(ui.grid.querySelectorAll(".oig-grid-button").length, 60);
  assert.equal(ui.state.profileGridObserver.target, ui.grid);
  assert.equal(ui.state.profileGridObserver.options.childList, true);
  assert.equal(ui.state.profileGridObserver.options.subtree, undefined);
  const scans = ui.grid.children.map((row) => row.scans);
  assert.equal(ui.observeProfileGrid(), true);
  assert.deepEqual(ui.grid.children.map((row) => row.scans), scans);
  assert.equal(ui.observers.length, 2);
});

test("recycling rows processes only the newly mounted row without scheduling full refreshes", () => {
  const ui = loadContent();
  ui.observeProfileGrid();
  const untouched = ui.grid.children.slice(1);
  const scans = untouched.map((row) => row.scans);
  for (let i = 0; i < 200; i++) {
    const removed = ui.grid.children[0];
    removed.remove();
    const added = ui.grid.appendChild(makeRow());
    const change = record(ui.grid, [added], [removed]);
    ui.state.observer.callback([change]);
    ui.state.profileGridObserver.callback([change, change]);
    assert.equal(added.querySelectorAll(".oig-grid-button").length, 5);
    assert.equal(added.scans, 2, "one decoration scan plus the assertion scan");
    // Keep the same 11 rows mounted throughout the scroll simulation.
    added.remove();
    ui.grid.children.unshift(added);
    added.parentElement = ui.grid;
  }
  assert.deepEqual(untouched.map((row) => row.scans), scans);
  assert.equal(ui.grid.children.length, 12);
  assert.equal(ui.grid.querySelectorAll(".oig-grid-button").length, 60);
  assert.equal(ui.timers.length, 0);
  assert.equal(ui.observers.length, 2);
});

test("row removal and nodes removed before observer delivery do no decoration work", () => {
  const ui = loadContent(1);
  ui.observeProfileGrid();
  const row = ui.grid.children[0];
  row.remove();
  const scans = row.scans;
  const change = record(ui.grid, [row], [row]);
  ui.state.profileGridObserver.callback([change]);
  ui.state.observer.callback([change]);
  assert.equal(row.scans, scans);
  assert.equal(ui.timers.length, 0);
});

test("delayed tile media decorates its row without rescanning other rows", () => {
  const ui = loadContent(1);
  ui.observeProfileGrid();
  const first = ui.grid.children[0];
  const scans = first.scans;
  const row = ui.grid.appendChild(makeRow(1, false));
  ui.state.profileGridObserver.callback([record(ui.grid, [row])]);
  assert.equal(row.querySelectorAll(".oig-grid-button").length, 0);
  const tile = row.querySelector("a");
  const image = tile.appendChild(new Element("img"));
  ui.state.observer.callback([record(tile, [image])]);
  assert.equal(row.querySelectorAll(".oig-grid-button").length, 1);
  assert.equal(first.scans, scans);
  assert.equal(ui.timers.length, 0);
});

test("extension-owned mutations do not schedule another full-page scan", () => {
  const ui = loadContent();
  ui.observeProfileGrid();
  const tile = ui.grid.querySelector("a");
  const button = tile.querySelector(".oig-grid-button");
  const path = button.appendChild(new Element("path"));
  const settings = ui.body.appendChild(new Element("button", "oig-icon-button"));
  ui.state.observer.callback([
    record(tile, [button]), record(button, [path]), record(ui.body, [settings]),
  ]);
  assert.equal(ui.timers.length, 0);
  ui.state.observer.callback([record(ui.main, [new Element("article")])]);
  assert.equal(ui.timers.length, 1, "post dialogs and other page changes still refresh controls");
});

test("replacing the grid disconnects the old observer and binds to the new container", () => {
  const ui = loadContent();
  ui.observeProfileGrid();
  const oldObserver = ui.state.profileGridObserver;
  ui.grid.remove();
  const nextGrid = ui.main.appendChild(new Element());
  nextGrid.appendChild(makeRow());
  ui.state.observer.callback([record(ui.main, [nextGrid], [ui.grid])]);
  assert.equal(ui.timers.length, 1);
  ui.observeProfileGrid();
  assert.equal(oldObserver.disconnected, true);
  assert.equal(ui.state.profileGrid, nextGrid);
  assert.equal(nextGrid.querySelectorAll(".oig-grid-button").length, 5);
});

test("leaving a profile releases the grid and preserves the grid fallback on other routes", () => {
  const ui = loadContent();
  ui.observeProfileGrid();
  const oldObserver = ui.state.profileGridObserver;
  ui.state.route = "explore";
  ui.location.href = "https://www.instagram.com/explore/";
  assert.equal(ui.observeProfileGrid(), false);
  assert.equal(oldObserver.disconnected, true);
  assert.equal(ui.state.profileGrid, null);
  assert.equal(ui.state.profileGridObserver, null);
  const extra = ui.main.appendChild(makeRow());
  ui.addGridButtons();
  assert.equal(extra.querySelectorAll(".oig-grid-button").length, 5);
});

test("profiles without row markup keep the ordinary grid fallback", () => {
  const ui = loadContent(0);
  const wrapper = ui.grid.appendChild(makeRow(2));
  wrapper.className = "unknown-grid-layout";
  assert.equal(ui.observeProfileGrid(), false);
  ui.addGridButtons();
  assert.equal(wrapper.querySelectorAll(".oig-grid-button").length, 2);
});

test("bridge skips virtualized rows and permalink media, while retaining unlinked media lookup", () => {
  const context = vm.createContext({ window: {}, Element });
  const source = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('  window.addEventListener("message"')) + `
    globalThis.bridge = { annotateSubtree, annotateElement };
  })();`, context);
  const row = makeRow();
  const image = row.querySelector("img");
  let reads = 0;
  Object.defineProperty(image, "__reactFiber$fixture", {
    enumerable: true, get() { reads++; return { memoizedProps: { mediaId: "123456789" } }; },
  });
  const scans = row.scans;
  context.bridge.annotateSubtree(row);
  context.bridge.annotateElement(image);
  assert.equal(reads, 0);
  assert.equal(row.scans, scans, "new rows should not even be scanned for React metadata");
  image.remove();
  context.bridge.annotateElement(image);
  assert.equal(reads, 1);
  assert.equal(image.attributes["data-open-igdownload-media-id"], "123456789");
});
