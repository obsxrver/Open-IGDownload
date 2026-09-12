"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function settings({ picker, save = async () => {}, current = null } = {}) {
  const context = vm.createContext({
    OpenIGDownloadCore: { idbSet: save },
    window: { showDirectoryPicker: picker },
  });
  const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("  start().catch")) + `
    globalThis.settings = { state, acquireDirectory, chooseOptionsDirectory };
  })();`, context);
  context.settings.state.directoryHandle = current;
  const classes = new Set();
  return {
    ...context.settings,
    button: { disabled: false },
    name: { textContent: current?.name || "Folder not set" },
    status: { textContent: "", classList: {
      add: (value) => classes.add(value), remove: (value) => classes.delete(value),
    } },
    classes,
  };
}

test("Choose folder opens the picker immediately and replaces the saved folder", async () => {
  const next = { kind: "directory", name: "New folder" };
  let opened = false;
  let stored;
  const ui = settings({
    current: { kind: "directory", name: "Old folder", requestPermission() {
      throw new Error("Choosing a new folder must not request the old permission");
    } },
    picker: async (options) => { opened = true; assert.equal(options.mode, "readwrite"); return next; },
    save: async (key, value) => { assert.equal(key, "download-directory-handle"); stored = value; },
  });
  const pending = ui.chooseOptionsDirectory(ui.button, ui.name, ui.status);
  assert.equal(opened, true, "picker must run before yielding the user click");
  await pending;
  assert.equal(stored, next);
  assert.equal(ui.state.directoryHandle, next);
  assert.match(ui.name.textContent, /New folder/);
  assert.equal(ui.status.textContent, "Download folder saved.");
  assert.equal(ui.button.disabled, false);
});

test("cancelling the picker keeps the saved folder and re-enables the button", async () => {
  const current = { kind: "directory", name: "Old folder" };
  const ui = settings({ current, picker: async () => { throw { name: "AbortError" }; } });
  await ui.chooseOptionsDirectory(ui.button, ui.name, ui.status);
  assert.equal(ui.state.directoryHandle, current);
  assert.equal(ui.name.textContent, "Old folder");
  assert.equal(ui.status.textContent, "");
  assert.equal(ui.button.disabled, false);
});

test("picker and storage failures are shown in settings without losing the saved folder", async () => {
  for (const failure of ["picker", "storage"]) {
    const current = { kind: "directory", name: "Old folder" };
    const ui = settings({ current,
      picker: async () => {
        if (failure === "picker") throw new Error("Picker unavailable");
        return { kind: "directory", name: "New folder" };
      },
      save: async () => { throw new Error("Storage unavailable"); },
    });
    await ui.chooseOptionsDirectory(ui.button, ui.name, ui.status);
    assert.match(ui.status.textContent, /unavailable/);
    assert.equal(ui.classes.has("oig-setting-error"), true);
    assert.equal(ui.state.directoryHandle, current);
    assert.equal(ui.button.disabled, false);
  }
});

test("unsupported browsers show an inline explanation", async () => {
  const ui = settings();
  await ui.chooseOptionsDirectory(ui.button, ui.name, ui.status);
  assert.match(ui.status.textContent, /does not support choosing a download folder/);
  assert.equal(ui.button.disabled, false);
});

test("profile downloads still reuse a permitted saved folder", async () => {
  const current = { kind: "directory", name: "Saved", requestPermission: async () => "granted" };
  const ui = settings({ current, picker: () => { throw new Error("Unexpected picker"); } });
  assert.equal(await ui.acquireDirectory(), current);
});
