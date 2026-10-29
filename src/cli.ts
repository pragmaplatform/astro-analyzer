#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { loadConfigFile, resolveConfig } from "./config.js"
import { analyze } from "./engine.js"
import { formatExceptions, formatJson, formatPretty } from "./reporters.js"

const HELP = `Usage: astro-analyzer [dir] [options]
       astro-analyzer rules [dir] [options]

Type-aware static analysis for Astro projects.

Options:
  -c, --config <file>       Config file (default: astro-analyzer.config.{mjs,js,ts,mts} in dir)
  -f, --format <format>     pretty (default) or json
  -q, --quiet               Report errors only
      --max-warnings <n>    Fail when there are more than n warnings (ignored with --quiet)
      --print-exceptions    Print config "exceptions" entries for every current finding
      --reason <text>       Reason to put in printed exceptions
  -h, --help                Show this help
  -v, --version             Show the version

Exit codes: 0 clean, 1 errors (or too many warnings), 2 the run couldn't complete (bad usage or config, a
missing tsconfig, or a rule that threw).`

function version() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
  return pkg.version
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      format: { type: "string", short: "f", default: "pretty" },
      quiet: { type: "boolean", short: "q", default: false },
      "max-warnings": { type: "string" },
      "print-exceptions": { type: "boolean", default: false },
      reason: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  })
  if (values.help) return (console.log(HELP), 0)
  if (values.version) return (console.log(version()), 0)

  const listRules = positionals[0] === "rules"
  const cwd = resolve(positionals[listRules ? 1 : 0] ?? ".")
  if (values.format !== "pretty" && values.format !== "json") throw new UsageError(`Unknown format "${values.format}"`)
  const maxWarnings = values["max-warnings"] === undefined ? Infinity : Number(values["max-warnings"])
  if (Number.isNaN(maxWarnings)) throw new UsageError("--max-warnings must be a number")

  if (listRules) {
    const config = resolveConfig(await loadConfigFile(cwd, values.config))
    for (const [id, { rule, severity }] of config.rules) {
      console.log(`${id.padEnd(34)} ${severity.padEnd(6)} ${rule.meta.description}`)
    }
    return 0
  }

  const result = await analyze({ cwd, configFile: values.config })
  if (values["print-exceptions"]) {
    console.log(formatExceptions(result, values.reason?.trim() || "<why this is safe>"))
    return 0
  }
  const output =
    values.format === "json"
      ? formatJson(result, { quiet: values.quiet })
      : formatPretty(result, { quiet: values.quiet })
  console.log(output)
  const warnings = values.quiet ? 0 : result.warningCount
  return result.errorCount > 0 || warnings > maxWarnings ? 1 : 0
}

class UsageError extends Error {}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`astro-analyzer: ${error instanceof Error ? error.message : String(error)}`)
    if (!(error instanceof UsageError) && process.env.DEBUG) console.error(error)
    process.exitCode = 2
  },
)
