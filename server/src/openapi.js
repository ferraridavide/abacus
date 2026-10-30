import { array, object, ref, schemas } from './openapi-schemas.js';

const json = (schema) => ({ 'application/json': { schema } });
const response = (description, schema) => ({ description, content: json(schema) });
const error = (description) => response(description, ref('Error'));
const body = (name) => ({ required: true, content: json(ref(name)) });
const uploadBody = { required: true, content: { 'multipart/form-data': { schema: ref('UploadRequest') } } };
const idParameter = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const query = (name, schema, description) => ({ name, in: 'query', schema, description });
const string = { type: 'string' };
const enumeration = (...values) => ({ type: 'string', enum: values });

const itemParameters = [
  query('view', enumeration('all', 'uncategorized', 'untagged', 'trash', 'folder', 'tag'), 'Library view; defaults to all.'),
  query('folderId', string, 'Folder ID when view=folder.'),
  query('tag', string, 'Tag when view=tag.'),
  query('q', string, 'Text search; also uses semantic search when configured.'),
  query('types', string, 'Comma-separated item types: image,gif,video,bookmark,file.'),
  query('source', enumeration('api', 'web', 'upload', 'x', 'social', 'arena'), 'Filter by source.'),
  query('rating', { type: 'integer', minimum: 0, maximum: 5 }, 'Minimum star rating.'),
  query('sort', enumeration('created', 'posted', 'name', 'size', 'dimensions', 'rating', 'random', 'updated'), 'Sort order; defaults to created.'),
  query('dir', enumeration('asc', 'desc'), 'Sort direction; defaults to desc.'),
  query('seed', { type: 'integer' }, 'Seed for random ordering.'),
  query('color', string, 'Pixel color search, e.g. #1e88e5 or rgb(30, 136, 229).'),
];

/** Build documentation without attaching validation or serializers to the existing API routes. */
export function createOpenApi({ authRequired = false } = {}) {
  const login = authRequired ? [{ basicAuth: [] }] : [{ basicAuth: [] }, {}];
  const integration = [{ bearerAuth: [] }, { apiKey: [] }, ...login];
  const operation = (operationId, tag, summary, schema, { status = 200, ...options } = {}) => ({
    operationId, tags: [tag], summary,
    ...options,
    responses: {
      [status]: response('Success', schema),
      401: error('Missing or invalid credentials.'),
      403: error('This API key cannot access this operation; use the web login.'),
      ...options.responses,
    },
  });
  const byId = (operationId, tag, summary, schema, options = {}) => operation(operationId, tag, summary, schema, {
    parameters: [idParameter], ...options,
  });
  const addOperation = (operationId, description) => operation(operationId, 'Integration', 'Add links, notes, or a file', ref('AddResponse'), {
    description,
    security: integration,
    parameters: [query('async', { type: 'boolean', default: false }, 'Return immediately for link imports; overrides the JSON async field when true.')],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: ref('AddRequest'),
          examples: {
            link: { summary: 'Import a link', value: { url: 'https://example.com/photo.jpg', folder: 'Inbox', tags: ['inspiration'], async: true } },
            note: { summary: 'Save a note', value: { name: 'Reading list', text: 'Books to buy', tags: ['later'] } },
          },
        },
        ...uploadBody.content,
      },
    },
    responses: {
      200: response('No new items: duplicates were skipped, possibly with failed links.', ref('AddResponse')),
      201: response('One or more items created.', ref('AddResponse')),
      202: response('Import started; poll GET /api/jobs/{id}. Are.na exports always return a job.', ref('AddResponse')),
      400: error('Nothing to add, invalid URL, or unknown parent folder.'),
      413: error('Upload exceeds MAX_DOWNLOAD_MB.'),
      422: error('arena=only was requested but the file is not an Are.na export.'),
      502: response('Every link failed; error and job entries contain the reasons.', ref('AddResponse')),
    },
  });

  return {
    openapi: '3.0.3',
    info: {
      title: 'Abacus API', version: '1.0.0',
      description: 'Manage a self-hosted visual library and add content from extensions or scripts. ' +
        'Create an API key in Settings → Integration and authorize with Bearer authentication or x-api-key. ' +
        'Keys can only add content, follow import jobs, and retrieve folder/tag suggestions. ' +
        'Other operations and this documentation use the web login (HTTP Basic) when AUTH_PASSWORD is set. ' +
        'Without AUTH_PASSWORD, requests without credentials have full access. A supplied key always keeps its restricted permissions. ' +
        'Try it out sends real requests to this library.',
    },
    servers: [{ url: '/', description: 'This Abacus server' }],
    security: login,
    tags: [
      { name: 'Integration', description: 'Operations available to API keys and the web login.' },
      { name: 'Library', description: 'Read and manage items, folders, and tags using the web login.' },
      { name: 'Settings', description: 'Manage API keys, import providers, and semantic search using the web login.' },
      { name: 'Legacy', description: 'Compatibility wrappers; use POST /api/add for new clients.' },
      { name: 'System', description: 'Server health.' },
    ],
    components: {
      securitySchemes: {
        basicAuth: { type: 'http', scheme: 'basic', description: 'AUTH_USER (default abacus) and AUTH_PASSWORD. Full access.' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Named API key from Settings → Integration. Restricted to Integration operations.' },
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Alternative header for the same restricted API key.' },
      },
      schemas,
    },
    paths: {
      '/api/health': { get: {
        operationId: 'health', tags: ['System'], summary: 'Check server health', security: [],
        responses: { 200: response('Server is running.', ref('Ok')) },
      } },
      '/api/add': { post: addOperation('addContent',
        'Import HTTP(S) links, save plain text as a note, or upload one file with an optional video poster. ' +
        'Are.na ZIP exports become folders. Duplicate links are skipped; items contains only newly created items. ' +
        'Send async=true for long imports and poll the returned job.') },
      '/api/v1/add': { post: addOperation('addContentV1', 'Versioned alias of POST /api/add, with identical behavior.') },
      '/api/bootstrap': { get: operation('bootstrap', 'Integration', 'Load folders and library navigation', ref('Bootstrap'), {
        security: integration,
        description: 'With an API key, returns only the folder tree. The web login also returns library statistics, folder counts, and tag counts.',
      }) },
      '/api/autocomplete': { get: operation('autocomplete', 'Integration', 'Suggest folders and tags', ref('Autocomplete'), {
        security: integration,
        description: 'Returns only folder IDs, names, parent IDs, and tag names from non-trashed items. No counts or item metadata.',
        responses: { 200: { ...response('Folder tree and tag names.', ref('Autocomplete')), headers: {
          'Cache-Control': { schema: { type: 'string', enum: ['no-store'] }, description: 'Suggestions must not be cached.' },
        } } },
      }) },
      '/api/jobs/{id}': { get: byId('getJob', 'Integration', 'Follow an import job', ref('Job'), {
        security: integration,
        description: 'Jobs are kept in memory, limited to the most recent 50. A restart or eviction makes a job unavailable.',
        responses: { 404: error('Job not found.') },
      }) },
      '/api/items': { get: operation('listItems', 'Library', 'Search and list items', ref('ItemPage'), {
        parameters: [...itemParameters,
          query('limit', { type: 'integer', minimum: 1, maximum: 1000, default: 200 }, 'Page size, clamped to 1–1000.'),
          query('offset', { type: 'integer', minimum: 0, default: 0 }, 'Number of items to skip.'),
        ],
      }) },
      '/api/items/ids': { get: operation('listItemIds', 'Library', 'List all matching item IDs', object({ ids: array(string) }), {
        parameters: itemParameters,
      }) },
      '/api/items/{id}': {
        get: byId('getItem', 'Library', 'Read an item', ref('Item'), { responses: { 404: error('Item not found.') } }),
        patch: byId('updateItem', 'Library', 'Update an item', ref('Item'), {
          requestBody: body('ItemPatch'), responses: { 404: error('Item not found.') },
        }),
      },
      '/api/items/batch': { post: operation('batchItems', 'Library', 'Update, trash, restore, or delete several items', ref('BatchResult'), {
        requestBody: body('BatchRequest'), responses: { 400: error('Unknown batch action.') },
      }) },
      '/api/trash': { delete: operation('emptyTrash', 'Library', 'Permanently delete all trashed items', ref('BatchResult')) },
      '/api/tags': { get: operation('listTags', 'Library', 'List tags and item counts', array(ref('TagCount'))) },
      '/api/folders': {
        get: operation('listFolders', 'Library', 'List folders and item counts', array(ref('Folder'))),
        post: operation('createFolder', 'Library', 'Create a folder', ref('Folder'), { requestBody: body('FolderCreate') }),
      },
      '/api/folders/{id}': {
        patch: byId('updateFolder', 'Library', 'Update or move a folder', ref('Folder'), {
          requestBody: body('FolderPatch'), responses: { 400: error('Cannot move a folder into itself or its descendants.') },
        }),
        delete: byId('deleteFolder', 'Library', 'Delete a folder', ref('Ok')),
      },
      '/api/import/sources': { get: operation('importSources', 'Library', 'List enabled import providers and supported sites',
        object({ providers: array(ref('ActiveProvider')) })) },
      '/api/settings/api-keys': {
        get: operation('listApiKeys', 'Settings', 'List API key metadata', array(ref('ApiKey'))),
        post: operation('createApiKey', 'Settings', 'Create an API key', ref('CreatedApiKey'), {
          status: 201,
          description: 'The plaintext token is returned only once. Copy it immediately. Responses are not cached.',
          requestBody: body('ApiKeyCreate'), responses: {
            201: response('API key created; save the token now.', ref('CreatedApiKey')),
            400: error('Name must be a non-empty string of at most 100 characters.'),
          },
        }),
      },
      '/api/settings/api-keys/{id}': { delete: byId('revokeApiKey', 'Settings', 'Revoke an API key immediately', ref('Ok'), {
        responses: { 404: error('API key not found.') },
      }) },
      '/api/settings/providers': { get: operation('providerSettings', 'Settings', 'Read import provider settings', array(ref('ServiceSettings'))) },
      '/api/settings/providers/{id}': { patch: byId('updateProvider', 'Settings', 'Update an import provider', ref('ServiceSettings'), {
        requestBody: body('ServicePatch'), responses: { 400: error('Invalid or missing settings.'), 404: error('Unknown provider.') },
      }) },
      '/api/settings/providers/{id}/test': { post: byId('testProvider', 'Settings', 'Test unsaved provider settings', ref('ServiceTest'), {
        requestBody: body('ServiceTestRequest'), responses: { 404: error('Unknown provider.') },
      }) },
      '/api/settings/embeddings': {
        get: operation('embeddingSettings', 'Settings', 'Read semantic search settings', ref('ServiceSettings')),
        patch: operation('updateEmbeddings', 'Settings', 'Update semantic search settings', ref('ServiceSettings'), {
          requestBody: body('ServicePatch'), responses: { 400: error('Invalid or missing settings.') },
        }),
      },
      '/api/settings/embeddings/test': { post: operation('testEmbeddings', 'Settings', 'Test unsaved semantic search settings', ref('ServiceTest'), {
        requestBody: body('ServiceTestRequest'),
      }) },
      '/api/embeddings/status': { get: operation('embeddingStatus', 'Settings', 'Read semantic indexing progress', ref('EmbeddingStatus')) },
      '/api/embeddings/reprocess': { post: operation('reprocessEmbeddings', 'Settings', 'Rebuild all semantic search embeddings', ref('EmbeddingStatus')) },
      '/api/items/{id}/embedding': {
        get: byId('itemEmbedding', 'Library', 'Read an item’s semantic indexing status', ref('ItemEmbedding'), { responses: { 404: error('Item not found.') } }),
        post: byId('reprocessItemEmbedding', 'Library', 'Recompute an item’s semantic search embeddings', ref('ItemEmbedding'), { responses: { 404: error('Item not found.') } }),
      },
      '/api/upload': { post: operation('legacyUpload', 'Legacy', 'Upload a file', ref('Item'), {
        deprecated: true, description: 'Compatibility wrapper. Always stores ZIPs as files, including Are.na exports. Requires the web login.',
        requestBody: uploadBody, responses: { 400: error('Missing file or invalid URL.'), 413: error('File too large.') },
      }) },
      '/api/import': { post: operation('legacyImport', 'Legacy', 'Start a link import', ref('Job'), {
        deprecated: true, description: 'Compatibility wrapper. Always asynchronous and links-only. Requires the web login.',
        requestBody: body('AddRequest'), responses: { 400: error('No links found.') },
      }) },
      '/api/import/arena': { post: operation('legacyArenaImport', 'Legacy', 'Import an Are.na export', ref('Job'), {
        deprecated: true, description: 'Compatibility wrapper. Requires an Are.na ZIP and the web login.',
        requestBody: uploadBody, responses: { 400: error('Missing file.'), 413: error('File too large.'), 422: error('Not an Are.na export.') },
      }) },
    },
  };
}
