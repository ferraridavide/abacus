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

**Save and test** saves the settings and checks the connection. Settings stay in this browser profile
(`chrome.storage.local`) and aren't synced to your Google account.

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

Imports are followed until they finish, even long video downloads, and a notification shows the result or the
reason it failed. Saving a page that is already in your library doesn't change it.
Pending imports stay in local storage and are checked once a minute in the background, including after the
popup closes or Chrome restarts. Temporary connection failures are retried for up to 15 minutes.

## Files

| File            | Purpose                                                  |
| --------------- | -------------------------------------------------------- |
| `manifest.json` | Permissions, popup, options page, keyboard shortcut.     |
| `lib.js`        | Settings, authentication, `POST /api/add`, job polling.  |
| `background.js` | Right-click menu, keyboard shortcut, notifications.      |
| `pending-jobs.js` | Persistent imports and alarm-based recovery.          |
| `popup.*`       | The toolbar popup.                                       |
| `options.*`     | The settings page.                                       |
| `autocomplete*.js` | Shared lazy folder/tag suggestions and field setup.    |
| `icons/`        | The icon (`icon.svg`) and its PNG sizes.                 |
