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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
