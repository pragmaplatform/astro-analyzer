# astro-analyzer: agent guide

Type-aware linting for Astro projects, published to npm as `astro-analyzer`: a rule engine that runs rules against one shared TypeScript program over the project (`.astro` files included), plus built-in rules for server data leaking into islands and actions and for unsanitized HTML. Read `README.md` for what it does and `docs/writing-rules.md` for how rules are built.

## Layout

- `src/project.ts`: builds the shared TypeScript program, compiling `.astro` files to TSX with `@astrojs/compiler` (the compiler `astro check` uses, bundled as a dependency) and mapping positions back through source maps
- `src/astro.ts`: `findElements`, `findIslands`, `findActions` and `attributeExpression`, the shared Astro-level helpers rules build on
- `src/type-utils.ts`: type walkers for what gets serialized
- `src/rules/`: built-in rules, registered in `src/rules/index.ts`; each has a doc in `docs/rules/`
- `src/config.ts`, `src/engine.ts`, `src/ignores.ts`: config loading and validation, the run itself, and ignore comments
- `src/cli.ts`, `src/reporters.ts`: the command line and output formats
- `test/fixtures/basic/`: a small Astro project the tests analyze

## Commands

- `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm format`

## Conventions

- Rules only report findings; severities, overrides, `ignore`, ignore comments and exceptions are applied by the engine.
- Reuse the shared helpers and project; never build a second TypeScript program in a rule.
- Validate every config input and reject unknown keys, so a typo can't silently disable a check.
- A rule's `target` fields must stay stable when code moves: names, never line numbers.
- Keep `typescript` a peer dependency; it must be the consuming project's copy.
