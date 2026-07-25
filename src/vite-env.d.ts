/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When set, the invite page shows an “Install the app” prompt with a download link. */
  readonly VITE_IPA_DOWNLOAD_URL?: string
  /** Optional display name override. */
  readonly VITE_APP_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
