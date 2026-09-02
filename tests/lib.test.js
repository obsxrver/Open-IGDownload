"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

require(path.join(__dirname, "..", "src", "lib.js"));
const Core = globalThis.OpenIGDownloadCore;

test("Instagram shortcodes and numeric media IDs round-trip", () => {
  for (const id of ["0", "1", "64", "1234567890123456789"]) {
    const shortcode = Core.mediaIdToShortcode(id);
    assert.equal(Core.shortcodeToMediaId(shortcode), id);
  }
  assert.equal(Core.shortcodeToMediaId("bad!"), null);
});

test("routes distinguish posts, Stories, Reels feeds, profiles, and options", () => {
  assert.equal(Core.routeFor("https://www.instagram.com/p/ABC_123/"), "post");
  assert.equal(
    Core.routeFor("https://www.instagram.com/example/p/ABC_123/"),
    "post",
  );
  assert.equal(
    Core.routeFor("https://www.instagram.com/reel/ABC_123/"),
    "post",
  );
  assert.equal(Core.routeFor("https://www.instagram.com/reels/"), "reels-feed");
  assert.equal(
    Core.routeFor("https://www.instagram.com/stories/example/123/"),
    "story",
  );
  assert.equal(Core.routeFor("https://www.instagram.com/example/"), "profile");
  assert.equal(
    Core.routeFor("https://www.instagram.com/#__open_igdownload_options"),
    "options",
  );
  assert.equal(
    Core.profileUsername("https://www.instagram.com/explore/"),
    null,
  );
});

test("shortcodes are extracted from post-style URLs", () => {
  assert.equal(
    Core.shortcodeFromUrl(
      "https://www.instagram.com/example/p/ABC_123/?img_index=2",
    ),
    "ABC_123",
  );
  assert.equal(Core.shortcodeFromUrl("/reel/xyz-/"), "xyz-");
});

test("API carousel media is flattened and selects the largest candidates", () => {
  const items = Core.normalizeApiMedia({
    id: "parent",
    taken_at: 1700000000,
    user: { username: "sample" },
    carousel_media: [
      {
        id: "one",
        pk: "one",
        media_type: 1,
        image_versions2: {
          candidates: [
            {
              width: 100,
              height: 100,
              url: "https://scontent.cdninstagram.com/small.jpg",
            },
            {
              width: 1000,
              height: 1000,
              url: "https://scontent.cdninstagram.com/large.jpg",
            },
          ],
        },
      },
      {
        id: "two",
        pk: "two",
        media_type: 2,
        video_versions: [
          {
            width: 320,
            height: 180,
            url: "https://scontent.cdninstagram.com/small.mp4",
          },
          {
            width: 1920,
            height: 1080,
            url: "https://scontent.cdninstagram.com/large.mp4",
          },
        ],
      },
    ],
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://scontent.cdninstagram.com/large.jpg");
  assert.equal(items[0].username, "sample");
  assert.equal(items[1].url, "https://scontent.cdninstagram.com/large.mp4");
  assert.equal(items[1].mediaType, "video");
});

test("legacy Relay media is normalized", () => {
  const items = Core.normalizeApiMedia({
    id: "123",
    is_video: false,
    taken_at_timestamp: 1700000000,
    owner: { username: "legacy" },
    display_resources: [
      {
        config_width: 200,
        config_height: 200,
        src: "https://scontent.cdninstagram.com/a.jpg",
      },
      {
        config_width: 800,
        config_height: 800,
        src: "https://scontent.cdninstagram.com/b.jpg",
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://scontent.cdninstagram.com/b.jpg");
  assert.equal(items[0].username, "legacy");
});

test("profile GraphQL timeline pages expose account, media, and cursor data", () => {
  const page = Core.normalizeProfileTimelinePage(
    {
      data: {
        xdt_api__v1__feed__user_timeline_graphql_connection: {
          edges: [
            {
              node: {
                id: "101_owner",
                pk: "101",
                media_type: 2,
                taken_at: 1700000001,
                user: {
                  username: "sample",
                  profile_pic_url: "https://scontent.cdninstagram.com/avatar.jpg",
                  hd_profile_pic_url_info: {
                    url: "https://scontent.cdninstagram.com/avatar-hd.jpg",
                  },
                },
                video_versions: [
                  {
                    width: 1080,
                    height: 1920,
                    url: "https://scontent.cdninstagram.com/reel.mp4",
                  },
                ],
              },
            },
            {
              node: {
                id: "102_owner",
                pk: "102",
                media_type: 8,
                taken_at: 1700000000,
                user: { username: "sample" },
                carousel_media: [
                  {
                    id: "103_owner",
                    pk: "103",
                    media_type: 1,
                    image_versions2: {
                      candidates: [
                        {
                          width: 1080,
                          height: 1080,
                          url: "https://scontent.cdninstagram.com/photo.jpg",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
          page_info: {
            end_cursor: "102_owner",
            has_next_page: true,
          },
        },
      },
      status: "ok",
    },
    "fallback",
  );

  assert.equal(page.account.username, "sample");
  assert.equal(
    page.account.profilePicUrl,
    "https://scontent.cdninstagram.com/avatar-hd.jpg",
  );
  assert.equal(page.postCount, 2);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].mediaType, "video");
  assert.equal(page.items[1].mediaType, "image");
  assert.deepEqual(page.pageInfo, {
    endCursor: "102_owner",
    hasNextPage: true,
  });
});

test("profile GraphQL terminal cursors and unsupported responses are handled", () => {
  const page = Core.normalizeProfileTimelinePage(
    {
      xdt_api__v1__feed__user_timeline_graphql_connection: {
        edges: [],
        page_info: { end_cursor: "None", has_next_page: false },
      },
    },
    "empty_profile",
  );

  assert.equal(page.account.username, "empty_profile");
  assert.equal(page.postCount, 0);
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.pageInfo, {
    endCursor: null,
    hasNextPage: false,
  });
  assert.equal(Core.normalizeProfileTimelinePage({ data: {} }, "missing"), null);
});

test("filenames are safe and media URLs are constrained", () => {
  const filename = Core.filenameFor({
    id: "123_456",
    pk: "123_456",
    mediaType: "video",
    takenAt: 1700000000,
    url: "https://scontent.cdninstagram.com/media.mp4?token=abc",
    username: "bad/name:*?",
  });
  assert.equal(filename, "badname_1700000000_123_456.mp4");
  assert.equal(
    Core.isAllowedMediaUrl("https://scontent.cdninstagram.com/a.jpg"),
    true,
  );
  assert.equal(Core.isAllowedMediaUrl("https://example.com/a.jpg"), false);
});
