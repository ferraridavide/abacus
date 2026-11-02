interface ImportMetaEnv {
  /** 'true' builds the demo, which keeps the library in the browser instead of on the server */
  readonly VITE_DEMO?: string;
}

/** short git sha of the commit this build was made from (see vite.config.ts) */
declare const __APP_SHA__: string;
