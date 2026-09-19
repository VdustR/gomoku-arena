/// <reference types="svelte" />
/**
 * Ambient declarations for what the bundler resolves and TypeScript does not.
 *
 * Normally these come from `vite/client`, but Vite is bundled inside Vite+
 * rather than declared as a dependency, so there is no package to reference.
 * Only what this project actually imports is declared.
 */

/** A stylesheet imported for its side effect, which is being in the bundle. */
declare module '*.css' {
  const url: string
  export default url
}
