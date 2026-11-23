/** True in `node build.mjs --dev`, false in the production build. */
declare const __DEV__: boolean;

/** A tag of the film's content, for its address. */
declare const __FILM__: string;

/** CSS is bundled by esbuild (side-effect imports only). */
declare module "*.css";
