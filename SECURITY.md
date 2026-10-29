# Security policy

astro-analyzer is a static analysis tool: it reads your project's source and never sends it anywhere. Security issues in it would typically be a rule that misses a leak it documents catching, or unsafe handling of the config and plugin files it loads.

## Reporting a vulnerability

Please do not open a public issue. Report privately through GitHub's
[private vulnerability reporting](https://github.com/pragmaplatform/astro-analyzer/security/advisories/new) for this repository.

Include the version, a minimal project or snippet that reproduces the problem, and what you expected the tool to report. You should hear back within a week. Fixes ship as a patch release with a changelog entry, and the report is credited unless you prefer otherwise.

## Supported versions

Only the latest release on npm receives fixes.
