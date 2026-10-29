# Changelog

## 0.1.0

- First release.
- Rule engine over one shared TypeScript program with `.astro` files compiled in, with `findIslands`, `findActions` and serialized-shape type utilities for rules, and plugins for custom rules.
- Built-in rules `astro/no-server-objects`, `astro/no-excess-island-props` and `astro/no-unsanitized-html`.
- `findElements` for rules: every JSX element, including `server:defer` islands, with attributes and the component file its import resolves to.
- `astro-analyzer.config.ts` and `.mts`, so the config and project-specific rules can be TypeScript (Node 22.18 or later).
- `astro-analyzer.config.mjs` with severities, rule options, overrides, ignore globs, exceptions and plugins.
- `astro-analyzer-ignore-next-line` comments with required reasons, and warnings for exceptions that no longer match.
- Pretty and JSON output, `astro-analyzer rules`, and `--print-exceptions` for adopting the tool on an existing project.
- Failing runs print, for each finding, the exact ignore comment (in the comment syntax valid at that spot) and the exact config exception that would cover it.
