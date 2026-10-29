import { IGNORE_DIRECTIVE } from "./ignores.js"
import type { AnalysisResult, ConfigException, Diagnostic } from "./types.js"

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const red = paint(31)
const yellow = paint(33)
const dim = paint(2)
const bold = paint(1)

const REASON_PLACEHOLDER = "<why this is safe>"
const MAX_EXAMPLES = 5

/** The exact ignore comment for a finding, in the comment syntax valid where it is. */
export function ignoreComment(d: Diagnostic, reason = REASON_PLACEHOLDER): string {
  const directive = `${IGNORE_DIRECTIVE} ${d.rule} -- ${reason}`
  if (d.location.commentStyle === "html") return `<!-- ${directive} -->`
  if (d.location.commentStyle === "jsx") return `{/* ${directive} */}`
  return `// ${directive}`
}

export const toException = (d: Diagnostic, reason: string): ConfigException =>
  ({ rule: d.rule, file: d.location.file, ...d.target, reason }) as ConfigException

function howToResolve(result: AnalysisResult, diagnostics: Diagnostic[]): string[] {
  const lines: string[] = []
  for (const id of new Set(diagnostics.map((d) => d.rule))) {
    const meta = result.rules.get(id)
    lines.push(`${bold(`How to resolve ${id}`)}${meta?.docs ? ` ${dim(`(${meta.docs})`)}` : ""}`)
    if (meta?.hint) lines.push(`  Fix the code: ${meta.hint}`)
  }
  lines.push(
    "  If the finding is intentional and safe, record why with ONE of these instead:",
    `  ${dim(`(replace ${REASON_PLACEHOLDER} with a specific reason a reviewer can check)`)}`,
  )
  for (const d of diagnostics.slice(0, MAX_EXAMPLES)) {
    lines.push(
      "",
      `  ${bold(`${d.location.file}:${d.location.line}`)} ${dim(d.rule)}`,
      `    a) insert this as a new line directly above line ${d.location.line} of ${d.location.file}:`,
      `         ${ignoreComment(d)}`,
      `    b) or add this entry to the "exceptions" array in ${result.configFile}:`,
      `         ${JSON.stringify(toException(d, REASON_PLACEHOLDER))},`,
    )
  }
  const remaining = diagnostics.length - MAX_EXAMPLES
  if (remaining > 0) {
    lines.push(
      "",
      `  ...and ${remaining} more. "astro-analyzer --print-exceptions" prints the "exceptions" entry for every finding.`,
    )
  }
  return lines
}

export function formatPretty(result: AnalysisResult, { quiet = false } = {}): string {
  const shown = quiet ? result.diagnostics.filter((d) => d.severity === "error") : result.diagnostics
  const lines: string[] = []
  for (const warning of result.configWarnings) lines.push(yellow(`config: ${warning}`))

  const byFile = new Map<string, Diagnostic[]>()
  for (const d of shown) byFile.set(d.location.file, [...(byFile.get(d.location.file) ?? []), d])
  for (const [file, diagnostics] of byFile) {
    lines.push("", bold(file))
    for (const d of diagnostics) {
      const position = dim(`${d.location.line}:${d.location.column}`.padEnd(8))
      const severity = d.severity === "error" ? red("error") : yellow("warn ")
      lines.push(`  ${position} ${severity}  ${d.message}  ${dim(d.rule)}`)
    }
  }

  const resolvable = shown.filter((d) => d.severity === "error" && !d.rule.startsWith("astro-analyzer/"))
  if (resolvable.length > 0) lines.push("", ...howToResolve(result, resolvable))

  const errors = shown.filter((d) => d.severity === "error").length
  const warnings = shown.filter((d) => d.severity === "warn").length
  const total = errors + warnings
  const summary = `${total} problem${total === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`
  const suppressed = result.suppressed.length > 0 ? dim(`, ${result.suppressed.length} suppressed`) : ""
  lines.push(
    "",
    `${total === 0 ? "✓" : errors > 0 ? red("✖") : yellow("⚠")} ${summary}${suppressed} ${dim(`in ${(result.durationMs / 1000).toFixed(1)}s`)}`,
  )
  return lines.join("\n")
}

export function formatJson(result: AnalysisResult, { quiet = false } = {}): string {
  return JSON.stringify(
    {
      errorCount: result.errorCount,
      warningCount: quiet ? 0 : result.warningCount,
      configWarnings: result.configWarnings,
      diagnostics: quiet ? result.diagnostics.filter((d) => d.severity === "error") : result.diagnostics,
      suppressed: result.suppressed,
      durationMs: result.durationMs,
    },
    null,
    2,
  )
}

/** Config `exceptions` entries for the current findings, for pasting into `astro-analyzer.config.mjs`. */
export function formatExceptions(result: AnalysisResult, reason: string): string {
  const seen = new Set<string>()
  const exceptions: ConfigException[] = []
  for (const d of result.diagnostics) {
    if (d.rule.startsWith("astro-analyzer/")) continue
    const exception = toException(d, reason)
    const key = JSON.stringify(exception)
    if (seen.has(key)) continue
    seen.add(key)
    exceptions.push(exception)
  }
  return JSON.stringify(exceptions, null, 2)
}
