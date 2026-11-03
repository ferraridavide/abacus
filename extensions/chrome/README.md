# Abacus Chrome extension

A Manifest V3 extension that saves the current page, a link, an image, a selection, a screenshot, or a note to
Abacus. It uses the same `POST /api/add` endpoint as the web app, and the bookmarklet. Saving never needs a page
reload in Abacus: the web app notices the new item and refreshes by itself.

## Install

1. Open `chrome://extensions` in Chrome (or another Chromium browser).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extensions/chrome` folder. Chrome loads it from there, so keep the
   folder where it is.

The options page opens on install.

## Set up

- **Server URL**: the address you open Abacus at, like `http://my-server:8090`. When you save, Chrome asks for
  access to that server; choose **Allow**. The extension has no access to any other site.
- **API token**: create a named API key in Abacus under **Settings → Integration**, copy it, and paste it here.
  It can only add content, so it's safer to keep in a browser than the login. You can use the login (username
  and password) instead. Revoke the key from Integration when you no longer need it.
- **Default folder**: optional. A path like `Design / Logos`; missing folders are created.
- **Default tags**: optional, comma separated. Folder and tag fields suggest existing values on focus;
  suggestions load on first use and support arrow keys, Enter, and Escape. You can still type new values.
- **Quick save → Context menu**: enable or disable all Abacus right-click entries. Off by default;
  changes apply immediately.
- **Quick save → Keyboard shortcut**: enable or disable saving with a shortcut. Off by default. Use
  **shortcut keycaps / edit button** to assign, change, or remove the key combination in Chrome’s shortcut editor.

- **Page tools**: *Drag to save* and *Alt + right-click* run inside web pages, so Chrome asks you to allow access
  to websites when you turn either on; both are off by default, and the extension runs nothing on pages while both
  are off. *Find high-resolution versions* (on by default) looks for the full-size file behind thumbnails.
  *Screenshot format* picks PNG, JPEG, or WebP.

**Save and test** saves the settings and checks the connection. Settings stay in this browser profile
(`chrome.storage.local`) and aren't synced to your Google account.

The popup, the options page and the page tools follow the theme of the server you connect to: the colour scheme,
theme, accent colour and corners come from **Settings → Appearance** in Abacus. The connection test pulls it as soon
as it succeeds, and every popup open refreshes it, so a theme change in the app lands in the extension without
reinstalling.

## Use

- **Toolbar popup**: edit the folder, tags, title, or note, then **Save to Abacus**. The title is filled with the
  tab's title; it's only used when you change it, so posts and videos otherwise keep the title Abacus reads from
  the page. Enter a folder path or use your saved default. The popup contacts the server only when you save
  or open folder/tag autocomplete.
  The **Open Abacus** icon next to settings opens your web app in a new tab.
- **Right-click menu**: *Save to Abacus*, *Save link to Abacus*, *Save image to Abacus*, or *Save selection to Abacus*. A selection that
  contains a link imports it; other text becomes a note.
- **Keyboard**: enable the shortcut in extension settings and assign keys with **shortcut keycaps / edit button**.
  No key combination is assigned by default. To release an assigned combination, remove it in Chrome’s shortcut editor.

### Page tools

- **Drag to save**: start dragging any image and a dock of your folders (the default one first, then the recent
  ones) appears at the bottom of the page. Drop the image on a folder to save it there. Dragging somewhere
  else, into a text editor for example, behaves as usual because the drag is never changed.
- **Alt + right-click**: saves the image under the pointer, including images covered by an overlay and pages that
  block the context menu. A small toast confirms it.
- **High resolution**: the extension tries the full-size file first and the displayed image as a fallback. It
  reads `data-orig-file`/`data-full-url`-style attributes, links to image files, the widest `srcset` entry, and
  the size parameters of X, Pinterest, Wikimedia, Unsplash, Google, Shopify, Cloudinary, Imgur, and WordPress.
  The page is sent to Abacus as the Referer, so images that refuse hotlinking still download.
  An image is stored with the page it came from as its source link.
- **Screenshots** (popup, right-click *Screenshot to Abacus*, or keyboard): *Area* (drag a rectangle), *Element*
  (click it; ↑ and ↓ pick its parent or child), *Full page* (scrolled strips stitched together, fixed headers shown
  once), and *Visible*. Esc cancels. Very tall pages are scaled down to stay inside the browser's canvas limits.
- **Save all images on this page** (popup or right-click): opens a page with every image and video found. Filter by
  minimum size and format, untick what you don't want, choose a folder and tags, and save them in one go. Small
  images (under 200 × 200) start filtered out; images already in your library are skipped.

Keyboard shortcuts for the screenshots and *Save all images* are listed in `chrome://extensions/shortcuts`, with
the same on/off switch as the page shortcut. No key combination is assigned by default.

Imports are followed until they finish, even long video downloads, and a notification shows the result or the
reason it failed. Saving a page that is already in your library doesn't change it.
Pending imports stay in local storage and are checked once a minute in the background, including after the
popup closes or Chrome restarts. Temporary connection failures are retried for up to 15 minutes.

## Files

| File            | Purpose                                                  |
| --------------- | -------------------------------------------------------- |
| `manifest.json` | Permissions, popup, options page, keyboard shortcut.     |
| `lib.js`        | Settings, authentication, `POST /api/add`, job polling.  |
| `background.js` | Right-click menu, shortcuts, screenshots, notifications. |
| `hd.js`         | Finds the full-size URL of an image; scans a page.       |
| `content.js`    | Drag dock and Alt + right-click (registered only when on).|
| `capture.js`, `screenshot.js` | Area/element picker, scroll-and-stitch capture. |
| `batch.*`       | The "Save all images" page.                              |
| `popup-tools.js` | Screenshot and batch buttons in the popup.              |
| `pending-jobs.js` | Persistent imports and alarm-based recovery.          |
| `popup.*`       | The toolbar popup.                                       |
| `options.*`     | The settings page.                                       |
| `autocomplete*.js` | Shared lazy folder/tag suggestions and field setup.    |
| `icons/`        | The icon (`icon.svg`) and its PNG sizes.                 |
