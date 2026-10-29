import type { TraceMap } from "@jridgewell/trace-mapping"
import type ts from "typescript"

export type Severity = "error" | "warn" | "off"

/** A rule's setting in config: a severity, or `[severity, options]`. */
export type RuleSetting = Severity | [Severity] | [Severity, Record<string, unknown>]

/**
 * A config-file exception. `rule`, `file` and `reason` are required; any of the rule's target fields
 * (for example `component` and `prop`) narrow it to one finding, and leaving them out covers the whole file.
 */
export type ConfigException = { rule: string; file: string; reason: string; [target: string]: string | undefined }

export type Override = {
  /** Globs relative to the project root. */
  files: string[]
  rules: Record<string, Severity>
}

export type Plugin = {
  /** Prefix for the plugin's rule ids: rule `no-foo` in plugin `acme` is `acme/no-foo`. */
  name: string
  rules: Rule<any>[]
}

export type AstroAnalyzerConfig = {
  /** Path to the tsconfig, relative to the project root. Defaults to `tsconfig.json`. */
  tsconfig?: string
  /** Astro's `srcDir`. Defaults to `src`. */
  srcDir?: string
  /** Globs of files whose findings are dropped entirely. */
  ignore?: string[]
  rules?: Record<string, RuleSetting>
  overrides?: Override[]
  exceptions?: ConfigException[]
  plugins?: Plugin[]
  /** Inline ignore comments must end in `-- reason`. Defaults to `true`. */
  requireIgnoreReason?: boolean
  /** Warn about ignore comments and config exceptions that no longer match anything. Defaults to `true`. */
  reportUnusedExceptions?: boolean
}

export type AstroFile = {
  /** Absolute path of the `.astro` file. */
  path: string
  source: string
  /** The file compiled to TSX, part of the project's program. */
  tsx: ts.SourceFile
  map: TraceMap
}

/**
 * Comment syntax that is valid on the line above a finding: `html` (`<!-- -->`) in an Astro template, `jsx`
 * (`{/* *\/}`) among JSX children inside an expression or a TSX file, `js` (`//`) anywhere else.
 */
export type CommentStyle = "html" | "jsx" | "js"

export type Location = {
  /** POSIX path relative to the project root. */
  file: string
  /** 1-based. */
  line: number
  /** 1-based. */
  column: number
  /** Used to suggest an ignore comment; `project.locate` fills it in. */
  commentStyle?: CommentStyle
}

export type Project = {
  root: string
  srcDir: string
  program: ts.Program
  checker: ts.TypeChecker
  astroFiles: AstroFile[]
  /** The project's own source files (TS, TSX and compiled `.astro`), excluding declarations and `node_modules`. */
  sourceFiles: ts.SourceFile[]
  /** POSIX path relative to the project root. */
  rel: (path: string) => string
  /** The `.astro` file a compiled TSX source belongs to, if any. */
  astroFileFor: (sourceFile: ts.SourceFile) => AstroFile | undefined
  /** Where a node is in the original file, mapping compiled `.astro` positions back to the `.astro` source. */
  locate: (sourceFile: ts.SourceFile, node: ts.Node) => Location
  /** Problems with the project setup that can hide findings, such as a missing `srcDir`. */
  warnings: string[]
}

export type RuleMeta = {
  /** Rule id without the plugin prefix. */
  name: string
  description: string
  /** Link or repo path to the rule's documentation. */
  docs?: string
  /** What to do about a finding, printed once per rule when it fails. */
  hint?: string
  defaultSeverity: Severity
  /** Fields of `Finding.target` that identify a finding within a file; config exceptions match on them. */
  target: readonly string[]
}

export type RuleContext<Options> = { project: Project; options: Options }

export type Rule<Options = Record<string, never>> = {
  meta: RuleMeta
  /** Validate and default the options from config. Throw an `Error` to reject them. */
  parseOptions?: (raw: Record<string, unknown>) => Options
  /** Notes printed when the rule is enabled but configured so it can't find anything. */
  configWarnings?: (options: Options) => string[]
  check: (ctx: RuleContext<Options>) => Finding[]
}

export type Finding = {
  location: Location
  target: Record<string, string>
  message: string
}

export type Diagnostic = Finding & {
  rule: string
  severity: Exclude<Severity, "off">
  docs?: string
}

export type AnalysisResult = {
  diagnostics: Diagnostic[]
  /** Findings covered by an ignore comment or config exception. */
  suppressed: Diagnostic[]
  errorCount: number
  warningCount: number
  /** Notes about the configuration itself, such as a rule that needs an option to do anything. */
  configWarnings: string[]
  /** Rule metadata by full rule id, for reporters. */
  rules: Map<string, RuleMeta>
  /** Path, relative to the project root, of the config file the run used, or where one would be read from. */
  configFile: string
  durationMs: number
}
