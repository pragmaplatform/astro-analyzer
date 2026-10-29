# Writing rules

astro-analyzer is built for project-specific rules: the conventions, boundaries and footguns of your codebase that a generic linter can't know about. A rule is an object with `meta` and a `check` function that returns findings. Every rule runs against the same analyzed project, so the expensive parts (building the TypeScript program, compiling `.astro` files, finding islands and actions) happen once per run, and a new rule costs little on top of the ones already running.

What a rule can see:

- **Types everywhere**, through the TypeScript checker: the type of any expression in `.astro` frontmatter, templates, `.ts` and `.tsx` files, and what it resolves to across imports.
- **Astro structure**, already found: every hydrated island with its component, directive and each prop's passed and declared types, and every action with its name and resolved result.
- **Serialized shapes**: utilities that walk what a value actually turns into on the wire, through nested objects, arrays, `Map`s and `Set`s.

The engine handles everything else for you: severities and options from config, per-path overrides, `ignore` globs, inline ignore comments, config exceptions, unused-exception warnings, and reporting with suggested fixes.

```js
// astro-analyzer.config.mjs
import { defineConfig, defineRule, findIslands } from "astro-analyzer"

const noClientLoad = defineRule({
  meta: {
    name: "no-client-load",
    description: "Prefer client:visible or client:idle over client:load",
    hint: "Hydrate on visibility or idle unless the island is needed immediately.",
    defaultSeverity: "warn",
    target: ["component"],
  },
  check: ({ project }) =>
    findIslands(project)
      .filter((island) => island.directive === "client:load")
      .map((island) => ({
        location: island.location,
        target: { component: island.component },
        message: `<${island.component}> hydrates on load`,
      })),
})

export default defineConfig({
  plugins: [{ name: "acme", rules: [noClientLoad] }],
  rules: { "acme/no-client-load": "warn" },
})
```

## `meta`

| Field             | Description                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Rule name; the full id is `<plugin>/<name>`                                                                                                                                            |
| `description`     | One line, shown by `astro-analyzer rules`                                                                                                                                              |
| `defaultSeverity` | Severity when config doesn't set one                                                                                                                                                   |
| `target`          | Fields of a finding's `target` that identify it within a file. Config exceptions match on them, so pick names that survive edits, like a component or action name, never a line number |
| `hint`            | What to do about a finding, printed once when the rule fails                                                                                                                           |
| `docs`            | Link to the rule's documentation                                                                                                                                                       |

## Options

`parseOptions(raw)` receives the object from `[severity, options]` in config and returns the options `check` gets. Throw an `Error` to reject bad input; `assertKnownOptions`, `stringArrayOption` and `booleanOption` help. `configWarnings(options)` can return notes for a rule that is enabled but configured so it can't find anything.

## Findings

`check({ project, options })` returns findings: `{ location, target, message }`. `location` is `{ file, line, column }` with a project-root-relative POSIX path and 1-based positions; get it from `project.locate(sourceFile, node)`, which maps positions in compiled `.astro` files back to the `.astro` source, or reuse an island's or action's `location`. The engine applies severities, overrides, `ignore`, ignore comments and config exceptions, so rules only report. Target fields not listed in `meta.target` are dropped, so exceptions can always match what's reported. `project.warnings` lists setup problems (a missing `srcDir`, an unresolvable `astro` package) that the engine reports as config warnings.

## The shared project

`project` has:

- `program` and `checker`: one TypeScript program over the project's tsconfig, with every `.astro` file under `srcDir` compiled to TSX
- `astroFiles`: each `.astro` file's path, source, compiled `tsx` source file and source map
- `sourceFiles`: the project's own TS, TSX and compiled `.astro` files, without declarations or `node_modules`
- `astroFileFor(sourceFile)`, `locate(sourceFile, node)` and `rel(path)`

Higher-level helpers, computed once per run and shared between rules:

- `findElements(project)`: every JSX element (`AstroElement`) in `.astro` templates and `.tsx`/`.jsx` files, including `server:defer` islands and plain HTML elements, with its attributes by name (directives such as `server:defer` and `set:html` included), spreads, location, and for components, where the import leads: the module specifier, the imported name, the declaring file and, for `.astro` components, the compiled `AstroFile`. `attributeExpression(attr)` reads an attribute's value.

- `findIslands(project)`: every `client:*` island, with its component, directive, location, and each prop's passed (`actual`) and declared types. `server:defer` islands are skipped.
- `findActions(project)`: every `defineAction({ handler })` imported from `astro:actions`, anywhere in the project, with the path it's called by (`user.update`), its location and its resolved return type.

Type utilities for walking what gets serialized:

- `findNamedTypes(checker, type, match)`: every type in a value's shape that `match` names, with the property path where it appears
- `findExcessProperties(checker, actual, expected)`: fields `actual` carries that `expected` doesn't declare, recursively
- `containerParts(checker, type)`: the serialized contents of an array, tuple, `Map` or `Set`
- `dataProperties`, `elementType`, `nonNullishMembers`, `isNullish`, `isObjectType`, `isUntyped`, `isCallable`, `isOpaque`, `declarationFile`

For tooling around the engine: `analyze` runs a whole analysis and returns diagnostics; `formatPretty`, `formatJson` and `formatExceptions` render results; `ignoreComment(diagnostic)` and `toException(diagnostic, reason)` build the ignore comment and config exception that would cover a finding; `resolveConfig` validates a config object.

## Rules for your codebase only

Rules about your own conventions (an auth helper every admin island must call, a component that must always get a prop) belong in your repo, not in a package. Put them in a folder such as `lint/`, export a plugin, and register it from `astro-analyzer.config.ts`. On Node 22.18 or later the config and the rule files are TypeScript, loaded without a build step; import them with their `.ts` extension and use `import type` for type-only imports. Your project's `astro check` or `tsc` then type-checks the rules with the rest of the code.

## Sharing rules

A plugin is a plain `{ name, rules }` object, so a set of rules can live in a file next to your config, or in its own npm package that exports the plugin:

```js
// astro-analyzer.config.mjs
import { defineConfig } from "astro-analyzer"
import acme from "@acme/astro-analyzer-rules"

export default defineConfig({
  plugins: [acme],
  rules: { "acme/no-client-load": "warn" },
})
```

Depend on `astro-analyzer` as a peer dependency in a shared plugin package, so the rules use the same copy as the project running them.

## Contributing a built-in rule

Built-in rules live in `src/rules/`, are registered in `src/rules/index.ts` under the `astro` plugin, and get a doc in `docs/rules/` and a row in the README's rule table. Cover them with a case in the fixture project under `test/fixtures/`.
