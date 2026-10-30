// Documentation schemas only: keep Fastify's existing request and response handling unchanged.
export const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
export const array = (items) => ({ type: 'array', items });
export const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const string = { type: 'string' };
const number = { type: 'number' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const nullableString = { ...string, nullable: true };
const nullableNumber = { ...number, nullable: true };
const timestamp = { type: 'integer', format: 'int64', description: 'Unix time in milliseconds.' };
const strings = array(string);
const source = { type: 'string', enum: ['api', 'web', 'upload', 'x', 'social', 'arena'] };
const itemType = { type: 'string', enum: ['image', 'gif', 'video', 'bookmark', 'file'] };
const folderFields = {
  name: string, parentId: nullableString, color: nullableString,
};
const addFields = {
  name: { ...string, description: 'Note title, single-link title, or uploaded file name.' },
  notes: string,
  folder: { ...string, example: 'Design / Logos', description: 'Folder path; missing folders are created.' },
  folderId: { ...string, description: 'Existing folder ID; falls back to folder, or no folder with a warning, if missing.' },
  tags: { oneOf: [strings, string], description: 'Tag array, JSON array string, or comma-separated string.' },
  source,
};

export const schemas = {
  Error: object({ error: string }, ['error']),
  Ok: object({ ok: boolean }, ['ok']),
  BatchResult: object({ ok: boolean, count: integer }, ['ok', 'count']),
  Item: object({
    id: string, name: string, type: itemType, ext: nullableString, mime: nullableString,
    fileUrl: nullableString, thumbUrl: nullableString,
    width: nullableNumber, height: nullableNumber, duration: nullableNumber, size: number,
    palette: array(object({ hex: string, ratio: number })),
    url: nullableString, mediaUrl: nullableString, source,
    author: nullableString, authorHandle: nullableString, authorAvatar: nullableString,
    text: nullableString, description: nullableString, notes: nullableString,
    rating: { type: 'integer', minimum: 0, maximum: 5 },
    postedAt: { ...timestamp, nullable: true }, createdAt: timestamp, updatedAt: timestamp,
    deletedAt: { ...timestamp, nullable: true }, tags: strings, folders: strings,
  }, ['id', 'name', 'type', 'tags', 'folders']),
  ItemPatch: object({
    name: string, description: nullableString, notes: nullableString,
    rating: { type: 'number', minimum: 0, maximum: 5 }, url: nullableString, tags: strings, folders: strings,
  }),
  ItemPage: object({
    items: array(ref('Item')), total: integer, offset: integer,
    ranking: { type: 'string', enum: ['similarity'] },
    scores: { type: 'object', additionalProperties: object({
      score: number, kind: { type: 'string', enum: ['image', 'text'] }, textMatch: boolean,
    }) },
  }, ['items', 'total', 'offset']),
  BatchRequest: object({
    ids: strings,
    action: { type: 'string', enum: ['trash', 'restore', 'delete', 'addTags', 'removeTags', 'addToFolder', 'moveToFolder', 'removeFromFolder'] },
    tags: strings, folderId: string, fromFolderId: string,
  }, ['action']),
  FolderTreeEntry: object({ id: string, name: string, parentId: nullableString }, ['id', 'name', 'parentId']),
  Folder: object({
    id: string, ...folderFields, sort: number, createdAt: timestamp, count: integer, cover: nullableString,
  }, ['id', 'name', 'parentId', 'count']),
  FolderCreate: object(folderFields),
  FolderPatch: object({ ...folderFields, sort: number }),
  TagCount: object({ name: string, count: integer }, ['name', 'count']),
  Stats: object({ all: integer, uncategorized: integer, untagged: integer, trash: integer, totalSize: number }),
  Bootstrap: {
    oneOf: [
      { ...object({ folders: array(ref('FolderTreeEntry')) }, ['folders']), additionalProperties: false },
      object({ stats: ref('Stats'), folders: array(ref('Folder')), tags: array(ref('TagCount')) }, ['stats', 'folders', 'tags']),
    ],
    description: 'API keys receive only folders (id, name, parentId). The web login also receives statistics, full folders, and tag counts.',
  },
  Autocomplete: object({ folders: array(ref('FolderTreeEntry')), tags: strings }, ['folders', 'tags']),
  AddRequest: object({
    ...addFields,
    url: { ...string, example: 'https://example.com/photo.jpg', description: 'HTTP or HTTPS link to import.' },
    urls: { oneOf: [strings, string], description: 'One or more HTTP or HTTPS links.' },
    text: { ...string, description: 'Scanned for links; saved as a note if no links are found.' },
    parentId: { ...string, description: 'Parent folder for a relative folder path.' },
    async: { ...boolean, default: false, description: 'Return immediately and poll the job.' },
    linksOnly: { ...boolean, default: false, description: 'Reject text without links rather than creating a note.' },
  }),
  UploadRequest: object({
    ...addFields,
    tags: { ...string, description: 'Comma-separated tags or a JSON array string.' },
    file: { type: 'string', format: 'binary' },
    thumb: { type: 'string', format: 'binary', description: 'Optional video poster.' },
    url: { ...string, description: 'Original HTTP or HTTPS page URL.' },
    width: number, height: number, duration: number,
    arena: { type: 'string', enum: ['auto', 'only', 'off'], default: 'auto', description: 'Import Are.na ZIPs, require an Are.na export, or always store the file.' },
  }, ['file']),
  AddResponse: object({
    ok: boolean, pending: boolean, created: integer, skipped: integer, failed: integer,
    error: string, warnings: strings, items: array(ref('Item')),
    job: { oneOf: [ref('Job'), { type: 'object', nullable: true, enum: [null] }] },
  }, ['ok', 'pending', 'created', 'skipped', 'failed', 'warnings', 'items', 'job']),
  Job: object({
    id: string, status: { type: 'string', enum: ['running', 'done'] },
    createdAt: timestamp, finishedAt: timestamp,
    total: integer, done: integer, imported: integer, skipped: integer, failed: integer,
    error: string,
    entries: array(object({
      label: string, kind: { type: 'string', enum: ['x', 'url', 'arena'] },
      state: { type: 'string', enum: ['pending', 'running', 'done', 'skipped', 'error'] },
      error: nullableString, itemIds: strings,
    }, ['label', 'kind', 'state', 'error', 'itemIds'])),
  }, ['id', 'status', 'createdAt', 'total', 'done', 'imported', 'skipped', 'failed', 'entries']),
  ApiKey: object({ id: string, name: string, createdAt: timestamp, lastUsedAt: { ...timestamp, nullable: true } },
    ['id', 'name', 'createdAt', 'lastUsedAt']),
  CreatedApiKey: { allOf: [ref('ApiKey'), object({ token: { ...string, description: 'Shown only once; save it now.' } }, ['token'])] },
  ApiKeyCreate: object({ name: { type: 'string', minLength: 1, maxLength: 100, example: 'My script' } }, ['name']),
  ActiveProvider: object({ id: string, name: string, sites: strings }, ['id', 'name', 'sites']),
  ServiceSettings: object({
    id: string, name: string, description: string, docsUrl: string, enabled: boolean,
    fields: array(object({
      key: string, label: string, type: { type: 'string', enum: ['url', 'text', 'secret', 'select'] },
      required: boolean, placeholder: string, hint: string, group: string,
      options: array(object({ value: string, label: string })),
    })),
    values: { type: 'object', additionalProperties: { oneOf: [string, boolean] }, description: 'Secret values are returned as booleans indicating whether they are set.' },
  }),
  ServicePatch: object({ enabled: boolean, values: { type: 'object', additionalProperties: string } }),
  ServiceTestRequest: object({ values: { type: 'object', additionalProperties: string } }),
  ServiceTest: object({ ok: boolean, message: string, sites: strings, readAsText: boolean }, ['ok', 'message']),
  EmbeddingStatus: object({
    state: { type: 'string', enum: ['off', 'running', 'complete', 'error'] },
    total: integer, done: integer, failed: integer, pending: integer, images: integer, texts: integer,
    error: nullableString, lastFailure: nullableString,
  }),
  ItemEmbedding: object({
    state: { type: 'string', enum: ['off', 'pending', 'done', 'failed'] }, model: string,
    parts: array(object({
      kind: { type: 'string', enum: ['image', 'text'] }, state: { type: 'string', enum: ['pending', 'done', 'failed'] },
      dimensions: integer, error: nullableString, at: timestamp,
    })),
  }, ['state', 'parts']),
};
