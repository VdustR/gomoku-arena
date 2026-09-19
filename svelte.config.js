/**
 * Svelte's own configuration.
 *
 * `runes: true` states what every component in this project already does.
 * Without it Svelte infers the mode per component, and `svelte-check` read
 * `$state` as a store subscription on a variable called `state` — ninety-nine
 * errors that were all the same misreading. The build also stops warning that
 * no config was found.
 */
export default {
  compilerOptions: { runes: true },
}
