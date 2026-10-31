/**
 * Find the best (highest-resolution) URL of an image on a page.
 *
 * A classic script, not a module: the content script cannot import, so it loads this file first (both are listed
 * together in `files` / `registerContentScripts`) and finds the API on `globalThis.__abacusHd`. The URL logic is
 * DOM-free so Node tests can import it; `describe(element)` is the only part that needs a page.
 *
 * Every function returns candidates best-first. The server tries them in order (`url`, then `fallbackUrls`), so a
 * wrong guess costs one failed download, never a lost image.
 */
(() => {
  const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?|svg|heic)$/i;
  const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v|ogv)$/i;
  // Attributes lazy-loaders and zoom plugins use for the full-size file, best first.
  const FULL_SIZE_ATTRS = [
    'data-orig-file', 'data-full-url', 'data-full-src', 'data-full', 'data-original', 'data-original-src',
    'data-zoom-src', 'data-zoom-image', 'data-hi-res-src', 'data-hires', 'data-large-file', 'data-large',
    'data-image-large', 'data-src-large',
  ];
  // Attributes that hold the displayed image of a lazy-loaded <img>.
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-image', 'data-url'];

  const isHttp = (value) => /^https?:\/\//i.test(value || '');
  const pathnameOf = (value) => {
    try {
      return new URL(value).pathname;
    } catch {
      return '';
    }
  };
  const looksLikeImage = (value) => IMAGE_EXT.test(pathnameOf(value));
  const looksLikeVideo = (value) => VIDEO_EXT.test(pathnameOf(value));

  function absolute(value, base) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw, base || undefined).href;
    } catch {
      return '';
    }
  }

  /** Parse a `srcset` the way browsers do: URLs may contain commas, descriptors are w/x. */
  function parseSrcset(value, base) {
    const text = String(value || '');
    const out = [];
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i >= text.length) break;
      let start = i;
      while (i < text.length && !/\s/.test(text[i])) i++;
      let url = text.slice(start, i);
      let descriptor = '';
      if (/,+$/.test(url)) {
        url = url.replace(/,+$/, '');
      } else {
        start = i;
        let depth = 0;
        while (i < text.length && !(text[i] === ',' && depth === 0)) {
          if (text[i] === '(') depth++;
          if (text[i] === ')') depth = Math.max(0, depth - 1);
          i++;
        }
        descriptor = text.slice(start, i).trim();
      }
      const href = absolute(url, base);
      if (!href) continue;
      const w = /(\d+(?:\.\d+)?)w\b/.exec(descriptor);
      const x = /(\d+(?:\.\d+)?)x\b/.exec(descriptor);
      out.push({ url: href, w: w ? Number(w[1]) : 0, x: x ? Number(x[1]) : 1 });
    }
    return out;
  }

  /** The largest entry of a srcset, or '' when it has none. */
  function largestSource(value, base) {
    const entries = parseSrcset(value, base);
    if (!entries.length) return '';
    return entries.reduce((best, entry) => (entry.w > best.w || (entry.w === best.w && entry.x > best.x) ? entry : best)).url;
  }

  const setParams = (url, mutate) => {
    try {
      const next = new URL(url);
      mutate(next.searchParams, next);
      const href = next.href;
      return href === url ? null : href;
    } catch {
      return null;
    }
  };

  /**
   * Known CDNs encode a thumbnail size in the URL; return the same image at full size. Each rule is a guess that
   * is only ever used before the displayed URL, which stays as the fallback.
   */
  const RULES = [
    // X / Twitter: ...?format=jpg&name=small  ->  name=orig  (and the old ".jpg:small" form)
    (url) => {
      if (!/^https?:\/\/pbs\.twimg\.com\/media\//i.test(url)) return null;
      const legacy = url.replace(/:(?:thumb|small|medium|large|\d+x\d+)$/i, ':orig');
      if (legacy !== url) return legacy;
      return setParams(url, (params) => params.set('name', 'orig'));
    },
    // Pinterest: /236x/, /474x/, /564x/, /736x/ -> /originals/
    (url) => (/^https?:\/\/i\.pinimg\.com\//i.test(url) ? url.replace(/\/(?:\d+x(?:\d+)?|\d+x\d+_RS)\//, '/originals/') : null),
    // Wikimedia: /thumb/a/ab/File.jpg/300px-File.jpg -> /a/ab/File.jpg
    (url) => {
      const match = /^(https?:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+)\/thumb\/(.+?)\/[^/]+$/i.exec(url);
      return match ? `${match[1]}/${match[2]}` : null;
    },
    // Unsplash (imgix): drop the sizing parameters to get the original
    (url) => {
      if (!/^https?:\/\/(?:images|plus)\.unsplash\.com\//i.test(url)) return null;
      return setParams(url, (params) => {
        for (const key of ['w', 'h', 'q', 'fit', 'crop', 'dpr', 'fm', 'auto', 'cs']) params.delete(key);
      });
    },
    // Google user content: =s220, =w800-h600-no  ->  =s0 (original size)
    (url) => (/^https?:\/\/[^/]*\.googleusercontent\.com\//i.test(url) ? url.replace(/=(?:[swh]\d+)(?:-[a-z0-9]+)*$/i, '=s0') : null),
    // Shopify: product_300x300.jpg, product_grande.jpg -> product.jpg
    (url) => {
      if (!/\/\/[^/]*(?:cdn\.shopify\.com|shopifycdn)/i.test(url) && !/\/cdn\/shop\//i.test(url)) return null;
      return url.replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|original|\d+x\d*|x\d+)(?=\.[a-z]+(?:\?|$))/i, '');
    },
    // Cloudinary: /upload/w_300,c_fill/v123/... -> /upload/v123/...
    (url) => (/^https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//i.test(url)
      ? url.replace(/(\/image\/upload\/)(?:[a-z]{1,3}_[^/]+\/)+(?=v\d+\/|[^/]+\/)/i, '$1')
      : null),
    // Imgur thumbnails: ABCDEFGm.jpg (s b t m l h suffix on an 8-character id)
    (url) => (/^https?:\/\/i\.imgur\.com\/[A-Za-z0-9]{7}[sbtmlh]\.[a-z]+/i.test(url) ? url.replace(/^(https?:\/\/i\.imgur\.com\/[A-Za-z0-9]{7})[sbtmlh](\.)/i, '$1$2') : null),
    // WordPress and many CMSs: photo-300x200.jpg -> photo.jpg
    (url) => {
      const next = url.replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif|avif)(?:\?|$))/i, '');
      return next === url ? null : next;
    },
  ];

  /** Full-size guesses for one URL, best first. Never includes the URL itself. */
  function upgradeUrl(url) {
    const out = [];
    for (const rule of RULES) {
      const next = rule(url);
      if (next && next !== url && isHttp(next) && !out.includes(next)) out.push(next);
    }
    return out;
  }

  const unique = (list) => [...new Set(list.filter(Boolean))];

  /**
   * Candidate URLs for one image, best first.
   *
   * info: { src, currentSrc, srcset, sources: [{ srcset }], attrs: { 'data-src': … }, link, base }
   * `link` is the href of an enclosing <a>; it only counts when it points at an image file.
   */
  function candidates(info = {}, { hd = true } = {}) {
    const base = info.base || undefined;
    const shown = absolute(info.currentSrc || info.src, base);
    const plain = unique([shown, absolute(info.src, base)]).filter(isHttp);
    if (!hd) return plain.slice(0, 1);

    const attrs = info.attrs || {};
    const full = FULL_SIZE_ATTRS.map((name) => absolute(attrs[name], base)).filter(isHttp);
    const link = absolute(info.link, base);
    const linked = isHttp(link) && looksLikeImage(link) ? [link] : [];
    const sizes = [info.srcset, ...(info.sources || []).map((source) => source.srcset)]
      .map((value) => largestSource(value, base))
      .filter(isHttp);
    const lazy = LAZY_ATTRS.map((name) => absolute(attrs[name], base)).filter(isHttp);

    const sourced = [...full, ...linked, ...sizes, ...lazy];
    // Rewrites only for the sources we trust to be images, so a wrong guess can't turn a page link into a download.
    const rewritten = [...sizes, ...lazy, ...plain, ...full].flatMap((url) => upgradeUrl(url));
    return unique([...full, ...rewritten.slice(0, 1), ...linked, ...sizes, ...rewritten.slice(1), ...lazy, ...plain]).filter(
      (url) => isHttp(url) && (sourced.includes(url) || plain.includes(url) || rewritten.includes(url))
    );
  }

  const cssUrl = (value) => {
    const match = /url\((["']?)(.*?)\1\)/.exec(value || '');
    return match ? match[2] : '';
  };

  /**
   * Describe the media an element shows: { kind, candidates, inline, title }.
   * `inline` is a blob:/data: URL that only the page can read when no http(s) URL exists.
   */
  function describe(element, { hd = true } = {}) {
    const doc = element.ownerDocument;
    const base = doc.baseURI;
    const tag = element.tagName;
    const title = element.getAttribute('alt') || element.getAttribute('title') || '';
    if (tag === 'IMG') {
      const attrs = {};
      for (const name of [...FULL_SIZE_ATTRS, ...LAZY_ATTRS]) {
        const value = element.getAttribute(name);
        if (value) attrs[name] = value;
      }
      const picture = element.closest('picture');
      const sources = picture ? [...picture.querySelectorAll('source')].map((s) => ({ srcset: s.getAttribute('srcset') })) : [];
      const shown = element.currentSrc || element.getAttribute('src') || '';
      const list = candidates(
        {
          src: element.getAttribute('src'),
          currentSrc: element.currentSrc,
          srcset: element.getAttribute('srcset'),
          sources,
          attrs,
          link: element.closest('a')?.href,
          base,
        },
        { hd }
      );
      return { kind: 'image', candidates: list, inline: /^(?:blob|data):/i.test(shown) ? shown : '', title };
    }
    if (tag === 'VIDEO') {
      const src = element.currentSrc || element.getAttribute('src') || element.querySelector('source')?.getAttribute('src') || '';
      const url = absolute(src, base);
      const poster = absolute(element.getAttribute('poster'), base);
      return {
        kind: 'video',
        candidates: isHttp(url) && !/\.(?:m3u8|mpd)(?:$|\?)/i.test(url) ? [url] : [],
        poster: isHttp(poster) ? poster : '',
        inline: '',
        title,
      };
    }
    const background = absolute(cssUrl(doc.defaultView.getComputedStyle(element).backgroundImage), base);
    if (background) {
      return {
        kind: 'image',
        candidates: isHttp(background) ? candidates({ src: background, base }, { hd }) : [],
        inline: /^(?:blob|data):/i.test(background) ? background : '',
        title,
      };
    }
    return null;
  }

  const formatOf = (url) => {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(pathnameOf(url))?.[1]?.toLowerCase();
    if (!ext) return 'other';
    if (ext === 'jpeg' || ext === 'jpg') return 'jpg';
    return ['png', 'gif', 'webp', 'svg', 'avif'].includes(ext) ? ext : 'other';
  };

  /**
   * Every image and video on a page, for batch save: [{ candidates, preview, kind, title, width, height, format }].
   * Sizes come from the file when the browser knows them, else from how big the element is drawn.
   */
  function scan(doc, { hd = true, limit = 4000 } = {}) {
    const found = new Map();
    const add = (element, media) => {
      const key = media?.candidates?.[0];
      if (!key || found.has(key)) return;
      const rect = element.getBoundingClientRect();
      const natural = element.tagName === 'IMG'
        ? [element.naturalWidth, element.naturalHeight]
        : element.tagName === 'VIDEO' ? [element.videoWidth, element.videoHeight] : [0, 0];
      const preview = absolute(element.currentSrc || element.getAttribute?.('src') || media.poster || key, doc.baseURI);
      // When the best candidate is not the file shown, the shown size says nothing about the original's size.
      const upgraded = isHttp(preview) && key !== preview;
      found.set(key, {
        upgraded,
        candidates: media.candidates,
        kind: media.kind,
        title: media.title,
        preview: isHttp(preview) ? preview : key,
        width: upgraded ? 0 : natural[0] || Math.round(rect.width),
        height: upgraded ? 0 : natural[1] || Math.round(rect.height),
        format: media.kind === 'video' ? 'video' : formatOf(key),
      });
    };
    for (const img of doc.images) add(img, describe(img, { hd }));
    for (const video of doc.querySelectorAll('video')) add(video, describe(video, { hd }));
    let checked = 0;
    for (const element of doc.querySelectorAll('*')) {
      if (++checked > limit) break;
      if (element.tagName === 'IMG' || element.tagName === 'VIDEO' || element.tagName === 'HTML' || element.tagName === 'BODY') continue;
      if (!/url\(/.test(doc.defaultView.getComputedStyle(element).backgroundImage)) continue;
      add(element, describe(element, { hd }));
    }
    return [...found.values()];
  }

  globalThis.__abacusHd = { scan, formatOf, parseSrcset, largestSource, upgradeUrl, candidates, describe, looksLikeImage, looksLikeVideo, isHttp };
})();
