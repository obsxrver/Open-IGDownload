(function initializeBackground() {
  "use strict";

  function allowedUrl(value) {
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

  function safeDownloadPath(value) {
    const parts = String(value || "media")
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .map((part) =>
        part
          .replace(/[<>:"|?*\u0000-\u001f]/g, "")
          .trim()
          .replace(/[. ]+$/g, "")
          .slice(0, 120),
      )
      .filter(Boolean);
    return parts.join("/") || "media";
  }

  function waitForDownload(downloadId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error("Download timed out"));
        },
        10 * 60 * 1000,
      );

      function listener(delta) {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === "complete") {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          resolve(downloadId);
        } else if (delta.state.current === "interrupted") {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error(delta.error?.current || "Download was interrupted"));
        }
      }

      chrome.downloads.onChanged.addListener(listener);
    });
  }

  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

  const REVIEW_PROMPT_KEY = "reviewPromptLastShownAt";
  const REVIEW_DOWNLOADS_KEY = "reviewPromptSuccessfulDownloads";
  const REVIEW_MIN_DOWNLOADS = 3;
  const REVIEW_INTERVAL = 7 * 24 * 60 * 60 * 1000;
  let reviewPromptQueue = Promise.resolve();

  async function recordSuccessfulDownload() {
    const stored = await chrome.storage.local.get(REVIEW_DOWNLOADS_KEY);
    const count = stored[REVIEW_DOWNLOADS_KEY];
    await chrome.storage.local.set({
      [REVIEW_DOWNLOADS_KEY]: Math.min(
        REVIEW_MIN_DOWNLOADS,
        (Number.isSafeInteger(count) && count > 0 ? count : 0) + 1,
      ),
    });
    return { ok: true };
  }

  async function claimReviewPrompt() {
    const stored = await chrome.storage.local.get([
      REVIEW_PROMPT_KEY,
      REVIEW_DOWNLOADS_KEY,
    ]);
    if (!(stored[REVIEW_DOWNLOADS_KEY] >= REVIEW_MIN_DOWNLOADS)) {
      return { ok: true, show: false };
    }
    const lastShown = stored[REVIEW_PROMPT_KEY];
    const now = Date.now();
    if (Number.isFinite(lastShown) && now - lastShown < REVIEW_INTERVAL) {
      return { ok: true, show: false };
    }
    // Persist before responding, so simultaneous tabs cannot both show it.
    await chrome.storage.local.set({ [REVIEW_PROMPT_KEY]: now });
    return { ok: true, show: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "open-igdownload:claim-review-prompt" ||
        message?.type === "open-igdownload:record-download-success") {
      reviewPromptQueue = reviewPromptQueue
        .then(message.type === "open-igdownload:record-download-success"
          ? recordSuccessfulDownload
          : claimReviewPrompt)
        .catch(() => ({ ok: false, show: false }));
      reviewPromptQueue.then(sendResponse);
      return true;
    }
    if (!message || message.type !== "open-igdownload:download") return false;
    if (!allowedUrl(message.url)) {
      sendResponse({ ok: false, error: "Unsupported media URL" });
      return false;
    }

    chrome.downloads
      .download({
        url: message.url,
        filename: safeDownloadPath(message.filename),
        conflictAction: "uniquify",
        saveAs: false,
      })
      .then((downloadId) => waitForDownload(downloadId))
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      );
    return true;
  });
})();
