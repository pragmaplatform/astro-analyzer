import { findIslands } from "../astro.js"
import { assertKnownOptions } from "../options.js"
import { findExcessProperties } from "../type-utils.js"
import type { Finding, Rule } from "../types.js"

export const noExcessIslandProps: Rule = {
  meta: {
    name: "no-excess-island-props",
    description: "Values passed to an island must not carry fields the component's props don't declare.",
    docs: "https://github.com/pragmaplatform/astro-analyzer/blob/main/docs/rules/no-excess-island-props.md",
    hint: "build an object with only the declared fields on the server and pass that instead of the whole value.",
    defaultSeverity: "error",
    target: ["component", "prop"],
  },
  parseOptions(raw) {
    assertKnownOptions(raw, [])
    return {}
  },
  check({ project }) {
    const findings: Finding[] = []
    for (const island of findIslands(project)) {
      for (const prop of island.props) {
        if (!prop.declared) continue
        const excess = findExcessProperties(project.checker, prop.actual, prop.declared, {
          ignorePrimitiveExtrasAtRoot: prop.spread,
        })
        if (excess.length === 0) continue
        const where = excess.map((e) => (e.path === "(root)" ? e.extra.join(", ") : `${e.path}: ${e.extra.join(", ")}`))
        findings.push({
          location: island.location,
          target: { component: island.component, prop: prop.name },
          message: `<${island.component}> prop "${prop.name}" passes undeclared fields (${where.join("; ")}); they are still serialized into the page`,
        })
      }
    }
    return findings
  },
}
