# Abacus Chrome extension

A Manifest V3 extension that saves the current page, a link, an image, a selection, or a note to Abacus. It uses
the same `POST /api/add` endpoint as the web app, and the bookmarklet.

## Install

1. Open `chrome://extensions` in Chrome (or another Chromium browser).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extensions/chrome` folder. Chrome loads it from there, so keep the
   folder where it is.

The options page opens on install.

## Set up

- **Server URL**: the address you open Abacus at, like `http://my-server:8090`. When you save, Chrome asks for
  access to that server; choose **Allow**. The extension has no access to any other site.
- **API token**: the server's `API_TOKEN`. It can only add content, so it's safer to keep in a browser than the
  login. You can use the login (username and password) instead.
- **Default folder**: optional. A path like `Design / Logos`; missing folders are created.
- **Default tags**: optional, comma separated.

**Save and test** saves the settings and checks the connection. Settings stay in this browser profile
(`chrome.storage.local`) and aren't synced to your Google account.

## Use

- **Toolbar popup**: edit the folder, tags, title, or note, then **Save to Abacus**. The title is filled with the
  tab's title; it's only used when you change it, so posts and videos otherwise keep the title Abacus reads from
  the page. The folder field suggests your folders by path.
- **Right-click menu**: *Save page*, *Save link*, *Save image*, or *Save selection to Abacus*. A selection that
  contains a link imports it; other text becomes a note.
- **Keyboard**: `Alt+Shift+A` saves the current page. Change it at `chrome://extensions/shortcuts`.

Imports are followed until they finish, even long video downloads, and a notification shows the result or the
reason it failed. Saving a page that is already in your library doesn't change it.

## Files

| File            | Purpose                                                  |
| --------------- | -------------------------------------------------------- |
| `manifest.json` | Permissions, popup, options page, keyboard shortcut.     |
| `lib.js`        | Settings, authentication, `POST /api/add`, job polling.  |
| `background.js` | Right-click menu, keyboard shortcut, notifications.      |
| `popup.*`       | The toolbar popup.                                       |
| `options.*`     | The settings page.                                       |
| `icons/`        | The icon (`icon.svg`) and its PNG sizes.                 |
