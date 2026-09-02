"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.join(__dirname, "..");
const port = Number(process.env.OPEN_IGDOWNLOAD_FIXTURE_PORT || 4173);

const chromeMock = `
  <script>
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ version: "1.0.0" }),
        lastError: null,
        sendMessage: (_message, callback) => callback({ ok: true })
      },
      storage: {
        onChanged: { addListener: () => undefined },
        sync: {
          get: async (defaults) => defaults,
          set: async () => undefined
        }
      }
    };
  </script>`;

function shell(body) {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Open IGDownload browser fixture</title>
      <link rel="stylesheet" href="/src/content.css">
      <style>
        body { background: #fafafa; color: #111; font-family: system-ui; margin: 0; }
        main { margin: 30px auto; max-width: 720px; }
        article { background: #fff; border: 1px solid #ddd; }
        article header, .actions { align-items: center; display: flex; padding: 12px; }
        .header-actions { align-items: center; display: flex; margin-left: auto; }
        .slides { display: flex; list-style: none; margin: 0; overflow: hidden; padding: 0; }
        .slides li { flex: 0 0 100%; height: 410px; }
        .slides img, .grid img { display: block; height: 100%; object-fit: cover; width: 100%; }
        .actions { justify-content: flex-end; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 20px; }
        .grid a { height: 260px; }
        header.profile { display: flex; gap: 24px; align-items: center; }
        header.profile img { border-radius: 50%; height: 140px; width: 140px; }
      </style>
      ${chromeMock}
      <script defer src="/src/lib.js"></script>
      <script defer src="/src/content.js"></script>
    </head>
    <body>${body}</body>
  </html>`;
}

function fixture(pathname) {
  if (pathname.startsWith("/stories/")) {
    return shell(
      `<main><video data-open-igdownload-media-id="123" style="width:600px;height:600px"></video></main>`,
    );
  }
  if (pathname === "/sample/" || pathname === "/sample") {
    return shell(`<main>
      <header class="profile">
        <span><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%238a3ab9'/%3E%3C/svg%3E" alt="sample"></span>
        <section><a href="/sample/#"><h2>sample</h2></a><p>Fixture profile</p></section>
      </header>
      <div class="grid"><a href="/p/GRID123/"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='500' height='500'%3E%3Crect width='500' height='500' fill='%23e95950'/%3E%3C/svg%3E"></a></div>
    </main>`);
  }
  return shell(`<main>
    <article data-open-igdownload-media-id="123456789">
      <header><a href="/sample/">sample</a><div class="header-actions"><div><svg aria-label="More options" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="18" cy="12" r="1.5"></circle></svg></div></div></header>
      <ul class="slides">
        <li><div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='600'%3E%3Crect width='600' height='600' fill='%238a3ab9'/%3E%3C/svg%3E"></div></li>
        <li><div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='600'%3E%3Crect width='600' height='600' fill='%23fccc63'/%3E%3C/svg%3E"></div></li>
      </ul>
      <div class="actions"><button type="button"><svg aria-label="Save" viewBox="0 0 24 24"><path d="M20 22 12 14"></path></svg></button></div>
    </article>
    <div class="grid"><a href="/p/GRID123/"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='500' height='500'%3E%3Crect width='500' height='500' fill='%23e95950'/%3E%3C/svg%3E"></a></div>
  </main>`);
}

http
  .createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/src/")) {
      const filename = path.join(root, url.pathname);
      if (
        !filename.startsWith(path.join(root, "src")) ||
        !fs.existsSync(filename)
      ) {
        response.writeHead(404).end("Not found");
        return;
      }
      const type = filename.endsWith(".css") ? "text/css" : "text/javascript";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` });
      fs.createReadStream(filename).pipe(response);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixture(url.pathname));
  })
  .listen(port, "127.0.0.1", () => {
    console.log(
      `Open IGDownload fixture listening on http://127.0.0.1:${port}`,
    );
  });
