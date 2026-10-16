"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const FIELD = "xdt_api__v1__feed__user_timeline_graphql_connection";

function loadTimeline(fetch, modules = {}) {
  const context = vm.createContext({
    URLSearchParams, fetch,
    window: { require: (name) => modules[name] },
    document: { cookie: "" },
    sessionStorage: { getItem: () => null, setItem() {} },
  });
  const source = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");
  // Exercise the real request handler without installing DOM observers.
  vm.runInContext(source.slice(0, source.indexOf('  window.addEventListener("message"')) + `
    globalThis.profileTimeline = profileTimeline;
  })();`, context);
  return context.profileTimeline;
}

const fieldError = {
  message: "A server error field_exception occured. Check server logs for details.",
  path: [FIELD, "edges", 0, "node", "location", "profile_pic_url"],
};

test("profile requests supply the required Threads-style comments variable on initial and later pages", async () => {
  const requiredVariable = "__relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider";
  const result = { data: { [FIELD]: { edges: [], page_info: { has_next_page: false } } } };
  const requests = [];
  const timeline = loadTimeline(async (_url, { body }) => {
    const variables = JSON.parse(body.get("variables"));
    requests.push({ name: body.get("fb_api_req_friendly_name"), id: body.get("doc_id"), variables });
    return { ok: true, json: async () => typeof variables[requiredVariable] === "boolean"
      ? result
      : { errors: [{ message: "A server error missing_required_variable_value occured. Check server logs for details." }] } };
  }, { PolarisProfilePostsQuery_instagramRelayOperation: "28834890909485062" });

  assert.equal(await timeline({ username: "example" }), result);
  assert.equal(await timeline({ username: "example", after: "next-page" }), result);
  assert.equal(requests[0].name, "PolarisProfilePostsQuery");
  assert.equal(requests[0].id, "28834890909485062");
  assert.equal(requests[1].name, "PolarisProfilePostsTabContentQuery_connection");
  assert.equal(requests[1].variables.after, "next-page");
  for (const { variables } of requests) {
    assert.equal(variables[requiredVariable], false);
  }
});

test("profile requests preserve media and pagination despite unrelated GraphQL field errors", async () => {
  const pages = ["next-page", null].map((cursor, index) => ({
    data: { [FIELD]: {
      edges: [{ node: { pk: String(index + 1), display_url: "https://scontent.cdninstagram.com/photo.jpg" } }],
      page_info: { has_next_page: Boolean(cursor), end_cursor: cursor },
    } },
    errors: [fieldError],
  }));
  let request = 0;
  const timeline = loadTimeline(async (_url, { body }) => {
    const variables = JSON.parse(body.get("variables"));
    assert.equal(variables.after, request === 0 ? undefined : "next-page");
    return { ok: true, json: async () => pages[request++] };
  });
  const first = await timeline({ username: "example" });
  assert.equal(first, pages[0]);
  const second = await timeline({ username: "example", after: first.data[FIELD].page_info.end_cursor });
  assert.equal(second, pages[1]);
});

test("empty profile timelines are valid even with field errors", async () => {
  const result = { data: { [FIELD]: { edges: [], page_info: { has_next_page: false } } }, errors: [fieldError] };
  const timeline = loadTimeline(async () => ({ ok: true, json: async () => result }));
  assert.equal(await timeline({ username: "example" }), result);
});

test("missing timelines still report GraphQL errors or the missing-data message", async () => {
  for (const result of [{ errors: [fieldError] }, { data: { [FIELD]: null }, errors: [fieldError] }, { data: {} }]) {
    const timeline = loadTimeline(async () => ({ ok: true, json: async () => result }));
    await assert.rejects(timeline({ username: "example" }), {
      message: result.errors ? fieldError.message : "Instagram returned no profile timeline data",
    });
  }
});

test("HTTP failures still abort profile requests", async () => {
  for (const status of [429, 500]) {
    const timeline = loadTimeline(async () => ({ ok: false, status }));
    await assert.rejects(timeline({ username: "example" }), {
      message: status === 429
        ? "Instagram is temporarily limiting downloads. Try again later."
        : "Instagram request failed (500)",
    });
  }
});
