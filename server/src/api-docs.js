import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { createOpenApi } from './openapi.js';

export async function apiDocs(app) {
  await app.register(fastifySwagger, {
    mode: 'static',
    specification: { document: createOpenApi({ authRequired: !!config.authPassword }) },
  });
  app.get('/api/openapi.json', async () => app.swagger());
  await app.register(fastifySwaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: {
      deepLinking: true,
      docExpansion: 'list',
      persistAuthorization: false,
    },
  });
}
