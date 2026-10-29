import picomatch from "picomatch"
import type ts from "typescript"
import { findActions, findIslands } from "../astro.js"
import { assertKnownOptions, booleanOption, stringArrayOption } from "../options.js"
import { declarationFile, findExcessProperties, findNamedTypes, type NamedTypeMatch } from "../type-utils.js"
import type { Finding, Project, Rule } from "../types.js"

/** Utility types that keep every field of the type they wrap, so they leak as much as the type itself. */
const WHOLE_TYPE_WRAPPERS = new Set(["Omit", "Partial", "Required", "Readonly", "NonNullable"])

export type NoServerObjectsOptions = {
  /** Globs (relative to the project root) of the files that declare server-only types, such as a generated API SDK. */
  serverTypes: string[]
  /** Type names from those files that are plain values and safe to send, such as a date range. */
  allowTypes: string[]
  /** Also check what actions return. */
  actions: boolean
}

function serverTypeMatcher(project: Project, options: NoServerObjectsOptions) {
  const isServerFile = picomatch(options.serverTypes)
  const allowed = new Set(options.allowTypes)
  const fromServerFile = (symbol: ts.Symbol | undefined) => {
    const file = declarationFile(symbol)
    return !!file && isServerFile(project.rel(file))
  }
  const unlessAllowed = (typeName: string) => (allowed.has(typeName) ? undefined : typeName)
  return function name(type: ts.Type): string | undefined {
    if (type.aliasSymbol && fromServerFile(type.aliasSymbol)) return unlessAllowed(type.aliasSymbol.getName())
    if (type.aliasSymbol && WHOLE_TYPE_WRAPPERS.has(type.aliasSymbol.getName())) {
      const inner = type.aliasTypeArguments?.[0]
      const innerName = inner && name(inner)
      if (innerName) return `${type.aliasSymbol.getName()}<${innerName}>`
    }
    const symbol = type.getSymbol()
    const isDeclaration = symbol && symbol.getName() !== "__type" && symbol.getName() !== "__object"
    return isDeclaration && fromServerFile(symbol) ? unlessAllowed(symbol.getName()) : undefined
  }
}

const joinPath = (base: string, path: string) =>
  path === "(root)" ? base : base === "(root)" ? path : `${base}.${path}`

const describe = (matches: NamedTypeMatch[]) =>
  matches.map((m) => (m.path === "(root)" ? m.name : `${m.name} at ${m.path}`)).join(", ")

export const noServerObjects: Rule<NoServerObjectsOptions> = {
  meta: {
    name: "no-server-objects",
    description: "Island props and action results must not carry server-only types; Astro serializes every field.",
    docs: "https://github.com/pragmaplatform/astro-analyzer/blob/main/docs/rules/no-server-objects.md",
    hint: "pass a view type with only the fields the browser needs, built on the server from the full object.",
    defaultSeverity: "error",
    target: ["component", "prop", "action"],
  },
  parseOptions(raw) {
    assertKnownOptions(raw, ["serverTypes", "allowTypes", "actions"])
    return {
      serverTypes: stringArrayOption(raw, "serverTypes"),
      allowTypes: stringArrayOption(raw, "allowTypes"),
      actions: booleanOption(raw, "actions", true),
    }
  },
  configWarnings: (options) =>
    options.serverTypes.length === 0
      ? ['astro/no-server-objects has no "serverTypes" configured, so it can only report nothing']
      : [],
  check({ project, options }) {
    if (options.serverTypes.length === 0) return []
    const { checker } = project
    const match = serverTypeMatcher(project, options)
    const findings: Finding[] = []

    for (const island of findIslands(project)) {
      for (const prop of island.props) {
        const target = { component: island.component, prop: prop.name }
        if (prop.spread) {
          const spread = findNamedTypes(checker, prop.actual, match)
          if (spread.length === 0) continue
          findings.push({
            location: island.location,
            target,
            message: `<${island.component}> receives ${describe(spread)} through a spread; every field is serialized into the page`,
          })
          continue
        }
        const matches = prop.declared ? findNamedTypes(checker, prop.declared, match) : []
        const untyped: NamedTypeMatch[] = []
        const onUntyped = (path: string, actual: ts.Type) => {
          for (const m of findNamedTypes(checker, actual, match))
            untyped.push({ name: m.name, path: joinPath(path, m.path) })
        }
        if (prop.declared) findExcessProperties(checker, prop.actual, prop.declared, { onUntyped })
        else onUntyped("(root)", prop.actual)

        const parts = [
          matches.length > 0 && `is typed with ${describe(matches)}`,
          untyped.length > 0 && `passes ${describe(untyped)} into an untyped prop`,
        ].filter(Boolean)
        if (parts.length === 0) continue
        findings.push({
          location: island.location,
          target,
          message: `<${island.component}> prop "${prop.name}" ${parts.join(" and ")}; every field is serialized into the page`,
        })
      }
    }

    if (options.actions) {
      for (const action of findActions(project)) {
        const matches = findNamedTypes(checker, action.returnType, match)
        if (matches.length === 0) continue
        findings.push({
          location: action.location,
          target: { action: action.name },
          message: `Action "${action.name}" returns ${describe(matches)}; every field is sent to the browser`,
        })
      }
    }
    return findings
  },
}
