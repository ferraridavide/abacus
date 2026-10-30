# Abacus add API

Abacus has one endpoint for adding content: **`POST /api/add`**. The web app, the bookmarklet, and the Chrome
extension all use it, so anything that can make an HTTP request can add to the library.

The older `POST /api/import`, `POST /api/upload`, and `POST /api/import/arena` routes still work. They are thin
wrappers over the same code.

The examples use `http://my-server:8090`; replace it with the address you open Abacus at.

## Authentication

`/api/add` accepts either credential:

- **The API token** (recommended for scripts and extensions), sent as `Authorization: Bearer <token>` or
  `x-api-key: <token>`. Set it on the server with the `API_TOKEN` environment variable. Generate one with
  `openssl rand -hex 24`.
- **The web login** (`AUTH_USER` / `AUTH_PASSWORD`), as HTTP basic auth.

The token can only add content. It works on these routes and nothing else:

| Route                  | Used for                                   |
| ---------------------- | ------------------------------------------ |
| `POST /api/add`        | Adding links, notes, and files.            |
| `POST /api/v1/add`     | The same, under a versioned path.          |
| `GET /api/jobs/:id`    | Following an import.                       |
| `GET /api/bootstrap`   | Listing folders, for a folder picker.      |

Any other request made with the token gets `403`. Reading, editing, or deleting items, changing settings, and
downloading files need the web login. So a leaked token can add items, but can't read or delete your library.

`API_TOKEN` is in addition to the login. Keep `AUTH_PASSWORD` set when you use the web app, because browsers can't
send a bearer token.

`GET /api/health` needs no credentials. Browser extensions may call the API cross-origin
(`chrome-extension://`, `moz-extension://`, `safari-web-extension://`); websites may not.

```bash
curl -sS http://my-server:8090/api/add \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/photo.jpg"}'
```

## `POST /api/add` with JSON

Imports links, or stores a note when there are none.

| Field       | Type               | Description                                                                                  |
| ----------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `url`       | string             | A link to import. Must be `http://` or `https://`.                                            |
| `urls`      | string[]           | Several links.                                                                               |
| `text`      | string             | Text to scan for links. Without links, it becomes the text of a note.                        |
| `name`      | string             | The title of a note, or of a single imported link. Ignored when several links are imported.   |
| `notes`     | string             | Notes for a note or for newly imported links.                                                |
| `tags`      | string[] or string | Tags. A comma-separated string also works.                                                   |
| `folder`    | string             | A folder path from the top level, like `Inbox` or `Design / Logos`. Missing folders are created. |
| `folderId`  | string             | A folder id. If the folder no longer exists, `folder` is used instead, or no folder (with a warning). |
| `parentId`  | string             | The folder that `folder` is relative to.                                                     |
| `source`    | string             | The source of a note: `api` (default), `web`, `upload`, `x`, `social`, or `arena`.           |
| `async`     | boolean            | Answer as soon as the import starts, with a job to follow.                                   |
| `linksOnly` | boolean            | Answer `400` when there are no links, instead of creating a note.                            |

Links go through the import pipeline: X posts use Abacus's X importer, sites that an import provider supports use
the provider, direct media URLs are downloaded, and other pages are saved with their preview image.

Adding a link that is already in the library doesn't create a duplicate, and doesn't change the existing item:
its name and notes stay as they are. The response counts it as `skipped`.

### Response

```json
{
  "ok": true,
  "pending": false,
  "created": 1,
  "skipped": 0,
  "failed": 0,
  "warnings": [],
  "items": [{ "id": "mvt…", "name": "A photo", "type": "image", "folders": ["mvt…"], "tags": ["inspiration"] }],
  "job": { "id": "mvt…", "status": "done", "total": 1, "imported": 1, "skipped": 0, "failed": 0, "entries": […] }
}
```

| Status | Meaning                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- |
| `201`  | At least one item was created.                                                                 |
| `200`  | Nothing new: everything was already in the library, or some links failed and others were skipped. |
| `202`  | `async: true`. `job.status` is `running`; follow `GET /api/jobs/:id`.                          |
| `400`  | Nothing to add, a link that isn't http(s), or an unknown `parentId`.                           |
| `401`  | Missing or wrong credentials.                                                                  |
| `403`  | The API token was used on a route it can't use.                                                |
| `502`  | Every link failed. `error` has the reasons, for example `example.com/x: HTTP 404`.             |

`warnings` lists things worth telling the user that didn't stop the save, such as a deleted folder, or notes that
weren't applied because the item was already in the library.

`items` is empty while a job is running. `name` and `notes` are still applied to new items when it finishes.

## `POST /api/add` with a file

Send `multipart/form-data` with one `file` part:

| Part       | Description                                                                           |
| ---------- | ------------------------------------------------------------------------------------- |
| `file`     | The file.                                                                             |
| `folder`, `folderId`, `tags`, `notes` | As for JSON.                                               |
| `name`     | The item's name. Defaults to the file name without its extension.                     |
| `url`      | The page the file came from (http/https).                                             |
| `width`, `height`, `duration` | For videos, when the client already knows them.                    |
| `thumb`    | A poster image for a video.                                                           |
| `arena`    | `auto` (default), `only`, or `off`. See below.                                        |

```bash
curl -sS http://my-server:8090/api/add \
  -H "Authorization: Bearer $API_TOKEN" \
  -F "file=@photo.jpg" -F "folder=Inbox" -F "tags=inspiration,design"
```

The response is `201` with the item in `items`.

### Are.na exports

A `.zip` that is an Are.na channel export is imported: each channel becomes a folder, inside `folder` if given.
The response is `202` with a job. Any other `.zip` is stored as a file. Set `arena=only` to get `422` instead when
the zip isn't an export, or `arena=off` to always store the zip as a file.

## Jobs

`GET /api/jobs/:id` returns the job. Jobs are kept in memory, the last 50, so follow one soon after starting it.

## Examples

A note:

```bash
curl -sS http://my-server:8090/api/add \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"Reading list","text":"Books to buy","folder":"Inbox","tags":["later"]}'
```

JavaScript:

```js
const res = await fetch('http://my-server:8090/api/add', {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.API_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://x.com/user/status/123', folder: 'Inbox' }),
});
const result = await res.json();
if (!res.ok) throw new Error(result.error);
```

Python:

```python
import os, requests

res = requests.post(
    "http://my-server:8090/api/add",
    headers={"Authorization": f"Bearer {os.environ['API_TOKEN']}"},
    json={"url": "https://example.com/photo.jpg", "folder": "Inbox"},
    timeout=300,
)
res.raise_for_status()
```

For long imports, such as videos, send `"async": true` and follow the job, so no request has to stay open.

## Errors

Errors are JSON with an `error` message:

```json
{ "error": "Parent folder not found" }
```

## Clients in this repository

- `extensions/chrome/`: Chrome extension (popup, right-click menu, `Alt+Shift+A`).
- `/quick-add?url=…`: the bookmarklet's page.
