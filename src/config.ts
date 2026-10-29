import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { builtinPlugin } from "./rules/index.js"
import type { AstroAnalyzerConfig, ConfigException, Override, Plugin, Rule, RuleSetting, Severity } from "./types.js"

export const CONFIG_FILES = [
  "astro-analyzer.config.mjs",
  "astro-analyzer.config.js",
  "astro-analyzer.config.ts",
  "astro-analyzer.config.mts",
]

/** Node strips TypeScript types natively from 22.18 and 23.6; older versions can't import a `.ts` config. */
const canImportTypeScript = () => !!(process.features as { typescript?: string | false }).typescript

/** Identity helper that types an `astro-analyzer.config.mjs` default export. */
export const defineConfig = (config: AstroAnalyzerConfig) => config

/** Identity helper that types a custom rule. */
export const defineRule = <Options>(rule: Rule<Options>) => rule

export type ResolvedRule = {
  id: string
  rule: Rule<any>
  severity: Severity
  options: unknown
}

export type ResolvedConfig = {
  tsconfig: string
  srcDir: string
  ignore: string[]
  rules: Map<string, ResolvedRule>
  overrides: Override[]
  exceptions: ConfigException[]
  requireIgnoreReason: boolean
  reportUnusedExceptions: boolean
}

const SEVERITIES: Severity[] = ["error", "warn", "off"]
const isSeverity = (value: unknown): value is Severity => SEVERITIES.includes(value as Severity)

/** The config file to load: `configFile` if given, otherwise the first of `CONFIG_FILES` in `root` that exists. */
export function findConfigFile(root: string, configFile?: string): string | undefined {
  if (configFile) return resolve(root, configFile)
  return CONFIG_FILES.map((name) => resolve(root, name)).find((candidate) => existsSync(candidate))
}

export async function loadConfigFile(root: string, configFile?: string): Promise<AstroAnalyzerConfig> {
  const path = findConfigFile(root, configFile)
  if (!path) return {}
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`)
  if (/\.m?ts$/.test(path) && !canImportTypeScript()) {
    throw new Error(`${path} is TypeScript, which needs Node 22.18 or later; use astro-analyzer.config.mjs instead`)
  }
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown }
  if (!module.default || typeof module.default !== "object") {
    throw new Error(`${path} must have a default export, e.g. export default defineConfig({ ... })`)
  }
  return module.default as AstroAnalyzerConfig
}

function parseSetting(id: string, setting: RuleSetting): { severity: Severity; raw: Record<string, unknown> } {
  const [severity, raw = {}] = Array.isArray(setting) ? setting : [setting]
  if (!isSeverity(severity)) throw new Error(`rules["${id}"]: severity must be one of ${SEVERITIES.join(", ")}`)
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`rules["${id}"]: options must be an object`)
  return { severity, raw }
}

const KNOWN_KEYS = [
  "tsconfig",
  "srcDir",
  "ignore",
  "rules",
  "overrides",
  "exceptions",
  "plugins",
  "requireIgnoreReason",
  "reportUnusedExceptions",
]

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function stringValue(value: unknown, where: string, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`)
  return value
}

function booleanValue(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${where} must be true or false`)
  return value
}

function globList(value: unknown, where: string, { required = false } = {}): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim()) || (required && !value.length)) {
    throw new Error(`${where} must be ${required ? "a non-empty" : "an"} array of glob strings`)
  }
  return value
}

function arrayValue(value: unknown, where: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  return value
}

export function resolveConfig(config: AstroAnalyzerConfig): ResolvedConfig {
  if (!isPlainObject(config)) throw new Error("The config must be an object")
  const unknownKeys = Object.keys(config).filter((key) => !KNOWN_KEYS.includes(key))
  if (unknownKeys.length > 0) throw new Error(`Unknown config key ${unknownKeys.map((k) => `"${k}"`).join(", ")}`)

  const registry = new Map<string, Rule<any>>()
  const extraPlugins = (arrayValue(config.plugins, "plugins") as Plugin[]).filter((plugin) => plugin !== builtinPlugin)
  for (const plugin of [builtinPlugin, ...extraPlugins]) {
    if (!isPlainObject(plugin) || typeof plugin.name !== "string" || !plugin.name || !Array.isArray(plugin.rules)) {
      throw new Error(`Plugins need a "name" and a "rules" array`)
    }
    for (const rule of plugin.rules) {
      if (!isPlainObject(rule) || !isPlainObject(rule.meta) || typeof rule.check !== "function") {
        throw new Error(`Plugin "${plugin.name}" has a rule without "meta" and "check"`)
      }
      const id = `${plugin.name}/${rule.meta.name}`
      if (registry.has(id)) throw new Error(`Rule ${id} is defined twice`)
      registry.set(id, rule)
    }
  }

  if (config.rules !== undefined && !isPlainObject(config.rules)) throw new Error(`"rules" must be an object`)
  const settings = config.rules ?? {}
  for (const id of Object.keys(settings)) {
    if (!registry.has(id)) throw new Error(`Unknown rule "${id}"; available: ${[...registry.keys()].join(", ")}`)
  }

  const rules = new Map<string, ResolvedRule>()
  for (const [id, rule] of registry) {
    const { severity, raw } = parseSetting(id, settings[id] ?? rule.meta.defaultSeverity)
    let options: unknown
    try {
      if (!rule.parseOptions && Object.keys(raw).length > 0) throw new Error("this rule takes no options")
      options = rule.parseOptions ? rule.parseOptions(raw) : {}
    } catch (e) {
      throw new Error(`rules["${id}"]: ${(e as Error).message}`)
    }
    rules.set(id, { id, rule, severity, options })
  }

  const overrides = arrayValue(config.overrides, "overrides") as Override[]
  overrides.forEach((override, index) => {
    const where = `overrides[${index}]`
    if (!isPlainObject(override)) throw new Error(`${where} must be { files, rules }`)
    const unknown = Object.keys(override).filter((key) => key !== "files" && key !== "rules")
    if (unknown.length > 0) throw new Error(`${where}: unexpected ${unknown.map((k) => `"${k}"`).join(", ")}`)
    globList(override.files, `${where}.files`, { required: true })
    if (!isPlainObject(override.rules)) throw new Error(`${where}.rules must be an object of rule severities`)
    for (const [id, severity] of Object.entries(override.rules)) {
      if (!registry.has(id)) throw new Error(`overrides[${index}]: unknown rule "${id}"`)
      if (!isSeverity(severity)) throw new Error(`overrides[${index}].rules["${id}"] must be a severity`)
    }
  })

  const exceptions = arrayValue(config.exceptions, "exceptions") as ConfigException[]
  exceptions.forEach((exception, index) => {
    const where = `exceptions[${index}]`
    if (!isPlainObject(exception)) throw new Error(`${where} must be { rule, file, reason, ... }`)
    const rule = registry.get(exception.rule)
    if (!rule) throw new Error(`${where}: unknown rule "${exception.rule}"`)
    const allowed = ["rule", "file", "reason", ...rule.meta.target]
    for (const key of Object.keys(exception)) {
      if (allowed.includes(key) && (typeof exception[key] !== "string" || !exception[key].trim())) {
        throw new Error(`${where}: "${key}" must be a non-empty string`)
      }
    }
    for (const key of ["file", "reason"]) {
      if (exception[key] === undefined) throw new Error(`${where}: "${key}" is required`)
    }
    const unknown = Object.keys(exception).filter((key) => !allowed.includes(key))
    if (unknown.length > 0) {
      throw new Error(
        `${where}: unexpected ${unknown.map((k) => `"${k}"`).join(", ")}; ${exception.rule} matches on ${rule.meta.target.join(", ")}`,
      )
    }
  })

  return {
    tsconfig: stringValue(config.tsconfig, "tsconfig", "tsconfig.json"),
    srcDir: stringValue(config.srcDir, "srcDir", "src"),
    ignore: globList(config.ignore, "ignore"),
    rules,
    overrides,
    exceptions,
    requireIgnoreReason: booleanValue(config.requireIgnoreReason, "requireIgnoreReason", true),
    reportUnusedExceptions: booleanValue(config.reportUnusedExceptions, "reportUnusedExceptions", true),
  }
}
