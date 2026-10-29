import { resolve } from "node:path"
import ts from "typescript"
import type { AstroFile, Location, Project } from "./types.js"

export type IslandProp = {
  /** Attribute name, or `{...spread}` for a spread. */
  name: string
  expression: ts.Expression
  /** Type of the value passed in. */
  actual: ts.Type
  /** The component's declared type for this prop; for a spread, the whole props type. Undefined if unknown. */
  declared: ts.Type | undefined
  spread: boolean
}

export type Island = {
  file: AstroFile
  element: ts.JsxOpeningLikeElement
  component: string
  /** The `client:*` directive, such as `client:load`. */
  directive: string
  props: IslandProp[]
  location: Location
}

export type Action = {
  sourceFile: ts.SourceFile
  call: ts.CallExpression
  /** How the action is called from `actions`, such as `user.update`, or the variable it is assigned to. */
  name: string
  /** What the handler resolves to, after unwrapping a promise. */
  returnType: ts.Type
  location: Location
}

const islandCache = new WeakMap<Project, Island[]>()
const actionCache = new WeakMap<Project, Action[]>()

function attributeName(attr: ts.JsxAttribute) {
  return ts.isJsxNamespacedName(attr.name) ? `${attr.name.namespace.text}:${attr.name.name.text}` : attr.name.text
}

function componentPropsType(checker: ts.TypeChecker, tagName: ts.JsxTagNameExpression) {
  const signature = checker.getSignaturesOfType(checker.getTypeAtLocation(tagName), ts.SignatureKind.Call)[0]
  const param = signature?.getParameters()[0]
  return param ? checker.getTypeOfSymbol(param) : undefined
}

/**
 * Every hydrated island (`client:*`) in the project's `.astro` files, with each prop's passed and declared types.
 * `server:defer` islands are skipped: Astro encrypts their props.
 */
export function findIslands(project: Project): Island[] {
  const cached = islandCache.get(project)
  if (cached) return cached
  const { checker } = project
  const islands: Island[] = []
  for (const file of project.astroFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const attrs = node.attributes.properties
        const directives = attrs.filter(ts.isJsxAttribute).map(attributeName)
        const directive = directives.find((d) => d.startsWith("client:"))
        if (directive && !directives.includes("server:defer")) {
          const propsType = componentPropsType(checker, node.tagName)
          const props: IslandProp[] = []
          for (const attr of attrs) {
            if (ts.isJsxSpreadAttribute(attr)) {
              const actual = checker.getTypeAtLocation(attr.expression)
              props.push({
                name: "{...spread}",
                expression: attr.expression,
                actual,
                declared: propsType,
                spread: true,
              })
              continue
            }
            const name = attributeName(attr)
            const expression = attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression
            if (name.includes(":") || !expression) continue
            const declaredSymbol = propsType?.getProperty(name)
            const declared = declaredSymbol ? checker.getTypeOfSymbol(declaredSymbol) : undefined
            props.push({ name, expression, actual: checker.getTypeAtLocation(expression), declared, spread: false })
          }
          islands.push({
            file,
            element: node,
            component: node.tagName.getText(file.tsx),
            directive,
            props,
            location: project.locate(file.tsx, node),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file.tsx)
  }
  islandCache.set(project, islands)
  return islands
}

export type ElementComponent = {
  /** The module specifier the tag is imported from, as written (`astro:assets`, `../components/Card.astro`). */
  module: string | undefined
  /** The name the module exports it as: `default` for a default import, the original name for a renamed one. */
  importedName: string | undefined
  /** Absolute path of the file that declares the component (the `.astro` file for Astro components, or a `.d.ts` for packages), when TypeScript can resolve it. */
  file: string | undefined
  /** The `.astro` file, when the component is one in this project. */
  astroFile: AstroFile | undefined
}

export type AstroElement = {
  sourceFile: ts.SourceFile
  /** The `.astro` file the element is written in, if any. */
  astroFile: AstroFile | undefined
  node: ts.JsxOpeningLikeElement
  /** The tag as written: `div`, `Card`, `UI.Button`. */
  tagName: string
  /** A lowercase HTML or SVG element rather than a component. */
  intrinsic: boolean
  /** Attributes by name, including directives such as `client:load`, `server:defer` and `set:html`. */
  attributes: Map<string, ts.JsxAttribute>
  spreads: ts.JsxSpreadAttribute[]
  /** Computed on first read. */
  readonly location: Location
  /** Where a component tag's import leads; undefined for intrinsic elements. Computed on first read. */
  readonly component: ElementComponent | undefined
}

const elementCache = new WeakMap<Project, AstroElement[]>()

/** The expression an attribute is set to: `{expr}` or a string literal; undefined for a bare attribute. */
export function attributeExpression(attr: ts.JsxAttribute): ts.Expression | undefined {
  const initializer = attr.initializer
  if (!initializer) return undefined
  if (ts.isJsxExpression(initializer)) return initializer.expression
  return ts.isStringLiteral(initializer) ? initializer : undefined
}

function resolveComponent(project: Project, tagName: ts.JsxTagNameExpression): ElementComponent {
  const { checker } = project
  const head = ts.isPropertyAccessExpression(tagName) ? tagName.expression : tagName
  const symbol = checker.getSymbolAtLocation(head)
  const declaration = symbol?.declarations?.[0]
  let importedName: string | undefined
  if (declaration && ts.isImportSpecifier(declaration))
    importedName = (declaration.propertyName ?? declaration.name).text
  else if (declaration && ts.isImportClause(declaration)) importedName = "default"
  if (ts.isPropertyAccessExpression(tagName)) importedName = tagName.name.text

  const target = checker.getSymbolAtLocation(tagName)
  const resolved = target && target.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(target) : target
  const sourceFile = resolved?.declarations?.[0]?.getSourceFile()
  const astroFile = sourceFile ? project.astroFileFor(sourceFile) : undefined
  return {
    module: declaration ? importedFrom(declaration) : undefined,
    importedName,
    file: astroFile?.path ?? (sourceFile ? resolve(sourceFile.fileName) : undefined),
    astroFile,
  }
}

/**
 * Every JSX element in the project's `.astro` templates and `.tsx` files, with its attributes and, for components,
 * where its import leads. Includes `server:defer` islands and plain HTML elements; leaves out the `<Fragment>`
 * wrappers the Astro compiler adds.
 */
export function findElements(project: Project): AstroElement[] {
  const cached = elementCache.get(project)
  if (cached) return cached
  const elements: AstroElement[] = []
  const sourceFiles = project.sourceFiles.filter(
    (file) => project.astroFileFor(file) || file.fileName.endsWith(".tsx") || file.fileName.endsWith(".jsx"),
  )
  for (const sourceFile of sourceFiles) {
    const astroFile = project.astroFileFor(sourceFile)
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tagName = node.tagName.getText(sourceFile)
        const location = lazy(() => project.locate(sourceFile, node))
        const written = !astroFile || tagName !== "Fragment" || isWrittenAt(astroFile, location(), "<Fragment")
        if (written) {
          const attributes = new Map<string, ts.JsxAttribute>()
          const spreads: ts.JsxSpreadAttribute[] = []
          for (const attr of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attr)) spreads.push(attr)
            else attributes.set(attributeName(attr), attr)
          }
          const intrinsic = ts.isIdentifier(node.tagName) && /^[a-z]/.test(tagName)
          const component = lazy(() => (intrinsic ? undefined : resolveComponent(project, node.tagName)))
          elements.push({
            sourceFile,
            astroFile,
            node,
            tagName,
            intrinsic,
            attributes,
            spreads,
            get location() {
              return location()
            },
            get component() {
              return component()
            },
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  elementCache.set(project, elements)
  return elements
}

/** Computes a value on first use: locations and import resolution are only needed for the elements a rule reports. */
function lazy<T>(compute: () => T): () => T {
  let computed = false
  let value: T
  return () => {
    if (!computed) {
      value = compute()
      computed = true
    }
    return value
  }
}

function isWrittenAt(astroFile: AstroFile, location: Location, text: string) {
  const line = astroFile.source.split(/\r?\n/)[location.line - 1] ?? ""
  return line.startsWith(text, location.column - 1)
}

const ACTIONS_MODULE = "astro:actions"

function importedFrom(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier))
      return current.moduleSpecifier.text
  }
  return undefined
}

/** `defineAction(...)`, `renamed(...)` or `ns.defineAction(...)`, as long as it was imported from `astro:actions`. */
function isDefineActionCall(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  const callee = call.expression
  if (ts.isIdentifier(callee)) {
    const declaration = checker.getSymbolAtLocation(callee)?.declarations?.[0]
    return (
      !!declaration &&
      ts.isImportSpecifier(declaration) &&
      (declaration.propertyName ?? declaration.name).text === "defineAction" &&
      importedFrom(declaration) === ACTIONS_MODULE
    )
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "defineAction" &&
    ts.isIdentifier(callee.expression)
  ) {
    const declaration = checker.getSymbolAtLocation(callee.expression)?.declarations?.[0]
    return !!declaration && ts.isNamespaceImport(declaration) && importedFrom(declaration) === ACTIONS_MODULE
  }
  return false
}

const propertyName = (name: ts.PropertyName, sourceFile: ts.SourceFile) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(sourceFile)

/**
 * The path the action is called by from `actions`: nested object keys joined with dots (`user.update`), or the
 * variable it is assigned to when it is defined on its own.
 */
function actionName(call: ts.CallExpression, sourceFile: ts.SourceFile) {
  const keys: string[] = []
  let node: ts.Node = call
  while (ts.isPropertyAssignment(node.parent) && ts.isObjectLiteralExpression(node.parent.parent)) {
    keys.unshift(propertyName(node.parent.name, sourceFile))
    node = node.parent.parent
  }
  if (keys.length > 0) return keys.join(".")
  return ts.isVariableDeclaration(call.parent) ? call.parent.name.getText(sourceFile) : "defineAction"
}

/** Every `defineAction({ handler })` call in the project, with what its handler resolves to. */
export function findActions(project: Project): Action[] {
  const cached = actionCache.get(project)
  if (cached) return cached
  const { checker } = project
  const actions: Action[] = []
  for (const sourceFile of project.sourceFiles) {
    if (project.astroFileFor(sourceFile) || !sourceFile.text.includes("defineAction")) continue
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isDefineActionCall(checker, node)) {
        const options = node.arguments[0]
        const handler =
          options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "handler")
            : undefined
        const signature = handler
          ? checker.getSignaturesOfType(checker.getTypeAtLocation(handler), ts.SignatureKind.Call)[0]
          : undefined
        if (signature) {
          const returned = signature.getReturnType()
          actions.push({
            sourceFile,
            call: node,
            name: actionName(node, sourceFile),
            returnType: checker.getAwaitedType(returned) ?? returned,
            location: project.locate(sourceFile, node),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  actionCache.set(project, actions)
  return actions
}
