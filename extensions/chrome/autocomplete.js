import { apiFetch, folderPaths, parseTagList } from './lib.js';

/** One lazy request per server/credential combination, shared by both fields. */
export function createSuggestionSource(getConfig) {
  let cached;
  return async () => {
    const config = await getConfig();
    if (!config.serverUrl) throw new Error('Configure and save your server first.');
    const key = JSON.stringify([config.serverUrl, config.token, config.username, config.password]);
    if (cached?.key !== key) {
      const entry = { key, promise: apiFetch(config, '/api/autocomplete') };
      cached = entry;
      entry.promise.catch(() => { if (cached === entry) cached = null; });
    }
    const data = await cached.promise;
    return { folders: folderPaths(data.folders), tags: data.tags };
  };
}

export function tagSegment(input) {
  const caret = input.selectionStart ?? input.value.length;
  const start = input.value.slice(0, caret).lastIndexOf(',') + 1;
  const next = input.value.indexOf(',', caret);
  const end = next < 0 ? input.value.length : next;
  return { start, end, query: input.value.slice(start, end).trim() };
}

export function attachAutocomplete(input, kind, source) {
  const wrapper = document.createElement('div');
  wrapper.className = 'autocomplete';
  input.before(wrapper);
  wrapper.append(input);
  const list = document.createElement('ul');
  list.id = `${input.id}-suggestions`;
  list.className = 'autocomplete-list';
  list.role = 'listbox';
  list.hidden = true;
  wrapper.append(list);
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  let opened = false;
  let selecting = false;
  let version = 0;
  let values = [];
  let matches = [];
  let active = -1;

  function close() {
    opened = false;
    version++;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function message(text) {
    list.replaceChildren();
    const item = document.createElement('li');
    item.className = 'autocomplete-message';
    item.role = 'presentation';
    item.textContent = text;
    list.append(item);
    matches = [];
    active = -1;
    input.removeAttribute('aria-activedescendant');
  }

  function select(value) {
    if (kind === 'tags') {
      const { start, end } = tagSegment(input);
      const replacement = `${start ? ' ' : ''}${value}${end === input.value.length ? ', ' : ''}`;
      input.value = input.value.slice(0, start) + replacement + input.value.slice(end);
      input.setSelectionRange(start + replacement.length, start + replacement.length);
    } else {
      input.value = value;
    }
    close();
    selecting = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    selecting = false;
  }

  function setActive(index) {
    if (!matches.length) return;
    active = (index + matches.length) % matches.length;
    [...list.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
    input.setAttribute('aria-activedescendant', list.children[active].id);
    list.children[active].scrollIntoView({ block: 'nearest' });
  }

  function render() {
    const segment = kind === 'tags' ? tagSegment(input) : null;
    const query = (segment?.query ?? input.value.trim()).toLocaleLowerCase();
    const others = segment ? parseTagList(input.value.slice(0, segment.start) + input.value.slice(segment.end)) : [];
    const used = new Set(others.map((tag) => tag.toLocaleLowerCase()));
    matches = values.filter((value) => value.toLocaleLowerCase().includes(query) && !used.has(value.toLocaleLowerCase())).slice(0, 50);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    if (!matches.length) return message('No matches. Type a new value to create one.');
    list.replaceChildren();
    matches.forEach((value, index) => {
      const option = document.createElement('li');
      option.id = `${input.id}-suggestion-${index}`;
      option.role = 'option';
      option.textContent = value;
      option.setAttribute('aria-selected', 'false');
      option.addEventListener('click', (event) => { event.preventDefault(); select(value); });
      list.append(option);
    });
  }

  async function open() {
    opened = true;
    const request = ++version;
    values = [];
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    message('Loading suggestions…');
    try {
      const data = await source();
      if (!opened || version !== request) return;
      values = data[kind];
      render();
    } catch {
      if (opened && version === request) message('Suggestions unavailable. Keep typing, or reopen to retry.');
    }
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', () => { if (!opened) open(); else if (values.length) render(); });
  input.addEventListener('input', () => { if (!selecting) open(); });
  input.addEventListener('blur', close);
  input.addEventListener('keyup', (event) => {
    if (opened && values.length && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) render();
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape' && opened) { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') close();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!opened) await open();
      setActive(event.key === 'ArrowDown' ? active + 1 : active < 0 ? matches.length - 1 : active - 1);
    }
    if (event.key === 'Enter' && opened && active >= 0) {
      event.preventDefault();
      select(matches[active]);
    }
  });
}
