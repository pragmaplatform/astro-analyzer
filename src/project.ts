import { convertToTSX } from "@astrojs/compiler/sync"
import {
  GREATEST_LOWER_BOUND,
  LEAST_UPPER_BOUND,
  TraceMap,
  generatedPositionFor,
  originalPositionFor,
} from "@jridgewell/trace-mapping"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import ts from "typescript"
import type { AstroFile, CommentStyle, Location, Project } from "./types.js"

export const toPosix = (path: string) => path.split(sep).join("/")

function findAstroFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) findAstroFiles(full, out)
    else if (entry.name.endsWith(".astro")) out.push(full)
  }
  return out
}

/** The `<Fragment>` the Astro compiler wraps around an element it finds inside an expression; not in the source. */
function isCompilerFragment(node: ts.Node, sourceFile: ts.SourceFile) {
  if (!ts.isJsxElement(node) || node.openingElement.tagName.getText(sourceFile) !== "Fragment") return false
  const [child, ...rest] = node.children
  return !!child && rest.length === 0 && child.getStart(sourceFile) === node.openingElement.end
}

/** The outermost node that starts at `position`, or the JSX text it falls inside. */
function nodeAt(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  const visit = (node: ts.Node): ts.Node | undefined => {
    if (node !== sourceFile && node.getStart(sourceFile) === position) return node
    const child = ts.forEachChild(node, (c) => (c.getFullStart() <= position && position < c.end ? c : undefined))
    if (!child) return undefined
    return visit(child) ?? (ts.isJsxText(child) ? child : undefined)
  }
  return visit(sourceFile)
}

/**
 * The comment syntax that is valid on a new line inserted before `position`, the first token of a line: HTML
 * comments among an Astro template's children, `{/* *\/}` among JSX children inside an expression or a TSX file,
 * and `//` in code, including inside a template's `{ ... }` expressions.
 */
function commentStyleAt(sourceFile: ts.SourceFile, position: number, inAstroFile: boolean): CommentStyle {
  const node = nodeAt(sourceFile, position)
  const container = node?.parent
  if (!container || isCompilerFragment(container, sourceFile)) return "js"
  if (!ts.isJsxElement(container) && !ts.isJsxFragment(container)) return "js"
  for (let ancestor = container.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isJsxExpression(ancestor)) return "jsx"
  }
  return inAstroFile ? "html" : "jsx"
}

const firstTokenColumn = (lineText: string) => lineText.length - lineText.trimStart().length

/** Astro's install directory as Node resolves it from the project, so hoisted monorepo installs are found. */
function findAstroPackage(root: string): string | undefined {
  try {
    return dirname(createRequire(join(root, "package.json")).resolve("astro/package.json"))
  } catch {
    return undefined
  }
}

function readTsconfig(path: string): ts.ParsedCommandLine {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"))
    },
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, host)
  if (!parsed) throw new Error(`Could not read ${path}`)
  return parsed
}

/**
 * Builds one TypeScript program over the project, with every `.astro` file compiled to TSX the way
 * `astro check` does, so rules can use the type checker across `.astro`, `.ts` and `.tsx` files.
 */
export function createProject(projectRoot: string, options: { tsconfig: string; srcDir: string }): Project {
  const root = resolve(projectRoot)
  const tsconfigPath = resolve(root, options.tsconfig)
  if (!existsSync(tsconfigPath)) throw new Error(`tsconfig not found: ${tsconfigPath}`)
  const parsed = readTsconfig(tsconfigPath)
  const rel = (path: string) => toPosix(relative(root, path))

  const compiled = new Map<string, { source: string; code: string; map: TraceMap }>()
  for (const file of findAstroFiles(resolve(root, options.srcDir))) {
    const source = readFileSync(file, "utf8")
    const tsx = convertToTSX(source, { filename: toPosix(file), includeScripts: false, includeStyles: false })
    compiled.set(`${file}.tsx`, { source, code: tsx.code, map: new TraceMap(tsx.map as never) })
  }

  const warnings: string[] = []
  const srcDir = resolve(root, options.srcDir)
  if (!existsSync(srcDir)) warnings.push(`srcDir "${options.srcDir}" does not exist, so no .astro files were analyzed`)
  else if (compiled.size === 0) warnings.push(`no .astro files found under srcDir "${options.srcDir}"`)

  const astroDir = findAstroPackage(root)
  if (!astroDir) warnings.push(`the "astro" package could not be resolved from ${root}; Astro's types are missing`)
  const astroTypes = astroDir
    ? ["env.d.ts", "astro-jsx.d.ts"].map((file) => join(astroDir, file)).filter((file) => existsSync(file))
    : []

  const host = ts.createCompilerHost(parsed.options)
  const { getSourceFile, fileExists, readFile } = host
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const virtual = compiled.get(resolve(fileName))
    if (virtual) return ts.createSourceFile(fileName, virtual.code, languageVersion, true, ts.ScriptKind.TSX)
    return getSourceFile(fileName, languageVersion, onError, shouldCreate)
  }
  host.fileExists = (fileName) => compiled.has(resolve(fileName)) || fileExists(fileName)
  host.readFile = (fileName) => compiled.get(resolve(fileName))?.code ?? readFile(fileName)

  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, ...astroTypes, ...compiled.keys()],
    options: parsed.options,
    host,
  })

  const astroFiles: AstroFile[] = []
  const astroByTsx = new Map<ts.SourceFile, AstroFile>()
  for (const [tsxPath, { source, map }] of compiled) {
    const tsx = program.getSourceFile(tsxPath)
    if (!tsx) continue
    const astroFile = { path: tsxPath.slice(0, -".tsx".length), source, tsx, map }
    astroFiles.push(astroFile)
    astroByTsx.set(tsx, astroFile)
  }

  const nodeModules = `${sep}node_modules${sep}`
  const sourceFiles = program.getSourceFiles().filter((file) => {
    const path = resolve(file.fileName)
    return !file.isDeclarationFile && path.startsWith(root + sep) && !path.includes(nodeModules)
  })

  const locate = (sourceFile: ts.SourceFile, node: ts.Node): Location => {
    const generated = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    const astroFile = astroByTsx.get(sourceFile)
    if (!astroFile) {
      const lineText = sourceFile.text.split(/\r?\n/)[generated.line] ?? ""
      const lineStart = sourceFile.getPositionOfLineAndCharacter(generated.line, firstTokenColumn(lineText))
      return {
        file: rel(sourceFile.fileName),
        line: generated.line + 1,
        column: generated.character + 1,
        commentStyle: commentStyleAt(sourceFile, lineStart, false),
      }
    }
    const position = { line: generated.line + 1, column: generated.character }
    const lower = originalPositionFor(astroFile.map, { ...position, bias: GREATEST_LOWER_BOUND })
    const original =
      lower.line !== null ? lower : originalPositionFor(astroFile.map, { ...position, bias: LEAST_UPPER_BOUND })
    const line = original.line ?? 1
    return {
      file: rel(astroFile.path),
      line,
      column: (original.column ?? 0) + 1,
      commentStyle: astroCommentStyle(astroFile, line, original.source),
    }
  }

  const astroCommentStyle = (astroFile: AstroFile, line: number, source: string | null): CommentStyle => {
    const lineText = astroFile.source.split(/\r?\n/)[line - 1] ?? ""
    const column = firstTokenColumn(lineText)
    const mapped = source ? generatedPositionFor(astroFile.map, { source, line, column }) : undefined
    if (mapped?.line == null || mapped.column == null) return "html"
    const position = astroFile.tsx.getPositionOfLineAndCharacter(mapped.line - 1, mapped.column)
    return commentStyleAt(astroFile.tsx, position, true)
  }

  return {
    root,
    srcDir: options.srcDir,
    program,
    checker: program.getTypeChecker(),
    astroFiles,
    sourceFiles,
    rel,
    astroFileFor: (sourceFile) => astroByTsx.get(sourceFile),
    locate,
    warnings,
  }
}
