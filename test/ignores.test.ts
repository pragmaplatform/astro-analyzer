import { describe, expect, it } from "vitest"
import { parseIgnoreDirectives } from "../src/ignores.js"

describe("parseIgnoreDirectives", () => {
  it("reads rules and reasons from every comment syntax an Astro project uses", () => {
    const source = [
      "<!-- astro-analyzer-ignore-next-line astro/no-server-objects -- the viewer's own record -->",
      "{/* astro-analyzer-ignore-next-line astro/a, astro/b -- two rules */}",
      "// astro-analyzer-ignore-next-line astro/no-server-objects",
      "/* astro-analyzer-ignore-next-line -- every rule */",
      "const x = 1 // not-a-directive astro-analyzer-ignore",
    ].join("\n")

    expect(parseIgnoreDirectives(source)).toEqual([
      { line: 1, rules: ["astro/no-server-objects"], reason: "the viewer's own record" },
      { line: 2, rules: ["astro/a", "astro/b"], reason: "two rules" },
      { line: 3, rules: ["astro/no-server-objects"], reason: undefined },
      { line: 4, rules: [], reason: "every rule" },
    ])
  })
})
