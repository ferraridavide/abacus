import { attachAutocomplete, createSuggestionSource } from './autocomplete.js';
import { getConfig, normalizeServerUrl } from './lib.js';

const field = (id) => document.getElementById(id);
const source = createSuggestionSource(() => {
  if (!field('serverUrl')) return getConfig();
  return {
    serverUrl: normalizeServerUrl(field('serverUrl').value),
    token: field('token').value.trim(),
    username: field('username').value.trim(),
    password: field('password').value,
  };
});

attachAutocomplete(field('folder'), 'folders', source);
attachAutocomplete(field('tags'), 'tags', source);
