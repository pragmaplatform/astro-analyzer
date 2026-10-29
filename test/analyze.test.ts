import { convertToTSX } from "@astrojs/compiler/sync"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  analyze,
  defineRule,
  findElements,
  findIslands,
  IGNORE_DIRECTIVE,
  ignoreComment,
  toException,
  type AstroAnalyzerConfig,
  type Diagnostic,
} from "../src/index.js"

const cwd = fileURLToPath(new URL("./fixtures/basic", import.meta.url))
const offByDefault = { "astro/no-unsanitized-html": "off" } as const
const base: AstroAnalyzerConfig = {
  rules: {
    "astro/no-server-objects": ["error", { serverTypes: ["src/server/**"], allowTypes: ["DateRange"] }],
    ...offByDefault,
  },
}

/** An ignore comment in the wrong syntax compiles to rendered text or a syntax error instead of a comment. */
function expectDirectivesAreComments(source: string, file: string) {
  const compiled = convertToTSX(source, { filename: file, includeScripts: false, includeStyles: false })
  expect(compiled.diagnostics.filter((d) => d.severity === 1)).toEqual([])
  const tsx = ts.createSourceFile(file + ".tsx", compiled.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rendered: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isJsxText(node) || ts.isStringLiteral(node)) && node.text.includes(IGNORE_DIRECTIVE))
      rendered.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(tsx)
  expect(rendered).toEqual([])
}

const summarize = (diagnostics: Diagnostic[]) =>
  diagnostics.map((d) => `${d.rule} ${d.location.file}:${d.location.line} ${JSON.stringify(d.target)}`)

describe("analyze", () => {
  it("reports server objects and excess props reaching islands and actions, honoring ignore comments", async () => {
    const result = await analyze({ cwd, config: base })

    expect(summarize(result.diagnostics)).toEqual([
      `astro/no-server-objects src/actions/index.ts:5 {"action":"getUser"}`,
      `astro/no-server-objects src/actions/index.ts:10 {"action":"account.update"}`,
      `astro/no-server-objects src/lib/user-actions.ts:4 {"action":"rename"}`,
      `astro/no-excess-island-props src/pages/index.astro:14 {"component":"UserCard","prop":"user"}`,
      `astro/no-server-objects src/pages/index.astro:15 {"component":"UserProfile","prop":"user"}`,
      `astro/no-server-objects src/pages/index.astro:16 {"component":"Untyped","prop":"data"}`,
      `astro/no-server-objects src/pages/index.astro:22 {"component":"UserProfile","prop":"{...spread}"}`,
      `astro/no-server-objects src/pages/index.astro:23 {"component":"UserList","prop":"users"}`,
      `astro/no-server-objects src/pages/index.astro:24 {"component":"UserProfile","prop":"user"}`,
      `astro-analyzer/invalid-ignore src/pages/settings.astro:8 {}`,
      `astro/no-server-objects src/pages/settings.astro:9 {"component":"UserProfile","prop":"user"}`,
      `astro-analyzer/unused-exception src/pages/settings.astro:10 {}`,
      `astro/no-server-objects src/pages/settings.astro:15 {"component":"UserProfile","prop":"user"}`,
      `astro/no-server-objects src/pages/settings.astro:20 {"component":"UserProfile","prop":"user"}`,
    ])
    expect(summarize(result.suppressed)).toEqual([
      `astro/no-server-objects src/actions/index.ts:7 {"action":"getOwnUser"}`,
      `astro/no-server-objects src/pages/index.astro:19 {"component":"UserProfile","prop":"user"}`,
    ])
    const message = (line: number) => result.diagnostics.find((d) => d.location.line === line)?.message
    expect(message(14)).toContain("email, notes")
    expect(message(23)).toContain("User at <value>")
  })

  it("suggests ignore comments and exceptions that suppress the findings they were printed for", async () => {
    const copy = mkdtempSync(join(tmpdir(), "astro-analyzer-"))
    cpSync(cwd, copy, { recursive: true })
    try {
      const before = await analyze({ cwd: copy, config: base })
      const findings = before.diagnostics.filter((d) => !d.rule.startsWith("astro-analyzer/"))
      expect(findings.map((d) => d.location.commentStyle)).toEqual([
        ...["js", "js", "js"],
        ...["html", "html", "html", "html", "html", "html", "html"],
        "jsx",
        "js",
      ])

      const [viaConfig, ...viaComments] = findings
      for (const file of new Set(viaComments.map((d) => d.location.file))) {
        const diagnostics = viaComments.filter((d) => d.location.file === file)
        const lines = readFileSync(join(copy, file), "utf8").split("\n")
        for (const d of [...diagnostics].sort((a, b) => b.location.line - a.location.line)) {
          lines.splice(d.location.line - 1, 0, ignoreComment(d, "verified safe in a test"))
        }
        writeFileSync(join(copy, file), lines.join("\n"))
        if (file.endsWith(".astro")) expectDirectivesAreComments(lines.join("\n"), file)
      }
      const after = await analyze({
        cwd: copy,
        config: { ...base, exceptions: [toException(viaConfig!, "verified safe in a test")] },
      })

      expect(after.diagnostics.filter((d) => !d.rule.startsWith("astro-analyzer/"))).toEqual([])
      expect(after.suppressed).toHaveLength(before.suppressed.length + findings.length)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it("applies config exceptions, overrides and ignore globs, and flags exceptions that match nothing", async () => {
    const result = await analyze({
      cwd,
      config: {
        ...base,
        ignore: ["src/pages/settings.astro"],
        overrides: [{ files: ["src/actions/**", "src/lib/**"], rules: { "astro/no-server-objects": "off" } }],
        exceptions: [
          { rule: "astro/no-server-objects", file: "src/pages/index.astro", component: "Untyped", reason: "demo data" },
          { rule: "astro/no-server-objects", file: "src/pages/index.astro", component: "UserProfile", reason: "demo" },
          { rule: "astro/no-server-objects", file: "src/pages/settings.astro", reason: "the file is ignored anyway" },
          { rule: "astro/no-excess-island-props", file: "src/pages/gone.astro", reason: "file was deleted" },
        ],
      },
    })

    expect(summarize(result.diagnostics)).toEqual([
      `astro-analyzer/unused-exception src/pages/gone.astro:1 {}`,
      `astro/no-excess-island-props src/pages/index.astro:14 {"component":"UserCard","prop":"user"}`,
      `astro/no-server-objects src/pages/index.astro:23 {"component":"UserList","prop":"users"}`,
    ])
  })

  it("runs plugin rules built on the shared island helpers", async () => {
    const noClientLoad = defineRule({
      meta: {
        name: "no-client-load",
        description: "Prefer lazier directives",
        defaultSeverity: "warn",
        target: ["component"],
      },
      check: ({ project }) =>
        findIslands(project)
          .filter((island) => island.directive === "client:load")
          .map((island) => ({
            location: island.location,
            target: { component: island.component },
            message: "client:load",
          })),
    })
    const result = await analyze({
      cwd,
      config: {
        plugins: [{ name: "acme", rules: [noClientLoad] }],
        rules: { "astro/no-server-objects": "off", "astro/no-excess-island-props": "off", ...offByDefault },
        ignore: ["src/pages/settings.astro"],
      },
    })

    expect(summarize(result.diagnostics)).toEqual([
      `acme/no-client-load src/pages/index.astro:14 {"component":"UserCard"}`,
      `acme/no-client-load src/pages/index.astro:19 {"component":"UserProfile"}`,
      `acme/no-client-load src/pages/index.astro:20 {"component":"UserCard"}`,
      `acme/no-client-load src/pages/index.astro:22 {"component":"UserProfile"}`,
      `acme/no-client-load src/pages/index.astro:23 {"component":"UserList"}`,
      `acme/no-client-load src/pages/index.astro:24 {"component":"UserProfile"}`,
    ])
    expect(result.warningCount).toBe(6)
  })

  it("rejects config mistakes before analyzing", async () => {
    await expect(analyze({ cwd, config: { rules: { "astro/nope": "error" } } })).rejects.toThrow(
      'Unknown rule "astro/nope"',
    )
    await expect(
      analyze({
        cwd,
        config: { exceptions: [{ rule: "astro/no-excess-island-props", file: "x.astro", action: "y", reason: "r" }] },
      }),
    ).rejects.toThrow('unexpected "action"')
    await expect(
      analyze({ cwd, config: { rules: { "astro/no-server-objects": ["error", { serverType: [] }] } } }),
    ).rejects.toThrow('unknown option "serverType"')
    await expect(
      analyze({ cwd, config: { overrides: [{ files: ["src/**"] }] } as unknown as AstroAnalyzerConfig }),
    ).rejects.toThrow("overrides[0].rules must be an object")
    await expect(
      analyze({ cwd, config: { requireIgnoreReason: "false" } as unknown as AstroAnalyzerConfig }),
    ).rejects.toThrow("requireIgnoreReason must be true or false")
    const optionless = defineRule({
      meta: { name: "optionless", description: "", defaultSeverity: "warn", target: [] },
      check: () => [],
    })
    await expect(
      analyze({
        cwd,
        config: { plugins: [{ name: "acme", rules: [optionless] }], rules: { "acme/optionless": ["warn", { x: 1 }] } },
      }),
    ).rejects.toThrow("this rule takes no options")
  })

  it("flags injected HTML that isn't constant or sanitized", async () => {
    const result = await analyze({
      cwd,
      config: {
        rules: {
          "astro/no-server-objects": "off",
          "astro/no-excess-island-props": "off",
          "astro/no-unsanitized-html": [
            "error",
            { sanitizers: ["clean"], safeTypes: ["SafeHtml"], trustedModules: ["../lib/icons"] },
          ],
        },
        ignore: ["src/pages/settings.astro", "src/pages/index.astro"],
      },
    })

    expect(summarize(result.diagnostics)).toEqual([
      `astro/no-unsanitized-html src/components/RawHtml.tsx:5 {"element":"div","value":"props.html"}`,
      `astro/no-unsanitized-html src/components/RawHtml.tsx:6 {"element":"span","value":"props.html"}`,
      `astro/no-unsanitized-html src/components/RawHtml.tsx:8 {"element":"b","value":"__html"}`,
      `astro/no-unsanitized-html src/components/RawHtml.tsx:9 {"element":"i","value":"props.html"}`,
      `astro/no-unsanitized-html src/components/RawHtml.tsx:10 {"element":"u","value":"props.wrapped"}`,
      `astro/no-unsanitized-html src/pages/html.astro:16 {"element":"div","value":"body"}`,
      'astro/no-unsanitized-html src/pages/html.astro:17 {"element":"div","value":"`<p>${body}</p>`"}',
    ])
  })

  it("finds every element, including server:defer islands, with the component file its import resolves to", async () => {
    const deferred = defineRule({
      meta: { name: "deferred", description: "", defaultSeverity: "warn", target: ["component"] },
      check: ({ project }) =>
        findElements(project)
          .filter((element) => element.attributes.has("server:defer"))
          .map((element) => ({
            location: element.location,
            target: { component: element.tagName },
            message: [
              element.component?.importedName,
              element.component?.astroFile && project.rel(element.component.astroFile.path),
            ]
              .filter(Boolean)
              .join(" "),
          })),
    })
    const result = await analyze({
      cwd,
      config: {
        plugins: [{ name: "acme", rules: [deferred] }],
        rules: { "astro/no-server-objects": "off", "astro/no-excess-island-props": "off", ...offByDefault },
        ignore: ["src/pages/settings.astro"],
      },
    })

    expect(result.diagnostics.map((d) => `${d.location.file}:${d.location.line} ${d.message}`)).toEqual([
      "src/pages/html.astro:18 default src/components/Panel.astro",
      "src/pages/index.astro:17 UserProfile",
    ])
  })

  it.skipIf(!(process.features as { typescript?: unknown }).typescript)(
    "loads a TypeScript config that imports local TypeScript rules",
    async () => {
      const copy = mkdtempSync(join(tmpdir(), "astro-analyzer-"))
      cpSync(cwd, copy, { recursive: true })
      try {
        writeFileSync(
          join(copy, "local-rule.ts"),
          [
            'import type { Rule } from "astro-analyzer"',
            "",
            "export const marker: Rule = {",
            '  meta: { name: "marker", description: "", defaultSeverity: "error", target: [] },',
            '  check: () => [{ location: { file: "src/pages/index.astro", line: 1, column: 1 }, target: {}, message: "local" }],',
            "}",
          ].join("\n"),
        )
        writeFileSync(
          join(copy, "astro-analyzer.config.ts"),
          [
            'import type { AstroAnalyzerConfig } from "astro-analyzer"',
            'import { marker } from "./local-rule.ts"',
            "",
            "const config: AstroAnalyzerConfig = {",
            '  plugins: [{ name: "local", rules: [marker] }],',
            '  rules: { "astro/no-excess-island-props": "off", "astro/no-unsanitized-html": "off" },',
            "}",
            "export default config",
          ].join("\n"),
        )
        const result = await analyze({ cwd: copy })
        const local = result.diagnostics.filter((d) => d.rule.startsWith("local/"))
        expect(summarize(local)).toEqual(["local/marker src/pages/index.astro:1 {}"])
      } finally {
        rmSync(copy, { recursive: true, force: true })
      }
    },
  )

  it("warns when the project setup would hide every finding", async () => {
    const result = await analyze({ cwd, config: { ...base, srcDir: "app" } })
    expect(result.configWarnings).toContain('srcDir "app" does not exist, so no .astro files were analyzed')
  })
})
