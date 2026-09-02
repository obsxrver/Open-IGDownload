(function initializePageBridge() {
  "use strict";

  if (window.__openIGDownloadBridgeInstalled) return;
  window.__openIGDownloadBridgeInstalled = true;

  const REQUEST_CHANNEL = "open-igdownload:request";
  const MEDIA_ID_ATTRIBUTE = "data-open-igdownload-media-id";
  const NAVIGATION_EVENT = "open-igdownload:navigation";
  const DEFAULT_APP_ID = "936619743392459";
  const PROFILE_TIMELINE_FIELD =
    "xdt_api__v1__feed__user_timeline_graphql_connection";
  const PROFILE_QUERY = Object.freeze({
    initial: Object.freeze({
      fallbackId: "28534843459473863",
      name: "PolarisProfilePostsQuery",
    }),
    next: Object.freeze({
      fallbackId: "27613079688387576",
      name: "PolarisProfilePostsTabContentQuery_connection",
    }),
  });

  function numericMediaId(value) {
    const match = String(value || "").match(/^(\d+)(?:_\d+)?$/);
    return match ? match[1] : null;
  }

  function valueFromProps(props) {
    if (!props || typeof props !== "object") return null;
    const direct = [
      props.id,
      props.pk,
      props.postId,
      props.mediaId,
      props.videoFBID,
      props.post?.id,
      props.post?.pk,
      props.media?.id,
      props.media?.pk,
      props.item?.id,
      props.item?.pk,
    ];
    for (const candidate of direct) {
      const id = numericMediaId(candidate);
      if (id) return id;
    }
    return null;
  }

  function findReactMediaId(element) {
    if (!element) return null;
    const roots = [];
    for (const key of Object.keys(element)) {
      if (
        key.startsWith("__reactFiber$") ||
        key.startsWith("__reactInternalInstance$")
      ) {
        roots.push(element[key]);
      } else if (key.startsWith("__reactProps$")) {
        const id = valueFromProps(element[key]);
        if (id) return id;
      }
    }

    const queue = roots;
    const visited = new Set();
    while (queue.length && visited.size < 160) {
      const fiber = queue.shift();
      if (!fiber || typeof fiber !== "object" || visited.has(fiber)) continue;
      visited.add(fiber);
      const id =
        valueFromProps(fiber.memoizedProps) ||
        valueFromProps(fiber.pendingProps) ||
        valueFromProps(fiber.memoizedState) ||
        numericMediaId(fiber.key) ||
        numericMediaId(fiber.stateNode?.id);
      if (id) return id;
      for (const neighbor of [fiber.return, fiber.child, fiber.sibling]) {
        if (neighbor && !visited.has(neighbor)) queue.push(neighbor);
      }
    }
    return null;
  }

  function annotateElement(element) {
    if (
      !(element instanceof Element) ||
      element.hasAttribute(MEDIA_ID_ATTRIBUTE)
    ) {
      return;
    }
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const id = findReactMediaId(current);
      if (id) {
        element.setAttribute(MEDIA_ID_ATTRIBUTE, id);
        return;
      }
      current = current.parentElement;
    }
  }

  function annotateSubtree(root) {
    if (!(root instanceof Element)) return;
    if (
      root.matches("article, a[href*='/p/'], a[href*='/reel/'], img, video")
    ) {
      annotateElement(root);
    }
    root
      .querySelectorAll(
        "article, a[href*='/p/'], a[href*='/reel/'], img, video",
      )
      .forEach(annotateElement);
  }

  function observeDocument() {
    if (!document.documentElement) {
      setTimeout(observeDocument, 25);
      return;
    }
    annotateSubtree(document.documentElement);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) annotateSubtree(node);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function requiredModule(name) {
    if (typeof window.require !== "function") return null;
    try {
      return window.require(name);
    } catch (_error) {
      return null;
    }
  }

  function collectMetadata() {
    const config = requiredModule("PolarisConfig");
    const claim = requiredModule("PolarisWWWClaim");
    const appId = config?.getIGAppID?.() || DEFAULT_APP_ID;
    const wwwClaim =
      claim?.getWWWClaim?.() || sessionStorage.getItem("www-claim-v2") || "0";
    sessionStorage.setItem("open-igdownload:app-id", String(appId));
    sessionStorage.setItem("open-igdownload:www-claim", String(wwwClaim));
    sessionStorage.setItem(
      "open-igdownload:has-require",
      typeof window.require === "function" ? "1" : "0",
    );
    return { appId: String(appId), wwwClaim: String(wwwClaim) };
  }

  function moduleString(name, property) {
    const module = requiredModule(name);
    const value = property ? module?.[property] : module;
    const candidate = value?.default ?? value;
    return candidate == null ? null : String(candidate);
  }

  function cookieValue(name) {
    const prefix = `${encodeURIComponent(name)}=`;
    for (const part of document.cookie.split(";")) {
      const cookie = part.trim();
      if (cookie.startsWith(prefix)) {
        return decodeURIComponent(cookie.slice(prefix.length));
      }
    }
    return null;
  }

  function jazoest(token) {
    if (!token) return null;
    let checksum = 0;
    for (const character of token) checksum += character.charCodeAt(0);
    return `2${checksum}`;
  }

  function profileTimelineVariables(username, after) {
    const variables = {
      data: {
        count: 32,
        include_reel_media_seen_timestamp: true,
        include_relationship_info: true,
        latest_besties_reel_media: true,
        latest_reel_media: true,
      },
      username,
      __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider:
        true,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
      __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider:
        false,
    };
    if (after) {
      Object.assign(variables, {
        after,
        before: null,
        first: 32,
        include_multi_captions: true,
        last: null,
      });
    }
    return variables;
  }

  function graphqlToken(name) {
    const module = requiredModule(name);
    return module?.token || module?.default?.token || null;
  }

  async function profileTimeline({ username, after }) {
    if (!/^[a-z0-9._]{1,30}$/i.test(String(username || ""))) {
      throw new Error("Instagram profile name is invalid");
    }
    const operation = after ? PROFILE_QUERY.next : PROFILE_QUERY.initial;
    // Instagram registers the current persisted-query ID in the page bundle.
    // The captured IDs only keep the request usable if that module is late.
    const pageOperationId = moduleString(
      `${operation.name}_instagramRelayOperation`,
    );
    const operationId = /^\d+$/.test(pageOperationId || "")
      ? pageOperationId
      : operation.fallbackId;
    const { appId } = collectMetadata();
    const currentUserId =
      moduleString("CurrentUserInitialData", "USER_ID") || "0";
    const dtsg = graphqlToken("DTSGInitialData");
    const lsd = graphqlToken("LSD");
    const csrfToken = cookieValue("csrftoken");
    const body = new URLSearchParams({
      av: currentUserId,
      __a: "1",
      __comet_req: "7",
      __d: "www",
      __user: currentUserId,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: operation.name,
      server_timestamps: "true",
      variables: JSON.stringify(profileTimelineVariables(username, after)),
      doc_id: operationId,
    });
    if (dtsg) {
      body.set("fb_dtsg", dtsg);
      body.set("jazoest", jazoest(dtsg));
    }
    if (lsd) body.set("lsd", lsd);

    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "x-fb-friendly-name": operation.name,
      "x-ig-app-id": appId,
      "x-root-field-name": PROFILE_TIMELINE_FIELD,
    };
    if (csrfToken) headers["x-csrftoken"] = csrfToken;
    if (lsd) headers["x-fb-lsd"] = lsd;

    const response = await fetch("/graphql/query", {
      body,
      credentials: "include",
      headers,
      method: "POST",
    });
    if (response.status === 429) {
      throw new Error(
        "Instagram is temporarily limiting downloads. Try again later.",
      );
    }
    if (!response.ok) {
      throw new Error(`Instagram request failed (${response.status})`);
    }
    const result = await response.json();
    const error = result?.errors?.[0]?.message;
    if (error) throw new Error(error);
    if (!result?.data?.[PROFILE_TIMELINE_FIELD]) {
      throw new Error("Instagram returned no profile timeline data");
    }
    return result;
  }

  async function loadPostFromShortcode(shortcode) {
    const relay = requiredModule("CometRelay");
    const environment = requiredModule("PolarisRelayEnvironment");
    const query = requiredModule("PolarisPostActionLoadPostQuery");
    if (!relay || !environment || !query?.POST_QUERY) {
      throw new Error("Instagram's post loader is unavailable");
    }
    const response = await relay
      .fetchQuery(environment, query.POST_QUERY, {
        child_comment_count: 3,
        fetch_comment_count: 0,
        has_threaded_comments: false,
        parent_comment_count: 0,
        shortcode,
      })
      .toPromise();
    const media = response?.xdt_shortcode_media;
    return (
      media?.__fragments?.PolarisPostActionLoadPostQueryInlineFragment ||
      media?.__fragments
        ?.PolarisPostActionLoadPostQueryInlineFragmentWithoutRelatedProfiles ||
      media ||
      null
    );
  }

  async function instagramApiGet(path, query) {
    const api = requiredModule("PolarisInstapi");
    if (api?.apiGet) {
      const response = await api.apiGet(path, { query });
      return response?.data ?? response;
    }
    const { appId, wwwClaim } = collectMetadata();
    const url = new URL(path, location.origin);
    for (const [key, value] of Object.entries(query || {})) {
      if (value != null && value !== "") url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        "x-ig-app-id": appId,
        "x-ig-www-claim": wwwClaim,
        "x-requested-with": "XMLHttpRequest",
      },
    });
    if (!response.ok)
      throw new Error(`Instagram request failed (${response.status})`);
    return response.json();
  }

  async function storyTray() {
    const data = await instagramApiGet("/api/v1/feed/reels_tray/", {
      is_following_feed: false,
    });
    return data?.tray || [];
  }

  async function storyMedia({ reelId, mediaId }) {
    return instagramApiGet("/api/v1/feed/reels_media/", {
      media_id: mediaId || "",
      reel_ids: reelId,
    });
  }

  async function handleProcedure(data) {
    switch (data.procedure) {
      case "metadata":
        return collectMetadata();
      case "load-post":
        return loadPostFromShortcode(data.shortcode);
      case "profile-timeline":
        return profileTimeline(data);
      case "story-tray":
        return storyTray();
      case "story-media":
        return storyMedia(data);
      default:
        throw new Error("Unknown Open IGDownload procedure");
    }
  }

  function cloneableResult(value) {
    if (value == null || typeof value !== "object") return value;
    return JSON.parse(JSON.stringify(value));
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.data?.channel !== REQUEST_CHANNEL ||
      !event.ports?.[0]
    ) {
      return;
    }
    const port = event.ports[0];
    Promise.resolve(handleProcedure(event.data))
      .then((value) =>
        port.postMessage({ ok: true, value: cloneableResult(value) }),
      )
      .catch((error) =>
        port.postMessage({ ok: false, error: error?.message || String(error) }),
      );
  });

  function patchHistoryMethod(name) {
    const original = history[name];
    if (typeof original !== "function" || original.__openIGDownloadPatched)
      return;
    function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
      return result;
    }
    patchedHistoryMethod.__openIGDownloadPatched = true;
    history[name] = patchedHistoryMethod;
  }

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener("popstate", () =>
    window.dispatchEvent(new Event(NAVIGATION_EVENT)),
  );

  collectMetadata();
  setInterval(collectMetadata, 1500);
  observeDocument();
})();
