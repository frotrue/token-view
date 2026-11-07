/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "play" for the Google Play build of the phone app (no self-update). */
  readonly VITE_DISTRIBUTION?: string;
}
