(function initializeContentScript() {
  "use strict";

  const Core = globalThis.OpenIGDownloadCore;
  if (!Core || globalThis.__openIGDownloadContentInstalled) return;
  globalThis.__openIGDownloadContentInstalled = true;

  const BRIDGE_CHANNEL = "open-igdownload:request";
  const NAVIGATION_EVENT = "open-igdownload:navigation";
  const MEDIA_ID_ATTRIBUTE = "data-open-igdownload-media-id";
  const DIRECTORY_KEY = "download-directory-handle";
  const DEFAULT_APP_ID = "936619743392459";
  const SLIDE_SELECTOR =
    "li.x972fbf.x10w94by.x1qhh985.x14e42zd.xln7xf2.xk390pu.x5yr21d, li:has(> div img), li:has(> div video)";

  const state = {
    directoryHandle: null,
    observer: null,
    refreshTimer: null,
    route: null,
  };

  const singleDownloadIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12"></path>
      <path d="m7 10 5 5 5-5"></path>
      <path d="M5 20h14"></path>
    </svg>`;
  const allDownloadIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 3v11"></path>
      <path d="m4 10 4 4 4-4"></path>
      <path d="M4 19h12"></path>
      <path d="M16 5v9"></path>
      <path d="m13 11 3 3 3-3"></path>
    </svg>`;

  function waitForBody() {
    if (document.body) return Promise.resolve(document.body);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.body) return;
        observer.disconnect();
        resolve(document.body);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  function bridge(procedure, payload = {}) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.close();
        reject(new Error("Instagram did not respond in time"));
      }, 20_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        channel.port1.close();
        if (event.data?.ok) resolve(event.data.value);
        else reject(new Error(event.data?.error || "Instagram request failed"));
      };
      window.postMessage(
        { channel: BRIDGE_CHANNEL, procedure, ...payload },
        location.origin,
        [channel.port2],
      );
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function createIconButton(label, { all = false, className = "" } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `oig-icon-button ${className}`.trim();
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = all ? allDownloadIcon : singleDownloadIcon;
    return button;
  }

  function createSettingsButton(className = "") {
    const button = createIconButton("Open IGDownload settings", {
      className: `oig-settings-button ${className}`,
    });
    button.title = "IGDownload";
    const icon = document.createElement("img");
    icon.src = chrome.runtime.getURL("icons/icon-48.png");
    icon.alt = "";
    icon.width = 24;
    icon.height = 24;
    const label = document.createElement("span");
    label.className = "oig-settings-label";
    label.textContent = "IGDownload";
    button.replaceChildren(icon, label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      location.assign("https://www.instagram.com/#__open_igdownload_options");
    });
    return button;
  }

  function addSettingsButtons() {
    document.querySelectorAll('h1 svg[aria-label="Instagram"]').forEach((logo) => {
      // Keep the portrait button outside the feed menu's clickable element.
      const owner = logo.closest("h1");
      if (owner.querySelector(":scope > .oig-settings-button")) return;
      owner.classList.add("oig-settings-owner");
      owner.appendChild(createSettingsButton());
    });

    document.querySelectorAll('svg[aria-label="Home"]').forEach((home) => {
      // Find the shared navigation list, then its top-level Profile row.
      // This avoids depending on Instagram's generated classes or username.
      let list = home.closest("a")?.parentElement;
      while (list && list !== document.body) {
        const profile = [...list.querySelectorAll("a[href]")].find((link) =>
          link.querySelector('img[alt$="profile picture"]') &&
          link.textContent.trim() === "Profile",
        );
        if (profile) {
          list.classList.add("oig-settings-nav-owner");
          // Instagram changes this label's inline display when its rail expands.
          const profileLabel = [...profile.querySelectorAll("div[style]")].find(
            (element) => element.style.display && element.textContent.trim() === "Profile",
          );
          profileLabel?.classList.add("oig-profile-nav-label");
          let row = profile;
          while (row.parentElement !== list) row = row.parentElement;
          if (!list.querySelector(":scope > .oig-settings-nav-row")) {
            const settingsRow = document.createElement("div");
            settingsRow.className = "oig-settings-nav-row";
            settingsRow.appendChild(createSettingsButton("oig-settings-nav-button"));
            row.after(settingsRow);
          }
          break;
        }
        list = list.parentElement;
      }
    });
  }

  function notificationsRoot() {
    let root = document.getElementById("oig-notifications");
    if (!root) {
      root = document.createElement("div");
      root.id = "oig-notifications";
      document.body.appendChild(root);
    }
    return root;
  }

  function removeNotice(element) {
    if (!element?.isConnected) return;
    element.classList.remove("oig-visible");
    setTimeout(() => element.remove(), 180);
  }

  function notice(text, type = "default", timeout = 5_000) {
    const element = document.createElement("div");
    element.className = `oig-notice oig-${type}`;
    const message = document.createElement("div");
    message.className = "oig-notice-message";
    message.textContent = text;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "oig-notice-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", () => removeNotice(element));
    element.append(message, close);
    notificationsRoot().appendChild(element);
    requestAnimationFrame(() => element.classList.add("oig-visible"));
    if (timeout) setTimeout(() => removeNotice(element), timeout);
    return element;
  }

  function progressNotice(text, { persistent = false } = {}) {
    const element = notice(text, "default", 0);
    const track = document.createElement("div");
    track.className = "oig-progress-track";
    const bar = document.createElement("div");
    bar.className = "oig-progress-bar";
    track.appendChild(bar);
    element.appendChild(track);
    return {
      update(completed, total, message) {
        const percent =
          total > 0 ? Math.min(100, (completed / total) * 100) : 0;
        bar.style.setProperty("--oig-progress", `${percent}%`);
        if (message)
          element.querySelector(".oig-notice-message").textContent = message;
      },
      finish(message) {
        bar.style.setProperty("--oig-progress", "100%");
        if (message)
          element.querySelector(".oig-notice-message").textContent = message;
        if (!persistent) setTimeout(() => removeNotice(element), 2_200);
      },
      fail(message) {
        element.classList.add("oig-error");
        element.querySelector(".oig-notice-message").textContent = message;
      },
    };
  }

  async function runButtonTask(button, task) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await task();
    } catch (error) {
      console.error("Open IGDownload", error);
      notice(error?.message || "Download failed", "error", 8_000);
    } finally {
      button.disabled = false;
    }
  }

  async function getApiHeaders() {
    let appId = sessionStorage.getItem("open-igdownload:app-id");
    let wwwClaim = sessionStorage.getItem("open-igdownload:www-claim");
    if (!appId || !wwwClaim) {
      try {
        const metadata = await bridge("metadata");
        appId ||= metadata?.appId;
        wwwClaim ||= metadata?.wwwClaim;
      } catch (_error) {}
    }
    return {
      "x-ig-app-id": appId || DEFAULT_APP_ID,
      "x-ig-www-claim": wwwClaim || "0",
      "x-requested-with": "XMLHttpRequest",
    };
  }

  async function instagramJson(path) {
    const response = await fetch(path, {
      credentials: "include",
      headers: await getApiHeaders(),
    });
    if (response.status === 429) {
      throw new Error(
        "Instagram is temporarily limiting downloads. Try again later.",
      );
    }
    if (!response.ok) {
      throw new Error(`Instagram request failed (${response.status})`);
    }
    return response.json();
  }

  function mediaIdentity(element) {
    const candidates = [
      element,
      element?.closest?.(`[${MEDIA_ID_ATTRIBUTE}]`),
      ...(element?.querySelectorAll?.(`[${MEDIA_ID_ATTRIBUTE}]`) || []),
    ];
    let id = null;
    for (const candidate of candidates) {
      const value = candidate?.getAttribute?.(MEDIA_ID_ATTRIBUTE);
      const match = String(value || "").match(/^([1-9]\d*)(?:_\d+)?$/);
      if (match) {
        id = match[1];
        break;
      }
    }

    const anchor =
      element?.closest?.("a[href*='/p/'],a[href*='/reel/'],a[href*='/tv/']") ||
      element?.querySelector?.(
        "a[href*='/p/'],a[href*='/reel/'],a[href*='/tv/']",
      );
    const shortcode =
      Core.shortcodeFromUrl(anchor?.href || "") ||
      (Core.routeFor(location.href) === "post"
        ? Core.shortcodeFromUrl(location.href)
        : null);
    // A permalink identifies the parent post; React annotations can be a
    // carousel child, an unrelated component ID, or a list index such as 0.
    return { id: Core.shortcodeToMediaId(shortcode) || id, shortcode };
  }

  function usernameFromElement(element) {
    const article = element?.closest?.("article") || element;
    const links = article?.querySelectorAll?.("header a[href], a[href]") || [];
    for (const link of links) {
      const username = Core.profileUsername(link.href);
      if (username) return username;
    }
    return Core.profileUsername(location.href) || "unknown";
  }

  function domMediaFallback(element) {
    const container = element?.closest?.("article") || element || document;
    const video = container.querySelector?.("video");
    const images = [...(container.querySelectorAll?.("img") || [])].filter(
      (image) => image.naturalWidth >= 300 || image.clientWidth >= 300,
    );
    const image = images.sort(
      (left, right) =>
        right.naturalWidth * right.naturalHeight -
        left.naturalWidth * left.naturalHeight,
    )[0];
    const url =
      video?.currentSrc || video?.src || image?.currentSrc || image?.src;
    if (!url || url.startsWith("blob:")) return [];
    return [
      {
        id: mediaIdentity(element).id || "media",
        pk: mediaIdentity(element).id || "media",
        takenAt: 0,
        username: usernameFromElement(element),
        mediaType: video ? "video" : "image",
        url,
      },
    ];
  }

  async function postItems(element, index = null) {
    let { id, shortcode } = mediaIdentity(element);
    if (!shortcode && id) shortcode = Core.mediaIdToShortcode(id);
    let lastError = null;
    const container = element?.closest?.("article") || element;
    let expectedCount = carouselItemCount(container);
    const completeItems = (media) => {
      expectedCount = Math.max(
        expectedCount,
        Number(media?.carousel_media_count) || 0,
        media?.carousel_media?.length || 0,
        media?.edge_sidecar_to_children?.edges?.length || 0,
        media?.media_type === 8 || media?.__typename === "GraphSidecar" ? 2 : 1,
      );
      const items = Core.normalizeApiMedia(media);
      return items.length >= expectedCount ? items : [];
    };

    if (id) {
      try {
        const response = await instagramJson(`/api/v1/media/${id}/info/`);
        const items = completeItems(response?.items?.[0]);
        if (items.length)
          return index == null ? items : items.slice(index, index + 1);
      } catch (error) {
        lastError = error;
      }
    }

    if (shortcode) {
      try {
        const media = await bridge("load-post", { shortcode });
        const items = completeItems(media);
        if (items.length)
          return index == null ? items : items.slice(index, index + 1);
      } catch (error) {
        lastError = error;
      }
    }

    if (expectedCount > 1) {
      throw new Error("Could not load all carousel media. Open the post and try again.");
    }
    const fallback = domMediaFallback(element);
    if (fallback.length) return fallback;
    throw lastError || new Error("Could not find media for this post");
  }

  async function backgroundDownload(item, filenamePrefix = "") {
    if (!Core.isAllowedMediaUrl(item.url)) {
      throw new Error("Instagram returned an unsupported media URL");
    }
    const filename = `${filenamePrefix}${Core.filenameFor(item)}`;
    const response = await sendRuntimeMessage({
      type: "open-igdownload:download",
      url: item.url,
      filename,
    });
    if (!response?.ok) throw new Error(response?.error || "Download failed");
  }

  async function downloadItems(items, label = "Downloading media") {
    const validItems = items.filter((item) => item?.url);
    if (!validItems.length) throw new Error("No downloadable media was found");
    const progress = progressNotice(`${label}…`);
    let completed = 0;
    try {
      for (const item of validItems) {
        await backgroundDownload(item);
        completed += 1;
        progress.update(
          completed,
          validItems.length,
          `${label}… ${completed.toLocaleString()}/${validItems.length.toLocaleString()}`,
        );
      }
      progress.finish(
        `${completed.toLocaleString()} ${completed === 1 ? "file" : "files"} downloaded.`,
      );
    } catch (error) {
      progress.fail(error?.message || "Download failed");
      throw error;
    }
  }

  async function downloadPost(element, index = null) {
    const finding = progressNotice("Finding post media…");
    try {
      const items = await postItems(element, index);
      finding.finish("Media found.");
      await downloadItems(
        items,
        items.length > 1 ? "Downloading post" : "Downloading",
      );
    } catch (error) {
      finding.fail(error?.message || "Could not find post");
      throw error;
    }
  }

  function moreOptionsControl(article) {
    const svg = article.querySelector("svg[aria-label='More options']");
    return (
      svg?.closest("button, div[role='button']") || svg?.parentElement || null
    );
  }

  function carouselSlides(article) {
    return [...article.querySelectorAll(SLIDE_SELECTOR)].filter((slide) => {
      const media = slide.querySelector("img,video");
      return media && (media.clientWidth >= 180 || media.naturalWidth >= 300);
    });
  }

  function carouselItemCount(container) {
    if (!container?.querySelectorAll) return 1;
    const dots = container.querySelectorAll(
      "._acnb, [role='tab'], button[aria-label^='Go to slide ']",
    );
    const slideNumbers = [...dots].map((dot) =>
      Number(dot.getAttribute("aria-label")?.match(/^Go to slide (\d+)$/)?.[1]) || 0,
    );
    return Math.max(1, dots.length, ...slideNumbers, carouselSlides(container).length);
  }

  function addPostButtons() {
    document.querySelectorAll("article").forEach((article) => {
      const control = moreOptionsControl(article);
      const headerControls = control?.parentElement;
      if (
        headerControls &&
        !headerControls.querySelector(":scope > .oig-post-button")
      ) {
        const hasCarousel = carouselItemCount(article) > 1;
        const button = createIconButton(
          hasCarousel
            ? "Download all media in this post"
            : "Download this post",
          { all: hasCarousel, className: "oig-post-button" },
        );
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          runButtonTask(button, () => downloadPost(article));
        });
        headerControls.insertBefore(button, control);
      }
    });
  }

  function addGridButtons() {
    const anchors = document.querySelectorAll(
      "main a[href*='/p/'], main a[href*='/reel/'], main a[href*='/tv/']",
    );
    anchors.forEach((anchor) => {
      if (
        anchor.closest("article") ||
        anchor.querySelector(":scope > .oig-grid-button")
      ) {
        return;
      }
      const media = anchor.querySelector("img, video");
      if (!media) return;
      anchor.classList.add("oig-grid-owner");
      const button = createIconButton("Download this post", {
        all: true,
        className: "oig-grid-button",
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        runButtonTask(button, () => downloadPost(anchor));
      });
      anchor.appendChild(button);
    });
  }

  function addReelButtons() {
    if (state.route !== "reels-feed") return;
    document.querySelectorAll("main video").forEach((video) => {
      const owner = video.parentElement;
      if (!owner || owner.querySelector(":scope > .oig-reel-button")) return;
      owner.classList.add("oig-reel-owner");
      const button = createIconButton("Download this Reel", {
        className: "oig-reel-button",
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        runButtonTask(button, () => downloadPost(video));
      });
      owner.appendChild(button);
    });
  }

  async function acquireDirectory({ chooseNew = false } = {}) {
    try {
      if (!chooseNew && state.directoryHandle?.kind === "directory") {
        const permission = state.directoryHandle.requestPermission
          ? await state.directoryHandle.requestPermission({ mode: "readwrite" })
          : "granted";
        if (permission === "granted") return state.directoryHandle;
      }
      if (typeof window.showDirectoryPicker !== "function") {
        throw new Error(
          "This browser does not support choosing a download folder",
        );
      }
      const handle = await window.showDirectoryPicker({
        id: "open-igdownload",
        mode: "readwrite",
        startIn: "downloads",
      });
      await Core.idbSet(DIRECTORY_KEY, handle);
      state.directoryHandle = handle;
      return handle;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      throw error;
    }
  }

  function profilePostCountFromDocument() {
    const descriptions = document.querySelectorAll(
      'meta[name="description"], meta[property="og:description"]',
    );
    for (const description of descriptions) {
      const match = description.content?.match(/([\d,.]+)\s+Posts\b/i);
      if (!match) continue;
      const count = Number(match[1].replace(/[^\d]/g, ""));
      if (Number.isSafeInteger(count)) return count;
    }
    return 0;
  }

  async function collectProfileMedia(username, progress) {
    const items = [];
    const seen = new Set();
    const seenCursors = new Set();
    let account = {
      profilePicUrl: null,
      totalPosts: profilePostCountFromDocument(),
      username,
    };
    let after = null;
    let page = 0;
    let postCount = 0;
    let photoCount = 0;
    let videoCount = 0;
    do {
      const response = await bridge("profile-timeline", { username, after });
      const timeline = Core.normalizeProfileTimelinePage(response, username);
      if (!timeline) {
        throw new Error("Instagram returned an unsupported profile response");
      }
      account = {
        ...account,
        ...timeline.account,
        // Historical posts can still carry an older owner username.
        // Keep the export folder tied to the profile being downloaded.
        username,
        totalPosts: account.totalPosts,
      };
      postCount += timeline.postCount;
      for (const item of timeline.items) {
        const key = `${item.pk}:${item.url}`;
        if (!seen.has(key)) {
          seen.add(key);
          items.push(item);
          if (item.mediaType === "video") videoCount += 1;
          else photoCount += 1;
        }
      }
      page += 1;
      progress.update(
        Math.min(postCount, account.totalPosts),
        account.totalPosts,
        `Finding ${account.username}'s media… ${items.length.toLocaleString()} (${photoCount.toLocaleString()} photos ${videoCount.toLocaleString()} videos)`,
      );
      const next = timeline.pageInfo.hasNextPage
        ? timeline.pageInfo.endCursor
        : null;
      if (!next || next === after || seenCursors.has(next)) break;
      seenCursors.add(next);
      after = next;
      await Core.sleep(1_200);
    } while (after);
    return { account, items };
  }

  async function writeProfileMedia(root, account, items, progress) {
    const accountFolder = await root.getDirectoryHandle(
      Core.sanitizeFilenamePart(account.username),
      { create: true },
    );
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const filename = Core.filenameFor(item);
      try {
        const fileHandle = await accountFolder.getFileHandle(filename, {
          create: true,
        });
        const existing = await fileHandle.getFile();
        if (existing.size > 0) {
          skipped += 1;
        } else {
          const response = await fetch(item.url, { credentials: "omit" });
          if (!response.ok)
            throw new Error(`Media request failed (${response.status})`);
          const writable = await fileHandle.createWritable();
          await writable.write(await response.blob());
          await writable.close();
          downloaded += 1;
        }
      } catch (error) {
        failed += 1;
        try {
          const errorHandle = await accountFolder.getFileHandle(
            `${filename}.error.txt`,
            {
              create: true,
            },
          );
          const writable = await errorHandle.createWritable();
          await writable.write(
            `Open IGDownload could not save this file.\nURL: ${item.url}\nError: ${error?.message || error}`,
          );
          await writable.close();
        } catch (_writeError) {}
      }
      progress.update(
        index + 1,
        items.length,
        `Saving ${account.username}… ${(index + 1).toLocaleString()}/${items.length.toLocaleString()}`,
      );
      if (item.mediaType === "video") await Core.sleep(250);
    }
    return { downloaded, failed, skipped };
  }

  async function downloadProfile(username, type, root) {
    if (!root) return;
    const progress = progressNotice(`Finding ${username}'s media…`, {
      persistent: true,
    });
    try {
      const { account, items: allItems } = await collectProfileMedia(
        username,
        progress,
      );
      const items = type === "all"
        ? allItems
        : allItems.filter((item) => item.mediaType === type);
      if (!items.length) {
        progress.fail(
          `No ${type === "all" ? "photos or videos" : type === "video" ? "videos" : "images"} found for ${username}.`,
        );
        return;
      }
      const result = await writeProfileMedia(root, account, items, progress);
      const summary = `${result.downloaded.toLocaleString()} new, ${result.skipped.toLocaleString()} skipped${result.failed ? `, ${result.failed.toLocaleString()} failed` : ""}.`;
      progress.finish(`Saved to ${root.name}/${account.username}. ${summary}`);
    } catch (error) {
      progress.fail(error?.message || "Profile download failed");
      throw error;
    }
  }

  function addProfileMenu() {
    if (state.route !== "profile") return;
    const username = Core.profileUsername(location.href);
    if (!username || document.querySelector(".oig-profile-menu")) return;
    const headings = [
      ...document.querySelectorAll("header h1, header h2, main h1, main h2"),
    ];
    const heading =
      headings.find(
        (node) =>
          node.textContent.trim().toLowerCase() === username.toLowerCase(),
      ) || headings[0];
    if (!heading) return;
    const profileSection = heading.closest("section");
    if (!profileSection) return;

    const menu = document.createElement("span");
    menu.className = "oig-profile-menu";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "oig-profile-menu-trigger";
    trigger.textContent = "Download All";
    trigger.setAttribute("aria-expanded", "false");
    const list = document.createElement("span");
    list.className = "oig-profile-menu-list";

    for (const [label, type] of [
      ["Download All Photos and Videos", "all"],
      ["Download All Photos", "image"],
      ["Download All Videos", "video"],
    ]) {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = label;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.classList.remove("oig-open");
        trigger.setAttribute("aria-expanded", "false");
        runButtonTask(item, async () => {
          const root = await acquireDirectory();
          if (root) await downloadProfile(username, type, root);
        });
      });
      list.appendChild(item);
    }

    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = menu.classList.toggle("oig-open");
      trigger.setAttribute("aria-expanded", String(open));
    });
    menu.append(trigger, list);
    profileSection.appendChild(menu);
  }

  function addProfilePictureButton() {
    if (state.route !== "profile") return;
    const header = document.querySelector("main header, header");
    const image = [...(header?.querySelectorAll("img") || [])].find(
      (candidate) =>
        candidate.clientWidth >= 70 || candidate.naturalWidth >= 150,
    );
    const owner = image?.parentElement;
    if (!owner || owner.querySelector(":scope > .oig-avatar-button")) return;
    owner.classList.add("oig-avatar-owner");
    const button = createIconButton("Download profile picture", {
      className: "oig-avatar-button",
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runButtonTask(button, async () => {
        const username =
          Core.profileUsername(location.href) || image.alt || "unknown";
        await downloadItems([
          {
            id: "profile",
            pk: "profile",
            takenAt: 0,
            username,
            mediaType: "image",
            url: image.currentSrc || image.src,
          },
        ]);
      });
    });
    owner.appendChild(button);
  }

  function currentStoryMediaId() {
    const media = document.querySelector(
      `video[${MEDIA_ID_ATTRIBUTE}], img[${MEDIA_ID_ATTRIBUTE}]`,
    );
    return media?.getAttribute(MEDIA_ID_ATTRIBUTE)?.match(/^\d+/)?.[0] || null;
  }

  async function storyItems(all) {
    const route = Core.storyRoute(location.href);
    if (!route) throw new Error("Could not identify this Story");
    const tray = await bridge("story-tray");
    const trayItem = (tray || []).find(
      (entry) =>
        entry?.user?.username?.toLowerCase() === route.username.toLowerCase(),
    );
    const reelId =
      route.username.toLowerCase() === "highlights"
        ? `highlight:${route.initialMediaId}`
        : trayItem?.id;
    if (!reelId)
      throw new Error(
        "Story data is not ready. Refresh Instagram and try again.",
      );
    const mediaId = all ? null : currentStoryMediaId() || route.initialMediaId;
    const response = await bridge("story-media", { reelId, mediaId });
    const reel = response?.reels_media?.[0];
    const username =
      response?.reels?.[reelId]?.user?.username ||
      reel?.user?.username ||
      trayItem?.user?.username ||
      route.username;
    let media = reel?.items || [];
    if (!all && mediaId) {
      const filtered = media.filter(
        (item) => String(item.pk || item.id).split("_")[0] === String(mediaId),
      );
      if (filtered.length) media = filtered;
    }
    return media.flatMap((item) => Core.normalizeApiMedia(item, username));
  }

  async function downloadStory(all) {
    const finding = progressNotice(
      all ? "Finding all Stories…" : "Finding Story…",
    );
    try {
      const items = await storyItems(all);
      finding.finish("Story media found.");
      await downloadItems(
        items,
        all ? "Downloading Stories" : "Downloading Story",
      );
    } catch (error) {
      if (!all) {
        const fallback = domMediaFallback(
          document.querySelector("main") || document.body,
        );
        if (fallback.length) {
          finding.finish("Using the visible Story.");
          await downloadItems(fallback, "Downloading Story");
          return;
        }
      }
      finding.fail(error?.message || "Could not find Story");
      throw error;
    }
  }

  function addStoryControls() {
    document.querySelector(".oig-story-controls")?.remove();
    if (state.route !== "story") return;
    const controls = document.createElement("div");
    controls.className = "oig-story-controls";
    const current = createIconButton("Download current Story");
    const all = createIconButton("Download all Stories", { all: true });
    current.addEventListener("click", () =>
      runButtonTask(current, () => downloadStory(false)),
    );
    all.addEventListener("click", () =>
      runButtonTask(all, () => downloadStory(true)),
    );
    controls.append(current, all);
    document.body.appendChild(controls);
  }

  function removeRouteSpecificControls() {
    if (state.route !== "profile") {
      document
        .querySelectorAll(".oig-profile-menu,.oig-avatar-button")
        .forEach((node) => node.remove());
    }
    if (state.route !== "story")
      document.querySelector(".oig-story-controls")?.remove();
  }

  function refreshControls() {
    state.route = Core.routeFor(location.href);
    if (state.route === "options") {
      if (!document.getElementById("oig-options-root")) renderOptions();
      return;
    }
    removeRouteSpecificControls();
    addSettingsButtons();
    addPostButtons();
    addGridButtons();
    addReelButtons();
    addProfileMenu();
    addProfilePictureButton();
    if (
      state.route === "story" &&
      !document.querySelector(".oig-story-controls")
    ) {
      addStoryControls();
    }
  }

  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refreshControls, 120);
  }

  function installObserver() {
    state.observer = new MutationObserver(scheduleRefresh);
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function installKeyboardShortcut() {
    document.addEventListener(
      "keydown",
      (event) => {
        const target = event.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        )
          return;
        const command = event.ctrlKey || event.metaKey;
        if (command && event.shiftKey && event.key.toLowerCase() === "d") {
          event.preventDefault();
          event.stopPropagation();
          if (Core.routeFor(location.href) === "story") {
            downloadStory(false).catch((error) =>
              notice(error?.message || "Story download failed", "error"),
            );
          } else {
            const targetPost =
              document.querySelector("article") ||
              document.querySelector("main");
            if (targetPost) {
              downloadPost(targetPost).catch((error) =>
                notice(error?.message || "Post download failed", "error"),
              );
            }
          }
        } else if (
          event.ctrlKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === "s"
        ) {
          notice(
            "Open IGDownload uses Ctrl/Cmd + Shift + D to save Instagram media.",
          );
        }
      },
      true,
    );
  }

  async function chooseOptionsDirectory(button, nameElement, statusElement) {
    if (button.disabled) return;
    button.disabled = true;
    statusElement.textContent = "";
    statusElement.classList.remove("oig-setting-error");
    try {
      // Invoke the picker directly from the click, even with a saved folder.
      const handle = await acquireDirectory({ chooseNew: true });
      if (!handle) return;
      nameElement.textContent = `📁 ${handle.name}`;
      statusElement.textContent = "Download folder saved.";
    } catch (error) {
      statusElement.classList.add("oig-setting-error");
      statusElement.textContent = error?.message || "Could not choose a folder. Try again.";
    } finally {
      button.disabled = false;
    }
  }

  async function renderOptions() {
    await waitForBody();
    if (document.getElementById("oig-options-root")) return;
    document.title = "Settings • Open IGDownload";
    document.documentElement.style.overflow = "hidden";
    const root = document.createElement("div");
    root.id = "oig-options-root";
    root.innerHTML = `
      <main class="oig-options-shell">
        <header class="oig-options-header">
          <img class="oig-options-logo" src="${chrome.runtime.getURL("icons/icon-48.png")}" alt="" width="50" height="50">
          <div><h1>Open IGDownload</h1></div>
        </header>
        <section class="oig-options-card" aria-label="Settings">
          <div class="oig-setting-row">
            <div class="oig-setting-copy">
              <strong>Profile download folder</strong>
              <span>Choose where to save profile downloads.</span><br />
              <span class="oig-directory-name"></span>
              <div class="oig-setting-status" role="status" aria-live="polite"></div>
            </div>
            <button type="button" class="oig-options-button oig-choose-directory">Choose folder</button>
          </div>
        </section>
        <footer class="oig-options-footer">
          <span class="oig-options-version"></span>
          <a href="https://www.instagram.com/">Back to Instagram</a>
        </footer>
      </main>`;
    document.body.appendChild(root);

    const directoryName = root.querySelector(".oig-directory-name");
    directoryName.textContent = state.directoryHandle
      ? `📁 ${state.directoryHandle.name}`
      : "Folder not set";
    const chooseButton = root.querySelector(".oig-choose-directory");
    const statusElement = root.querySelector(".oig-setting-status");
    chooseButton.addEventListener("click", () =>
      chooseOptionsDirectory(chooseButton, directoryName, statusElement),
    );

    root.querySelector(".oig-options-version").textContent =
      `Version ${chrome.runtime.getManifest().version} • no analytics`;
    for (const child of document.body.children) {
      if (child === root) continue;
      child.inert = true;
      child.setAttribute("aria-hidden", "true");
    }
    const optionsObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || node === root) continue;
          node.inert = true;
          node.setAttribute("aria-hidden", "true");
        }
      }
    });
    optionsObserver.observe(document.body, { childList: true });
  }

  async function loadState() {
    try {
      state.directoryHandle = await Core.idbGet(DIRECTORY_KEY);
    } catch (_error) {}
  }

  async function start() {
    await waitForBody();
    await loadState();
    state.route = Core.routeFor(location.href);
    if (state.route === "options") {
      await renderOptions();
      return;
    }
    installKeyboardShortcut();
    installObserver();
    refreshControls();
    window.addEventListener(NAVIGATION_EVENT, scheduleRefresh);
    window.addEventListener("hashchange", scheduleRefresh);
  }

  start().catch((error) =>
    console.error("Open IGDownload failed to start", error),
  );
})();
