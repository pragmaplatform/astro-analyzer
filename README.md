# astro-analyzer

[![CI](https://github.com/pragmaplatform/astro-analyzer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pragmaplatform/astro-analyzer/actions/workflows/ci.yml)
[![Release](https://github.com/pragmaplatform/astro-analyzer/actions/workflows/release.yml/badge.svg)](https://github.com/pragmaplatform/astro-analyzer/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/astro-analyzer)](https://www.npmjs.com/package/astro-analyzer)

Type-aware linting for [Astro](https://astro.build) projects.

Syntactic linters see an Astro project as text, and `astro check` sees its types but only reports type errors. Many of the rules worth enforcing in an Astro codebase need both: what type a value passed to an island really has, what an action's handler returns, which component a tag resolves to and what props it declares. astro-analyzer builds one TypeScript program over your whole project, with every `.astro` file compiled to TSX the way `astro check` does, and runs rules against it with full access to the type checker.

You get:

- **A typed view of your Astro project**, shared by every rule: the program and checker with `.astro` files included, positions mapped back to the `.astro` source, and Astro concepts already found for you, such as every hydrated island with its props' passed and declared types, and every action with its resolved result.
- **Linter workflow**: a config file with severities, rule options and per-path overrides, inline `astro-analyzer-ignore-next-line` comments, config exceptions with required reasons, warnings when an exception outlives its code, and pretty or JSON output for CI.
- **Built-in rules** for problems that need type information to catch: server data leaking into the browser through island props and action results, and unsanitized HTML injected into the page.
- **Your own rules**, written in a few lines against the same shared analysis. Keep project-specific ones in your own repo, in TypeScript, or share them as plugins.

```
src/pages/orders/[id].astro
  42:5     error  <OrderSummary> prop "order" is typed with Order; every field is serialized into the page  astro/no-server-objects
  57:5     error  <CustomerBadge> prop "customer" passes undeclared fields (email, notes); they are still serialized into the page  astro/no-excess-island-props

src/actions/account.ts
  12:25    error  Action "updateProfile" returns User; every field is sent to the browser  astro/no-server-objects

✖ 3 problems (3 errors, 0 warnings) in 4.2s
```

## Install

```sh
pnpm add -D astro-analyzer
```

`typescript` (5.4 or later, below 7) is a peer dependency; the project's own copy is used.

## Usage

```sh
astro-analyzer                     # analyze the current directory
astro-analyzer path/to/project     # or another root
astro-analyzer --format json       # machine-readable output
astro-analyzer --quiet             # errors only
astro-analyzer --max-warnings 0    # fail on warnings too
astro-analyzer rules               # list rules and their severities
```

Exit codes: `0` clean, `1` errors (or more warnings than `--max-warnings`; `--quiet` ignores warnings), `2` the run couldn't complete (bad usage or config, a missing tsconfig, or a rule that threw).

Run it next to `astro check`, for example `"check": "astro check && astro-analyzer"` in `package.json`. When a run fails, it prints how to resolve each finding, including the exact ignore comment and config exception that would cover it.

## Built-in rules

| Rule                                                                   | Default | Finds                                                                                          |
| ---------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| [`astro/no-server-objects`](docs/rules/no-server-objects.md)           | error   | Island props and action results typed with server-only types (needs `serverTypes`)             |
| [`astro/no-excess-island-props`](docs/rules/no-excess-island-props.md) | error   | Values passed to an island that carry fields the component's props don't declare               |
| [`astro/no-unsanitized-html`](docs/rules/no-unsanitized-html.md)       | error   | `set:html`, `innerHTML` and `dangerouslySetInnerHTML` values that aren't constant or sanitized |

The first two guard the same boundary. Astro serializes every prop of a `client:*` island into the page HTML and sends every action result to the browser, field by field, whatever the component reads or its prop types declare. Passing a whole server object ships all of it, including fields the viewer should never see, and TypeScript doesn't object: it only rejects extra fields on object literals, not on variables. `no-unsanitized-html` follows values back through `const` declarations, imports and your configured sanitizers to tell constant or sanitized markup from anything else.

Two meta rules report problems with exceptions themselves: `astro-analyzer/invalid-ignore` (error) for ignore comments with an unknown rule or no reason, and `astro-analyzer/unused-exception` (warning) for exceptions that no longer match anything.

## Configuration

astro-analyzer reads `astro-analyzer.config.mjs`, `.js`, `.ts` or `.mts` from the project root, or the file passed with `--config`. TypeScript config files, and the local rule files they import, load natively on Node 22.18 or later; import local TypeScript files with their `.ts` extension.

```js
// astro-analyzer.config.mjs
import { defineConfig } from "astro-analyzer"
import { myRules } from "./lint/astro-rules.mjs"

export default defineConfig({
  rules: {
    "astro/no-server-objects": [
      "error",
      {
        // Files that declare server-only types: your database models, a generated API client, ...
        serverTypes: ["src/server/**"],
        // Types from those files that are plain values and safe to send.
        allowTypes: ["DateRange"],
      },
    ],
    "astro/no-excess-island-props": "error",
    "acme/no-client-load": "warn",
  },

  // Your own rules; see "Writing rules" below.
  plugins: [{ name: "acme", rules: myRules }],

  // Change severities for some files. Later overrides win.
  overrides: [
    {
      files: ["src/pages/experiments/**"],
      rules: { "astro/no-excess-island-props": "warn" },
    },
  ],

  // Findings in these files are dropped entirely.
  ignore: ["src/pages/playground/**"],

  // Exceptions for specific findings; see below.
  exceptions: [],
})
```

| Option                   | Default         | Description                                                                    |
| ------------------------ | --------------- | ------------------------------------------------------------------------------ |
| `rules`                  | rule defaults   | Severity (`"error"`, `"warn"`, `"off"`) or `[severity, options]` per rule id   |
| `plugins`                | `[]`            | `{ name, rules }`: extra rules, with ids `<name>/<rule>`                       |
| `overrides`              | `[]`            | `{ files, rules }`: severities for files matching the globs                    |
| `ignore`                 | `[]`            | Globs of files whose findings are dropped                                      |
| `exceptions`             | `[]`            | Exceptions for specific findings                                               |
| `tsconfig`               | `tsconfig.json` | The project's tsconfig                                                         |
| `srcDir`                 | `src`           | Astro's `srcDir`; `.astro` files are found under it                            |
| `requireIgnoreReason`    | `true`          | Ignore comments must end in `-- reason`                                        |
| `reportUnusedExceptions` | `true`          | Warn about ignore comments and config exceptions that no longer match anything |

Every key, rule id and option is validated: a typo is an error, never a rule silently turned off.

## Exceptions

Fix the finding first; each rule's documentation says how. When a finding is intentional, record why, in one of two ways.

**Inline**, on the line above the finding, in whatever comment syntax that spot allows (`<!-- -->` in a template, `{/* */}` among JSX children inside an expression, `//` in code):

```astro
<!-- astro-analyzer-ignore-next-line astro/no-server-objects -- the signed-in user's own settings -->
<SettingsForm settings={settings} client:load />
```

```ts
export const server = {
  // astro-analyzer-ignore-next-line astro/no-server-objects -- returns the caller's own record
  getOwnUser: defineAction({ handler: async (_, ctx) => getCurrentUser(ctx) }),
}
```

List several rules separated by commas, or none to cover every rule. Everything after `--` is the reason, which is required unless `requireIgnoreReason` is `false`. Findings on an element are reported on the line where the element starts, so the comment goes directly above it.

**In config**, when a comment doesn't fit or you want exceptions reviewed in one place:

```js
exceptions: [
  {
    rule: "astro/no-server-objects",
    file: "src/pages/settings.astro",
    component: "SettingsForm",
    prop: "settings",
    reason: "the signed-in user's own settings",
  },
]
```

`rule`, `file` (an exact path relative to the project root, with `/` separators) and `reason` are required. The other fields are the rule's targets, which each rule declares and documents (`component` and `prop` for island rules, `action` for action rules, `element` and `value` for `no-unsanitized-html`); each one you give narrows the exception, and leaving them all out covers the rule for the whole file.

Ignore comments and exceptions that stop matching are reported as `astro-analyzer/unused-exception` warnings, so they don't outlive the code they excused. To adopt the tool on a project with existing findings, `astro-analyzer --print-exceptions --reason "Existed before astro-analyzer was adopted"` prints config entries for every current finding.

## Writing rules

A rule is `meta` plus a `check` function that returns findings. It receives the shared, already-analyzed project, so it only has to express the check itself:

```js
// lint/astro-rules.mjs
import { defineRule, findIslands } from "astro-analyzer"

const noClientLoad = defineRule({
  meta: {
    name: "no-client-load",
    description: "Prefer client:visible or client:idle over client:load",
    hint: "hydrate on visibility or idle unless the island is needed immediately.",
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

export const myRules = [noClientLoad]
```

Severities, overrides, `ignore`, ignore comments and exceptions all apply to your rules without extra code. Rules can use the TypeScript checker directly, the element, island and action helpers, and type utilities for walking what a value serializes to. See [docs/writing-rules.md](docs/writing-rules.md).

### Project-specific rules

Rules that only make sense for your codebase (your auth helpers, your component conventions) don't need to be published anywhere. Keep them in your repo and register them from your config:

```ts
// astro-analyzer.config.ts
import { defineConfig } from "astro-analyzer"
import { acmeRules } from "./lint/index.ts"

export default defineConfig({
  plugins: [acmeRules], // { name: "acme", rules: [...] }
  rules: { "acme/admin-island-auth": "error" },
})
```

They run against the same shared analysis as the built-in rules, are type-checked with the rest of your project, and the package itself never sees them.

## Programmatic API

```ts
import { analyze, formatPretty } from "astro-analyzer"

const result = await analyze({ cwd: "path/to/project" })
console.log(formatPretty(result))
process.exitCode = result.errorCount > 0 ? 1 : 0
```

`analyze` also accepts a `config` object instead of reading the config file.

## How it works

1. Reads the project's tsconfig and compiles every `.astro` file under `srcDir` to TSX with `@astrojs/compiler`, the compiler `astro check` uses.
2. Builds one TypeScript program over the project's own files and the compiled `.astro` files, with Astro's types resolved from the project's `astro` install.
3. Finds elements, islands and actions once, on first use, and shares them between rules.
4. Runs every enabled rule, then applies severities, overrides, `ignore`, ignore comments and exceptions, mapping positions in compiled `.astro` files back to the `.astro` source through source maps.

The full program is built once per run, so a run takes about as long as `astro check`, however many rules are enabled.

## Limitations

- Only `.astro` files under `srcDir` are analyzed; `.mdx` files are not.
- A component's props come from its first call signature, which covers React, Preact and Solid function components. Svelte and Vue components (whose types need their own language tooling) and class components have no declared props, so rules see what is passed to them but not what they accept.
- Actions are found as `defineAction` calls imported from `astro:actions`, anywhere in the project, and named by the path they are called with (`user.update`).
- `server:defer` islands are left out of `findIslands`, because Astro encrypts their props.
- Rules see what the type checker sees: a value typed `any` hides its shape, and a server object copied with `{ ...object }` into an anonymous type loses its name. See each rule's documentation for how it handles these.

## Acknowledgements

The config file, ignore-comment and `astro/` rule-id conventions follow [astro-doctor](https://github.com/aryanranderiya/astro-doctor), a syntactic analyzer for Astro projects that pairs well with this one.

## License

[MIT](LICENSE)
