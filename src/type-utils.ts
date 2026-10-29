import { resolve } from "node:path"
import ts from "typescript"

const MAX_DEPTH = 8
/** Built-ins that serialize as a single value, with no fields to inspect. */
const OPAQUE_BUILTINS = new Set(["Date", "RegExp", "URL", "BigInt", "Uint8Array", "Uint16Array", "Uint32Array"])
/** Built-in containers whose entries are serialized, with a label for each type argument. */
const CONTAINER_BUILTINS = new Map([
  ["Map", ["<key>", "<value>"]],
  ["ReadonlyMap", ["<key>", "<value>"]],
  ["Set", ["<item>"]],
  ["ReadonlySet", ["<item>"]],
])

export const isNullish = (type: ts.Type) =>
  (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0

export const isUntyped = (type: ts.Type) => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0

export const isObjectType = (type: ts.Type) => (type.flags & ts.TypeFlags.Object) !== 0 || type.isIntersection()

/** A union's members without `null`/`undefined`, or the type itself. */
export function nonNullishMembers(type: ts.Type): ts.Type[] {
  if (type.isUnion()) return type.types.filter((t) => !isNullish(t))
  return isNullish(type) ? [] : [type]
}

export const isCallable = (checker: ts.TypeChecker, type: ts.Type) =>
  checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0

/** Absolute path of the file that declares a type's alias or symbol. */
export function declarationFile(symbol: ts.Symbol | undefined): string | undefined {
  const decl = symbol?.declarations?.[0]
  return decl ? resolve(decl.getSourceFile().fileName) : undefined
}

/** Built-ins that serialize as a value (Date, URL, ...) and functions, which have no fields to inspect. */
export function isOpaque(checker: ts.TypeChecker, type: ts.Type) {
  const symbol = type.getSymbol()
  if (symbol && OPAQUE_BUILTINS.has(symbol.getName()) && declarationFile(symbol)?.endsWith(".d.ts")) return true
  return isCallable(checker, type) && type.getProperties().length === 0
}

export function elementType(checker: ts.TypeChecker, type: ts.Type) {
  if (!checker.isArrayType(type) && !checker.isTupleType(type)) return undefined
  return checker.getIndexTypeOfType(type, ts.IndexKind.Number)
}

export type ContainerPart = { label: string; type: ts.Type }

/**
 * The serialized contents of an array, tuple, `Map` or `Set`, each labelled for property paths
 * (`[]`, `<key>`, `<value>`, `<item>`); undefined for anything else.
 */
export function containerParts(checker: ts.TypeChecker, type: ts.Type): ContainerPart[] | undefined {
  const element = elementType(checker, type)
  if (element) return [{ label: "[]", type: element }]
  const symbol = type.getSymbol()
  const labels = symbol && CONTAINER_BUILTINS.get(symbol.getName())
  if (!labels || !declarationFile(symbol)?.endsWith(".d.ts")) return undefined
  const args = checker.getTypeArguments(type as ts.TypeReference)
  return labels.flatMap((label, index) => (args[index] ? [{ label, type: args[index] }] : []))
}

/** Properties that survive JSON serialization: no methods, no symbol-keyed members. */
export function dataProperties(checker: ts.TypeChecker, type: ts.Type) {
  return type.getProperties().filter((prop) => {
    if (prop.getName().startsWith("__@")) return false
    const propType = checker.getTypeOfSymbol(prop)
    return !(isCallable(checker, propType) && propType.getProperties().length === 0)
  })
}

export type NamedTypeMatch = { path: string; name: string }

/**
 * Walks a type's data shape (properties, array, Map and Set entries, union and intersection members) and returns every
 * type `match` names, with the property path where it was found. Matched types are not descended into.
 */
export function findNamedTypes(
  checker: ts.TypeChecker,
  root: ts.Type,
  match: (type: ts.Type) => string | undefined,
): NamedTypeMatch[] {
  const found = new Map<string, NamedTypeMatch>()
  const seen = new Set<ts.Type>()
  const visit = (type: ts.Type, path: string, depth: number) => {
    if (depth > MAX_DEPTH || seen.has(type)) return
    seen.add(type)
    const name = nonNullishMembers(type).some(isObjectType) ? match(type) : undefined
    if (name) {
      if (!found.has(name)) found.set(name, { path: path || "(root)", name })
      return
    }
    if (type.isUnion()) return nonNullishMembers(type).forEach((member) => visit(member, path, depth))
    if (!isObjectType(type) || isOpaque(checker, type)) return
    const parts = containerParts(checker, type)
    if (parts) return parts.forEach((part) => visit(part.type, `${path}${part.label}`, depth + 1))
    if (type.isIntersection()) return type.types.forEach((part) => visit(part, path, depth))
    for (const prop of dataProperties(checker, type)) {
      visit(checker.getTypeOfSymbol(prop), path ? `${path}.${prop.getName()}` : prop.getName(), depth + 1)
    }
  }
  visit(root, "", 0)
  return [...found.values()]
}

export type ExcessProperties = { path: string; extra: string[] }

/**
 * Fields `actual` carries that `expected` does not declare, recursively. TypeScript only rejects these on fresh
 * object literals, but anything serialized (island props, action results) sends them anyway. Untyped (`any` or
 * `unknown`) positions in `expected` have no declared fields to compare against; `onUntyped` receives what reaches them.
 */
export function findExcessProperties(
  checker: ts.TypeChecker,
  actual: ts.Type,
  expected: ts.Type,
  {
    ignorePrimitiveExtrasAtRoot = false,
    onUntyped,
  }: { ignorePrimitiveExtrasAtRoot?: boolean; onUntyped?: (path: string, actual: ts.Type) => void } = {},
): ExcessProperties[] {
  const found = new Map<string, ExcessProperties>()
  const seen = new Set<string>()
  const visit = (actualType: ts.Type, expectedType: ts.Type, path: string, depth: number) => {
    if (depth > MAX_DEPTH) return
    const expectedMembers = nonNullishMembers(expectedType)
    if (expectedMembers.length === 0 || expectedMembers.some(isUntyped)) {
      if (nonNullishMembers(actualType).some(isObjectType)) onUntyped?.(path || "(root)", actualType)
      return
    }
    const expectedObjects = expectedMembers.filter((t) => isObjectType(t) && !isOpaque(checker, t))
    if (expectedObjects.length === 0) return

    for (const actualMember of nonNullishMembers(actualType)) {
      if (!isObjectType(actualMember) || isOpaque(checker, actualMember)) continue
      const pairKey = `${(actualMember as { id?: number }).id}:${(expectedType as { id?: number }).id}`
      if (seen.has(pairKey)) continue
      seen.add(pairKey)

      const actualParts = containerParts(checker, actualMember)
      if (actualParts) {
        const expectedParts = expectedObjects.map((t) => containerParts(checker, t)).find((parts) => !!parts)
        for (const part of actualParts) {
          const expectedPart = expectedParts?.find((p) => p.label === part.label)
          if (expectedPart) visit(part.type, expectedPart.type, `${path}${part.label}`, depth + 1)
        }
        continue
      }

      const indexType = expectedObjects.map((t) => checker.getIndexTypeOfType(t, ts.IndexKind.String)).find((t) => !!t)
      const extra = new Set(found.get(path || "(root)")?.extra)
      for (const prop of dataProperties(checker, actualMember)) {
        const name = prop.getName()
        const propType = checker.getTypeOfSymbol(prop)
        const expectedProp = expectedObjects.map((t) => t.getProperty(name)).find((p) => !!p)
        const nextExpected = expectedProp ? checker.getTypeOfSymbol(expectedProp) : indexType
        if (nextExpected) visit(propType, nextExpected, path ? `${path}.${name}` : name, depth + 1)
        else if (!(ignorePrimitiveExtrasAtRoot && depth === 0 && !nonNullishMembers(propType).some(isObjectType)))
          extra.add(name)
      }
      if (extra.size > 0) found.set(path || "(root)", { path: path || "(root)", extra: [...extra].sort() })
    }
  }
  visit(actual, expected, "", 0)
  return [...found.values()]
}
