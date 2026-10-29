import { relative, resolve } from "node:path"
import picomatch from "picomatch"
import { CONFIG_FILES, findConfigFile, loadConfigFile, resolveConfig, type ResolvedConfig } from "./config.js"
import { IGNORE_DIRECTIVE, parseIgnoreDirectives, type IgnoreDirective } from "./ignores.js"
import { createProject, toPosix } from "./project.js"
import type { AnalysisResult, AstroAnalyzerConfig, ConfigException, Diagnostic, RuleMeta, Severity } from "./types.js"

export const INVALID_IGNORE = "astro-analyzer/invalid-ignore"
export const UNUSED_EXCEPTION = "astro-analyzer/unused-exception"

const META_RULES: RuleMeta[] = [
  {
    name: INVALID_IGNORE,
    description: `An ${IGNORE_DIRECTIVE} comment names an unknown rule or is missing its "-- reason".`,
    defaultSeverity: "error",
    target: [],
  },
  {
    name: UNUSED_EXCEPTION,
    description: "An ignore comment or config exception no longer matches any finding; remove it.",
    defaultSeverity: "warn",
    target: [],
  },
]

export type AnalyzeOptions = {
  /** Project root. Defaults to the current directory. */
  cwd?: string
  /** Use this config instead of loading `astro-analyzer.config.mjs`. */
  config?: AstroAnalyzerConfig
  /** Config file path, relative to `cwd`. */
  configFile?: string
}

function severityResolver(config: ResolvedConfig) {
  const overrides = config.overrides.map((o) => ({ matches: picomatch(o.files), rules: o.rules }))
  return (ruleId: string, file: string): Severity => {
    let severity = config.rules.get(ruleId)?.severity ?? "off"
    for (const override of overrides) {
      const overridden = override.rules[ruleId]
      if (overridden && override.matches(file)) severity = overridden
    }
    return severity
  }
}

const exceptionTargets = (exception: ConfigException) =>
  Object.entries(exception).filter(([key]) => key !== "rule" && key !== "file" && key !== "reason")

const covers = (exception: ConfigException, d: Diagnostic) =>
  exception.rule === d.rule &&
  exception.file === d.location.file &&
  exceptionTargets(exception).every(([key, value]) => d.target[key] === value)

export async function analyze(options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const started = Date.now()
  const root = resolve(options.cwd ?? process.cwd())
  const config = resolveConfig(options.config ?? (await loadConfigFile(root, options.configFile)))
  const configPath = findConfigFile(root, options.configFile)
  const configFile = configPath ? toPosix(relative(root, configPath)) : CONFIG_FILES[0]!
  const severityFor = severityResolver(config)
  const isIgnoredFile = config.ignore.length > 0 ? picomatch(config.ignore) : () => false
  const ruleMeta = new Map<string, RuleMeta>(META_RULES.map((meta) => [meta.name, meta]))
  for (const [id, { rule }] of config.rules) ruleMeta.set(id, rule.meta)

  const active = [...config.rules.values()].filter(
    ({ id, severity }) => severity !== "off" || config.overrides.some((o) => o.rules[id] && o.rules[id] !== "off"),
  )
  const configWarnings = active.flatMap(({ rule, options }) => rule.configWarnings?.(options) ?? [])
  const empty = { errorCount: 0, warningCount: 0, rules: ruleMeta, configWarnings, configFile }
  if (active.length === 0) return { diagnostics: [], suppressed: [], ...empty, durationMs: Date.now() - started }

  const project = createProject(root, { tsconfig: config.tsconfig, srcDir: config.srcDir })
  configWarnings.push(...project.warnings)
  const found: Diagnostic[] = []
  const reported = new Set<string>()
  for (const { id, rule, options: ruleOptions } of active) {
    let findings
    try {
      findings = rule.check({ project, options: ruleOptions })
    } catch (e) {
      throw new Error(`Rule ${id} failed: ${(e as Error).stack ?? e}`)
    }
    for (const finding of findings) {
      if (isIgnoredFile(finding.location.file)) continue
      const severity = severityFor(id, finding.location.file)
      if (severity === "off") continue
      const target = Object.fromEntries(
        Object.entries(finding.target).filter(([field]) => rule.meta.target.includes(field)),
      )
      const key = JSON.stringify([id, finding.location, target, finding.message])
      if (reported.has(key)) continue
      reported.add(key)
      found.push({ ...finding, target, rule: id, severity, docs: rule.meta.docs })
    }
  }

  const sources = new Map<string, string>(project.astroFiles.map((f) => [project.rel(f.path), f.source]))
  for (const file of project.sourceFiles) {
    if (!project.astroFileFor(file)) sources.set(project.rel(file.fileName), file.text)
  }
  const directives = new Map<string, (IgnoreDirective & { used: boolean })[]>()
  const meta: Diagnostic[] = []
  for (const [file, source] of sources) {
    if (!source.includes(IGNORE_DIRECTIVE) || isIgnoredFile(file)) continue
    const valid: (IgnoreDirective & { used: boolean })[] = []
    for (const directive of parseIgnoreDirectives(source)) {
      const unknown = directive.rules.filter((id) => !config.rules.has(id))
      const problem =
        unknown.length > 0
          ? `unknown rule ${unknown.join(", ")}`
          : config.requireIgnoreReason && !directive.reason
            ? `missing a reason; end it with "-- why this is safe"`
            : undefined
      if (problem) {
        meta.push({
          rule: INVALID_IGNORE,
          severity: "error",
          location: { file, line: directive.line, column: 1 },
          target: {},
          message: `${IGNORE_DIRECTIVE} comment is ${problem}`,
        })
      } else valid.push({ ...directive, used: false })
    }
    directives.set(file, valid)
  }

  const usedExceptions = new Set<ConfigException>()
  const diagnostics: Diagnostic[] = []
  const suppressed: Diagnostic[] = []
  for (const d of found) {
    const exception = config.exceptions.find((e) => covers(e, d))
    const directive = directives
      .get(d.location.file)
      ?.find((dir) => dir.line + 1 === d.location.line && (dir.rules.length === 0 || dir.rules.includes(d.rule)))
    if (exception) usedExceptions.add(exception)
    if (directive) directive.used = true
    ;(exception || directive ? suppressed : diagnostics).push(d)
  }

  if (config.reportUnusedExceptions) {
    const ranFor = (ruleId: string, file: string) =>
      !isIgnoredFile(file) && active.some((r) => r.id === ruleId) && severityFor(ruleId, file) !== "off"
    for (const exception of config.exceptions) {
      if (usedExceptions.has(exception) || !ranFor(exception.rule, exception.file)) continue
      const target = exceptionTargets(exception).map(([key, value]) => `${key}=${value}`)
      meta.push({
        rule: UNUSED_EXCEPTION,
        severity: "warn",
        location: { file: exception.file, line: 1, column: 1 },
        target: {},
        message: `Config exception for ${[exception.rule, ...target].join(" ")} no longer matches anything; remove it`,
      })
    }
    for (const [file, list] of directives) {
      for (const directive of list) {
        const rules = directive.rules.length > 0 ? directive.rules : active.map((r) => r.id)
        if (directive.used || !rules.some((id) => ranFor(id, file))) continue
        meta.push({
          rule: UNUSED_EXCEPTION,
          severity: "warn",
          location: { file, line: directive.line, column: 1 },
          target: {},
          message: `${IGNORE_DIRECTIVE} comment no longer matches anything on the next line; remove it`,
        })
      }
    }
  }

  const byPosition = (a: Diagnostic, b: Diagnostic) =>
    a.location.file.localeCompare(b.location.file) ||
    a.location.line - b.location.line ||
    a.location.column - b.location.column
  const all = [...diagnostics, ...meta].sort(byPosition)
  return {
    diagnostics: all,
    suppressed: suppressed.sort(byPosition),
    errorCount: all.filter((d) => d.severity === "error").length,
    warningCount: all.filter((d) => d.severity === "warn").length,
    rules: ruleMeta,
    configFile,
    configWarnings,
    durationMs: Date.now() - started,
  }
}
