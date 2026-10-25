/** Thrown by a provider's import() when it doesn't handle a link, so the next provider (or the web importer) gets it. */
export class ProviderUnsupported extends Error {}
