import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import { createOpenApi } from '../src/openapi.js';
import { PNG, startAbacus, startFixture } from './helpers.js';

let app;
let spec;
const basic = { authorization: 'Basic ' + Buffer.from('abacus:secret').toString('base64') };

before(async () => {
  app = await startAbacus();
  const result = await app.call('GET', '/api/openapi.json', undefined, { as: 'basic' });
  assert.equal(result.status, 200);
  spec = result.data;
});

after(async () => { await app?.stop(); });

describe('OpenAPI specification', () => {
  test('the served specification is valid OpenAPI with resolved references', async () => {
    const validated = await SwaggerParser.validate(structuredClone(spec));
    assert.equal(validated.openapi, '3.0.3');
    assert.equal(validated.info.title, 'Abacus API');
    assert.deepEqual(validated.servers, [{ url: '/', description: 'This Abacus server' }]);
  });

  test('every API route and method has documentation and a unique operation ID', async () => {
    const routes = await fs.readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
    const registered = [...routes.matchAll(/app\.(get|post|patch|delete)\('(\/api\/[^']+)'/g)]
      .map(([, method, path]) => `${method} ${path.replace(/:([\w]+)/g, '{$1}')}`).sort();
    const documented = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method} ${path}`)).sort();
    assert.deepEqual(documented, registered);
    const ids = Object.values(spec.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId));
    assert.equal(new Set(ids).size, ids.length);
  });

  test('only the actual integration routes advertise API-key authentication', () => {
    const keyRoutes = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods).filter(([, op]) => op.security?.some((auth) => 'bearerAuth' in auth || 'apiKey' in auth))
        .map(([method]) => `${method} ${path}`));
    assert.deepEqual(keyRoutes.sort(), [
      'get /api/autocomplete', 'get /api/bootstrap', 'get /api/jobs/{id}', 'post /api/add', 'post /api/v1/add',
    ]);
    assert.deepEqual(spec.security, [{ basicAuth: [] }]);
    assert.deepEqual(spec.paths['/api/health'].get.security, []);
  });

  test('JSON and multipart adds document their distinct requests and responses', () => {
    const add = spec.paths['/api/add'].post;
    assert.ok(add.requestBody.content['application/json'].examples.note);
    assert.equal(add.requestBody.content['multipart/form-data'].schema.$ref, '#/components/schemas/UploadRequest');
    assert.deepEqual(spec.components.schemas.UploadRequest.required, ['file']);
    for (const status of [200, 201, 202, 400, 401, 403, 413, 422, 502]) assert.ok(add.responses[status], status);
    assert.equal(spec.components.schemas.Job.properties.finishedAt.description, 'Unix time in milliseconds.');
  });

  test('optional-login installations document anonymous access accurately', async () => {
    const publicSpec = createOpenApi();
    await SwaggerParser.validate(structuredClone(publicSpec));
    assert.ok(publicSpec.security.some((auth) => Object.keys(auth).length === 0));
    assert.ok(publicSpec.paths['/api/add'].post.security.some((auth) => Object.keys(auth).length === 0));
  });

  test('live bootstrap, note, upload, and import responses conform to their schemas', async () => {
    const document = await SwaggerParser.dereference(structuredClone(spec));
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const conforms = (schema, data) => {
      const validate = ajv.compile(schema);
      assert.ok(validate(data), JSON.stringify(validate.errors));
    };
    for (const as of ['token', 'basic']) {
      const result = await app.call('GET', '/api/bootstrap', undefined, { as });
      assert.equal(result.status, 200);
      conforms(document.components.schemas.Bootstrap, result.data);
    }
    const note = await app.call('POST', '/api/add', { name: 'OpenAPI note', text: 'Schema check' });
    assert.equal(note.status, 201);
    conforms(document.components.schemas.AddResponse, note.data);
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'schema.png');
    const upload = await app.call('POST', '/api/add', form);
    assert.equal(upload.status, 201);
    conforms(document.components.schemas.AddResponse, upload.data);
    const fixture = await startFixture();
    try {
      const imported = await app.call('POST', '/api/add', { url: fixture.url + '/page/OpenAPI', async: true });
      assert.equal(imported.status, 202);
      conforms(document.components.schemas.AddResponse, imported.data);
      const job = await app.waitForJob(imported.data.job.id);
      conforms(document.components.schemas.Job, job);
    } finally {
      await fixture.close();
    }
  });
});

describe('Swagger UI and documentation access', () => {
  test('the UI and all its scripts and styles are served locally', async () => {
    for (const path of ['/api/docs', '/api/docs/']) {
      const res = await fetch(app.baseUrl + path, { headers: basic });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const html = await res.text();
      assert.match(html, /swagger-ui/);
      const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map((match) => match[1]);
      assert.ok(assets.length >= 3);
      for (const asset of assets) {
        const url = new URL(asset, res.url);
        assert.equal(url.origin, app.baseUrl);
        const assetResponse = await fetch(url, { headers: basic });
        assert.equal(assetResponse.status, 200, url.pathname);
        assert.match(assetResponse.headers.get('content-type'), /javascript|text\/css/);
      }
    }
  });

  test('Swagger JSON and YAML expose the same API as the canonical URL', async () => {
    const json = await app.call('GET', '/api/docs/json', undefined, { as: 'basic' });
    assert.equal(json.status, 200);
    assert.deepEqual(json.data, spec);
    const yaml = await fetch(app.baseUrl + '/api/docs/yaml', { headers: basic });
    assert.equal(yaml.status, 200);
    assert.match(yaml.headers.get('content-type'), /yaml/);
    assert.match(await yaml.text(), /openapi: 3\.0\.3/);
  });

  test('Swagger does not persist credentials or use an external validator', async () => {
    const res = await fetch(app.baseUrl + '/api/docs/static/swagger-initializer.js', { headers: basic });
    const script = await res.text();
    assert.match(script, /persistAuthorization["']?\s*:\s*false/);
    assert.match(script, /validatorUrl:\s*null/);
  });

  test('documentation and assets require the web login when configured', async () => {
    for (const path of ['/api/openapi.json', '/api/docs/', '/api/docs/json', '/api/docs/yaml', '/api/docs/static/swagger-ui.css']) {
      const anonymous = await app.call('GET', path, undefined, { as: 'none' });
      assert.equal(anonymous.status, 401, path);
      assert.match(anonymous.headers.get('www-authenticate'), /Basic/);
      assert.equal((await app.call('GET', path)).status, 403, path);
      const invalid = await app.call('GET', path, undefined, { as: 'none', headers: { authorization: 'Bearer wrong' } });
      assert.equal(invalid.status, 401, path);
    }
  });

  test('documentation works without a web build or a configured login', async () => {
    const publicApp = await startAbacus({ AUTH_PASSWORD: '' });
    try {
      const doc = await publicApp.call('GET', '/api/openapi.json', undefined, { as: 'none' });
      assert.equal(doc.status, 200);
      assert.ok(doc.data.security.some((auth) => Object.keys(auth).length === 0));
      const ui = await fetch(publicApp.baseUrl + '/api/docs/');
      assert.equal(ui.status, 200);
      assert.match(await ui.text(), /swagger-ui/);
      assert.equal((await publicApp.call('GET', '/api/openapi.json')).status, 403);
    } finally {
      await publicApp.stop();
    }
  });
});
