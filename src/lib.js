(function initializeOpenIGDownloadCore(global) {
  "use strict";

  const SHORTCODE_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const SETTINGS_DB = "open-igdownload";
  const SETTINGS_STORE = "settings";
  const RESERVED_PROFILE_SEGMENTS = new Set([
    "accounts",
    "about",
    "api",
    "challenge",
    "developer",
    "direct",
    "emails",
    "explore",
    "legal",
    "p",
    "privacy",
    "reel",
    "reels",
    "stories",
    "terms",
    "tv",
  ]);

  function shortcodeToMediaId(shortcode) {
    if (typeof shortcode !== "string" || !shortcode) return null;
    let value = 0n;
    for (const character of shortcode) {
      const index = SHORTCODE_ALPHABET.indexOf(character);
      if (index < 0) return null;
      value = value * 64n + BigInt(index);
    }
    return value.toString();
  }

  function mediaIdToShortcode(mediaId) {
    if (!/^\d+$/.test(String(mediaId || ""))) return null;
    let value = BigInt(mediaId);
    if (value === 0n) return SHORTCODE_ALPHABET[0];
    let shortcode = "";
    while (value > 0n) {
      shortcode = SHORTCODE_ALPHABET[Number(value % 64n)] + shortcode;
      value /= 64n;
    }
    return shortcode;
  }

  function shortcodeFromUrl(value) {
    try {
      const url = new URL(value, "https://www.instagram.com");
      const match = url.pathname.match(/\/(?:p|reel|tv)\/([^/?#]+)/i);
      return match ? match[1] : null;
    } catch (_error) {
      return null;
    }
  }

  function profileUsername(value) {
    try {
      const url = new URL(value, "https://www.instagram.com");
      const segments = url.pathname.split("/").filter(Boolean);
      if (!segments.length) return null;
      const candidate = segments[0].toLowerCase();
      if (RESERVED_PROFILE_SEGMENTS.has(candidate)) return null;
      if (!/^[a-z0-9._]{1,30}$/i.test(segments[0])) return null;
      return segments[0];
    } catch (_error) {
      return null;
    }
  }

  function storyRoute(value) {
    try {
      const url = new URL(value, "https://www.instagram.com");
      const match = url.pathname.match(
        /^\/stories\/([a-z0-9._]+)(?:\/(\d+))?\/?$/i,
      );
      return match
        ? { username: match[1], initialMediaId: match[2] || null }
        : null;
    } catch (_error) {
      return null;
    }
  }

  function routeFor(value) {
    try {
      const url = new URL(value, "https://www.instagram.com");
      if (url.hash === "#__open_igdownload_options") return "options";
      if (storyRoute(url.href)) return "story";
      if (/^\/(?:[a-z0-9._]+\/)?(?:p|reel|tv)\/[^/]+\/?$/i.test(url.pathname)) {
        return "post";
      }
      if (/^\/reels(?:\/[^/]+)?\/?$/i.test(url.pathname)) return "reels-feed";
      if (/^\/explore(?:\/|$)/i.test(url.pathname)) return "explore";
      if (url.pathname === "/" || url.pathname === "") return "home";
      if (profileUsername(url.href)) return "profile";
      return "other";
    } catch (_error) {
      return "other";
    }
  }

  function sanitizeFilenamePart(value, fallback = "unknown") {
    const result = String(value == null ? "" : value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\.\.+/g, ".")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 120);
    return result || fallback;
  }

  function extensionFromUrl(value, mediaType) {
    try {
      const pathname = new URL(value).pathname;
      const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (
        match &&
        /^(?:avif|gif|heic|jpeg|jpg|mp4|png|webm|webp)$/i.test(match[1])
      ) {
        return match[1].toLowerCase().replace("jpeg", "jpg");
      }
    } catch (_error) {}
    return mediaType === "video" ? "mp4" : "jpg";
  }

  function filenameFor(item) {
    const username = sanitizeFilenamePart(item.username, "unknown");
    const timestamp = sanitizeFilenamePart(
      item.takenAt ?? item.taken_at ?? 0,
      "0",
    );
    const id = sanitizeFilenamePart(item.pk || item.id, "media");
    const extension = extensionFromUrl(item.url, item.mediaType);
    return `${username}_${timestamp}_${id}.${extension}`;
  }

  function bestCandidate(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    return candidates.reduce((best, candidate) => {
      if (!best) return candidate;
      return Number(candidate.width || candidate.config_width || 0) *
        Number(candidate.height || candidate.config_height || 0) >
        Number(best.width || best.config_width || 0) *
          Number(best.height || best.config_height || 0)
        ? candidate
        : best;
    }, null);
  }

  function mediaUrl(item) {
    const video = bestCandidate(item.video_versions);
    if (video && video.url) return video.url;
    const image = bestCandidate(item.image_versions2?.candidates);
    if (image && image.url) return image.url;
    const display = bestCandidate(item.display_resources);
    if (display && (display.src || display.url))
      return display.src || display.url;
    return item.video_url || item.display_url || item.url || null;
  }

  function normalizeApiMedia(media, fallbackUsername) {
    if (!media || typeof media !== "object") return [];
    const username =
      media.user?.username ||
      media.owner?.username ||
      fallbackUsername ||
      "unknown";
    const timestamp = media.taken_at ?? media.taken_at_timestamp ?? 0;
    const children =
      media.carousel_media || media.edge_sidecar_to_children?.edges;
    if (Array.isArray(children) && children.length) {
      return children.flatMap((entry) => {
        const child = entry.node || entry;
        return normalizeApiMedia(
          {
            ...child,
            taken_at: child.taken_at ?? timestamp,
            user: child.user || { username },
          },
          username,
        );
      });
    }
    const url = mediaUrl(media);
    if (!url) return [];
    const isVideo =
      media.media_type === 2 ||
      media.is_video === true ||
      Boolean(media.video_url);
    return [
      {
        id: String(media.id || media.pk || "media"),
        pk: String(media.pk || media.id || "media"),
        takenAt: timestamp,
        username,
        mediaType: isVideo ? "video" : "image",
        url,
      },
    ];
  }

  function profileTimelineConnection(response) {
    if (!response || typeof response !== "object") return null;
    return (
      response.data?.xdt_api__v1__feed__user_timeline_graphql_connection ||
      response.xdt_api__v1__feed__user_timeline_graphql_connection ||
      (Array.isArray(response.edges) && response.page_info ? response : null)
    );
  }

  function normalizeProfileTimelinePage(response, fallbackUsername) {
    const connection = profileTimelineConnection(response);
    if (!connection) return null;
    const nodes = Array.isArray(connection.edges)
      ? connection.edges
          .map((edge) => edge?.node || edge)
          .filter((node) => node && typeof node === "object")
      : [];
    const ownerNode = nodes.find((node) => node.user || node.owner);
    const user = ownerNode?.user || ownerNode?.owner || {
      username: fallbackUsername,
    };
    const rawCursor = connection.page_info?.end_cursor;
    const endCursor =
      typeof rawCursor === "string" && rawCursor && rawCursor !== "None"
        ? rawCursor
        : null;

    return {
      account: {
        profilePicUrl:
          user?.hd_profile_pic_url_info?.url ||
          user?.profile_pic_url_hd ||
          user?.profile_pic_url ||
          null,
        username: user?.username || fallbackUsername || "unknown",
      },
      items: nodes.flatMap((node) =>
        normalizeApiMedia(node, user?.username || fallbackUsername),
      ),
      postCount: nodes.length,
      pageInfo: {
        endCursor,
        hasNextPage: Boolean(
          connection.page_info?.has_next_page && endCursor,
        ),
      },
    };
  }

  function isAllowedMediaUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        (host === "instagram.com" ||
          host.endsWith(".instagram.com") ||
          host.endsWith(".cdninstagram.com") ||
          host.endsWith(".cdninstagram.net") ||
          host.endsWith(".fbcdn.net"))
      );
    } catch (_error) {
      return false;
    }
  }

  function openSettingsDatabase() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = global.indexedDB.open(SETTINGS_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SETTINGS_STORE)) {
          request.result.createObjectStore(SETTINGS_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(key) {
    const database = await openSettingsDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SETTINGS_STORE, "readonly");
      const request = transaction.objectStore(SETTINGS_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
    });
  }

  async function idbSet(key, value) {
    const database = await openSettingsDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SETTINGS_STORE, "readwrite");
      transaction.objectStore(SETTINGS_STORE).put(value, key);
      transaction.oncomplete = () => {
        database.close();
        resolve(value);
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => global.setTimeout(resolve, milliseconds));
  }

  global.OpenIGDownloadCore = Object.freeze({
    bestCandidate,
    extensionFromUrl,
    filenameFor,
    idbGet,
    idbSet,
    isAllowedMediaUrl,
    mediaIdToShortcode,
    normalizeApiMedia,
    normalizeProfileTimelinePage,
    profileTimelineConnection,
    profileUsername,
    routeFor,
    sanitizeFilenamePart,
    shortcodeFromUrl,
    shortcodeToMediaId,
    sleep,
    storyRoute,
  });
})(globalThis);
