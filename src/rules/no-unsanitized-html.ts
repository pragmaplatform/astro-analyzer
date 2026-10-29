import ts from "typescript"
import { attributeExpression, findElements, type AstroElement } from "../astro.js"
import { assertKnownOptions, stringArrayOption } from "../options.js"
import { nonNullishMembers } from "../type-utils.js"
import type { Finding, Rule } from "../types.js"

export type NoUnsanitizedHtmlOptions = {
  /** Functions whose result is safe HTML, by name (`xss`, `sanitizeHtml`) or dotted path (`DOMPurify.sanitize`). */
  sanitizers: string[]
  /** Type names that mark a value as already sanitized, such as a branded `SafeHtml` returned by your sanitizer. */
  safeTypes: string[]
  /** Modules whose imports are trusted HTML, such as an icon package that exports SVG strings (`lucide-static`). */
  trustedModules: string[]
}

const MAX_TRACE_DEPTH = 6

const isLiteralType = (type: ts.Type) =>
  nonNullishMembers(type).length > 0 &&
  nonNullishMembers(type).every(
    (t) => (t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)) !== 0,
  )

function calleeName(call: ts.CallExpression, sourceFile: ts.SourceFile) {
  const callee = call.expression
  return ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee) ? callee.getText(sourceFile) : undefined
}

function importedModule(declaration: ts.Declaration): string | undefined {
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (ts.isImportDeclaration(node))
      return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined
  }
  return undefined
}

const isTrustedModule = (module: string, options: NoUnsanitizedHtmlOptions) =>
  /[?&]raw$/.test(module) || options.trustedModules.some((m) => module === m || module.startsWith(`${m}/`))

const isNullishType = (type: ts.Type) => nonNullishMembers(type).length === 0

/** A `const` declaration's initializer, following imports to the module that declares it. */
function constInitializer(checker: ts.TypeChecker, identifier: ts.Identifier): ts.Expression | undefined {
  const symbol = checker.getSymbolAtLocation(identifier)
  const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  const declaration = resolved?.declarations?.[0]
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    return declaration.initializer
  }
  return undefined
}

/**
 * Whether an HTML string is safe to inject: a constant, `null` or `undefined`, a `?raw` import, an import from a
 * trusted module, sanitizer output, a value of a safe type, or a `const` (local or imported) built only from those.
 */
function isSafe(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  options: NoUnsanitizedHtmlOptions,
  depth = 0,
): boolean {
  if (depth > MAX_TRACE_DEPTH) return false
  const recurse = (e: ts.Expression) => isSafe(checker, e, options, depth + 1)
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
    return recurse(expression.expression)
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return true

  const type = checker.getTypeAtLocation(expression)
  if (isNullishType(type) || isLiteralType(type)) return true
  const members = nonNullishMembers(type)
  const typeName = (t: ts.Type) => t.aliasSymbol?.getName() ?? t.getSymbol()?.getName()
  if (options.safeTypes.length > 0) {
    const wholeName = typeName(type)
    if (wholeName && options.safeTypes.includes(wholeName)) return true
    if (members.every((m) => options.safeTypes.includes(typeName(m) ?? ""))) return true
  }

  if (ts.isTemplateExpression(expression)) return expression.templateSpans.every((span) => recurse(span.expression))
  if (ts.isConditionalExpression(expression)) return recurse(expression.whenTrue) && recurse(expression.whenFalse)
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return recurse(expression.right)
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.PlusToken
    ) {
      return recurse(expression.left) && recurse(expression.right)
    }
    return false
  }
  if (ts.isCallExpression(expression)) {
    const name = calleeName(expression, expression.getSourceFile())
    return !!name && options.sanitizers.some((s) => s === name || name.endsWith(`.${s}`))
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const declaration = checker.getSymbolAtLocation(expression.expression)?.declarations?.[0]
    const module = declaration && ts.isNamespaceImport(declaration) ? importedModule(declaration) : undefined
    return module !== undefined && isTrustedModule(module, options)
  }
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.declarations?.[0]
    const module = declaration ? importedModule(declaration) : undefined
    if (module !== undefined && isTrustedModule(module, options)) return true
    const initializer = constInitializer(checker, expression)
    return !!initializer && recurse(initializer)
  }
  return false
}

const isHtmlKey = (name: ts.PropertyName) =>
  (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "__html"

/**
 * The HTML an element injects: Astro `set:html`, or, on HTML elements in `.tsx` and `.jsx` files, Solid `innerHTML`
 * and React `dangerouslySetInnerHTML`. A `dangerouslySetInnerHTML` object that isn't a literal is returned whole, so
 * it is reported unless its type is safe.
 */
function injectedHtml(element: AstroElement): { attribute: string; expression: ts.Expression } | undefined {
  const setHtml = element.attributes.get("set:html")
  const setHtmlValue = setHtml && attributeExpression(setHtml)
  if (setHtmlValue) return { attribute: "set:html", expression: setHtmlValue }
  if (!element.intrinsic || element.astroFile) return undefined
  const innerHtml = element.attributes.get("innerHTML")
  const innerHtmlValue = innerHtml && attributeExpression(innerHtml)
  if (innerHtmlValue) return { attribute: "innerHTML", expression: innerHtmlValue }
  const dangerous = element.attributes.get("dangerouslySetInnerHTML")
  const object = dangerous && attributeExpression(dangerous)
  if (!object) return undefined
  if (!ts.isObjectLiteralExpression(object)) return { attribute: "dangerouslySetInnerHTML", expression: object }
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && isHtmlKey(property.name)) {
      return { attribute: "dangerouslySetInnerHTML", expression: property.initializer }
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "__html") {
      return { attribute: "dangerouslySetInnerHTML", expression: property.name }
    }
  }
  return undefined
}

const valueLabel = (expression: ts.Expression, sourceFile: ts.SourceFile) => {
  const text = expression.getText(sourceFile).replace(/\s+/g, " ")
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

export const noUnsanitizedHtml: Rule<NoUnsanitizedHtmlOptions> = {
  meta: {
    name: "no-unsanitized-html",
    description: "HTML injected with set:html, innerHTML or dangerouslySetInnerHTML must be constant or sanitized.",
    docs: "https://github.com/pragmaplatform/astro-analyzer/blob/main/docs/rules/no-unsanitized-html.md",
    hint: "pass the value through one of this rule's configured `sanitizers` before injecting it, or render it as text.",
    defaultSeverity: "error",
    target: ["element", "value"],
  },
  parseOptions(raw) {
    assertKnownOptions(raw, ["sanitizers", "safeTypes", "trustedModules"])
    return {
      sanitizers: stringArrayOption(raw, "sanitizers"),
      safeTypes: stringArrayOption(raw, "safeTypes"),
      trustedModules: stringArrayOption(raw, "trustedModules"),
    }
  },
  check({ project, options }) {
    const findings: Finding[] = []
    for (const element of findElements(project)) {
      const injected = injectedHtml(element)
      if (!injected || isSafe(project.checker, injected.expression, options)) continue
      const value = valueLabel(injected.expression, element.sourceFile)
      findings.push({
        location: element.location,
        target: { element: element.tagName, value },
        message: `<${element.tagName}> ${injected.attribute} injects ${value}, which isn't constant or sanitized`,
      })
    }
    return findings
  },
}
