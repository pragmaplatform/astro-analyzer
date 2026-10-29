# Contributing

```sh
pnpm install
pnpm test          # vitest, against the fixture project in test/fixtures/basic
pnpm typecheck
pnpm build         # compiles src/ to dist/
pnpm format
```

Try a local build against a real project with `node /path/to/astro-analyzer/dist/cli.js` from that project's root.

New built-in rules: see [Writing rules](docs/writing-rules.md#contributing-a-built-in-rule).

## Releasing

1. Update `version` in `package.json` and add a `## <version>` section to `CHANGELOG.md`.
2. Merge to `main`, then tag the commit `v<version>` and push the tag.
3. The `Release` workflow checks the tag matches `package.json` and that the changelog has a section for it, runs the checks through `prepublishOnly`, publishes to npm with provenance (needs the `NPM_TOKEN` secret) and creates the GitHub release with that changelog section as its notes.
