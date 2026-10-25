# 🧮 Abacus

Abacus is a self-hosted digital asset management (DAM) system for images, GIFs, videos, and saved posts.
It runs as a web app with a Node.js backend and a SQLite database, and ships as a single Docker image.

![Preview](preview.jpg)

## Features

- Grid view with three layouts: waterfall, justified rows, and square grid.
- Nested folders with colors. An item can belong to more than one folder.
- Tags, notes, and 0–5 star ratings.
- Search across names, notes, tags, post text, authors, and URLs.
- Filters by type, source, rating, and dominant color.
- Import from X (Twitter) post links, image and video URLs, web pages, Are.na channel exports, and local
  files.
- Optional import providers, such as [cobalt](https://github.com/imputnet/cobalt), for YouTube, TikTok,
  Instagram, Reddit, and other sites.
- A bookmarklet that saves the current page from any browser.
- A full-screen viewer with zoom and keyboard navigation.

## Requirements

- Docker with Docker Compose, or
- Node.js 22.13 or later to run without Docker.

## Run with Docker

1. Clone the repository:

   ```bash
   git clone https://github.com/ferraridavide/abacus.git
   cd abacus
   ```

1. Build and start the container:

   ```bash
   docker compose up -d --build
   ```

1. Open <http://localhost:8080>.

The database, original files, and thumbnails are stored in the `abacus-data` Docker volume.

## Run locally

1. Install dependencies:

   ```bash
   npm run install:all
   ```

1. Start the API server and the web client:

   ```bash
   npm run dev
   ```

   The API server listens on port 8080 and stores data in `./data`. The web client listens on port 5173
   and proxies API requests to the server.

To run a production build without Docker:

```bash
npm run build
npm start
```

## Configuration

Set these environment variables in `docker-compose.yml` or in your shell.

| Variable             | Default  | Description                                              |
| -------------------- | -------- | -------------------------------------------------------- |
| `PORT`               | `8080`   | HTTP port.                                               |
| `DATA_DIR`           | `./data` | Directory for the database, files, and thumbnails.       |
| `AUTH_PASSWORD`      | None     | If set, the server requires HTTP basic authentication.   |
| `AUTH_USER`          | `abacus` | User name for basic authentication.                      |
| `IMPORT_CONCURRENCY` | `3`      | Number of links fetched in parallel during an import.    |
| `MAX_DOWNLOAD_MB`    | `1024`   | Maximum size of a single downloaded or uploaded file.    |

Per-browser preferences, such as layout, thumbnail size, and video autoplay, are set in **Settings**. Import
providers are also set up there, and apply to every browser.

## Import content

To open the import dialog, click **Import**. You can also drop files or paste links anywhere in the window.

### X posts

Paste one or more post URLs. Abacus detects every post link in the pasted text. Photos are saved at
original resolution, and videos and GIFs are saved as MP4. Posts without media are saved as text cards.
The author, post text, and post date are stored with each item.

Abacus reads posts through X's public embed endpoint and falls back to the public fxtwitter API. Neither
requires an API key. Protected and deleted posts can't be imported.

### Import providers

Import providers are external services that download media from sites Abacus has no importer of its own for.
When one is turned on, Abacus sends it each pasted link that isn't an X post. If no provider supports the link,
or the link has no media, Abacus imports it as a web page.

Abacus supports one provider, [cobalt](https://github.com/imputnet/cobalt), which downloads from YouTube,
TikTok, Instagram, Reddit, Bluesky, Vimeo, SoundCloud, and other sites. Videos are saved as MP4, and posts with
several photos or videos are saved as one item per file. The title, description, and preview image are read
from the page. These items have the **Social** source. If cobalt supports a site but can't download the post,
the import fails with cobalt's error code, for example `content.video.unavailable`.

To set up cobalt:

1. Run a cobalt instance that the Abacus server can reach. For example, on the same Docker host:

   ```bash
   docker run -d --name cobalt --restart unless-stopped -p 9000:9000 \
     -e API_URL=http://192.168.1.10:9000/ ghcr.io/imputnet/cobalt:11
   ```

   Replace `192.168.1.10` with the host's address. For more options, such as API keys and cookies for sites
   that need a login, see [how to run a cobalt instance](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md).

1. In Abacus, open **Settings** > **Import sources**.
1. Enter the instance URL, for example `http://192.168.1.10:9000`, and the API key if the instance requires
   one.
1. Click **Test connection**, then click **Save**.

The **Links** tab of the import dialog then lists the sites that cobalt supports. To stop using cobalt, turn it
off in **Settings** and click **Save**.

### Are.na

1. In Are.na, open a channel and export it as a .zip file.
1. Drop the .zip file into Abacus, or select it on the **Are.na** tab of the import dialog.

Each channel becomes a folder. Block titles, descriptions, source URLs, and dates are kept.

### Bookmarklet

On the **Bookmarklet** tab of the import dialog, drag the **Save to Abacus** button to your bookmarks bar.
Click the bookmark on any page to save that page or post to your library.

Importing the same item twice doesn't create a duplicate.

## Data storage

| Path                     | Contents                       |
| ------------------------ | ------------------------------ |
| `DATA_DIR/library.db`    | SQLite database (WAL mode).    |
| `DATA_DIR/files/<id>/`   | Original files.                |
| `DATA_DIR/thumbs/`       | WebP thumbnails.               |

To back up a library, copy `DATA_DIR` while the server is stopped.
