# Open IGDownload

Open IGDownload is a readable Manifest V3 Chrome extension that reproduces the user-facing behavior of the bundled Turbo Downloader reference without its minified application code, analytics, or error-reporting services.

## Features

- Download a photo, video, Reel, or every item in a carousel.
- Download posts from profile, Explore, Saved, Tagged, and Reel grids.
- Download the current Story or every available Story for the account.
- Export all profile images or all profile videos into a selected folder.
- Skip files that already exist during profile exports.
- Download a profile picture.
- Use `Ctrl+Shift+D` on Windows/Linux or `Cmd+Shift+D` on macOS for the current post or Story.
- See download discovery, queue, and profile-export progress on the Instagram page.

The extension contains no analytics. Media lookup requests go only to Instagram, and downloads go only to Instagram/Facebook CDN hosts.

## Install locally

1. Open `chrome://extensions` in Chrome, Edge, or another Chromium browser.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `Open-IGDownload` directory.
5. Sign in to Instagram and refresh any Instagram tabs that were already open.

Click the extension toolbar button to open settings. The settings screen is shown on `instagram.com` so the browser can safely persist the selected File System Access directory handle for profile exports.

## Usage notes

- Use the download icon beside Instagram's **More options** control for a complete post or carousel.
- Hover a grid tile for its local download control.
- On a profile, open **Download All** and choose images or videos. The first run asks for a root folder and creates a folder named after the profile.
- Story controls appear near the top-right of the Story viewer.
- Instagram can temporarily rate-limit large profile exports. The exporter waits between pagination requests and records a small `.error.txt` next to any profile item it could not write.

Only download media you are allowed to access and save.

## Development

There is no build step and no runtime dependency. All extension source is in `src/`.

```sh
npm test
npm run check
```

The main-world bridge is intentionally small: it reads Instagram's current app/claim values, annotates React-rendered media IDs, calls Instagram's own post/Story loaders, and pages profile exports through Instagram's Relay timeline connection. Profile queries resolve their current persisted-operation IDs from Instagram's loaded page modules and advance with Relay `end_cursor` values. The isolated content script owns all UI, settings, media normalization, and profile-folder writes. The service worker validates CDN hosts and hands individual downloads to Chrome's download manager.

Instagram changes its private DOM and response formats frequently. The implementation uses semantic selectors and multiple response fallbacks, but a future Instagram update may require selector or adapter updates.
