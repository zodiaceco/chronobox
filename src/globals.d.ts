/** True in `node build.mjs --dev`, false in the production build. */
declare const __DEV__: boolean;
/** package.json version. */
declare const __VERSION__: string;

/** CSS is bundled by esbuild (side-effect imports only). */
declare module "*.css";
