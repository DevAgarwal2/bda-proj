/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly MONGO_URI?: string;
  readonly MONGO_DB?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
