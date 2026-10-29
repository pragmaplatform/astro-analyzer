export const IGNORE_DIRECTIVE = "astro-analyzer-ignore-next-line"

export type IgnoreDirective = {
  /** 1-based line of the comment; it covers findings on the next line. */
  line: number
  /** Rule ids it covers; empty covers every rule. */
  rules: string[]
  reason: string | undefined
}

const DIRECTIVE = new RegExp(`(?://|/\\*|<!--)\\s*${IGNORE_DIRECTIVE}\\b(.*)$`)
const COMMENT_END = /\s*(?:-->|\*\/\s*\}?)\s*$/

/**
 * Finds `astro-analyzer-ignore-next-line` comments in any comment syntax a file can hold:
 * `<!-- -->` in `.astro` templates, `{/* *\/}` in JSX, `//` and `/* *\/` in scripts and frontmatter.
 *
 *   <!-- astro-analyzer-ignore-next-line astro/no-server-objects -- the viewer's own record -->
 */
export function parseIgnoreDirectives(source: string): IgnoreDirective[] {
  const directives: IgnoreDirective[] = []
  source.split(/\r?\n/).forEach((text, index) => {
    const match = DIRECTIVE.exec(text)
    if (!match) return
    const body = (match[1] ?? "").replace(COMMENT_END, "")
    const separator = body.search(/(?:^|\s)--(?:\s|$)/)
    const rulesPart = separator === -1 ? body : body.slice(0, separator)
    const reason =
      separator === -1
        ? undefined
        : body
            .slice(separator)
            .replace(/^\s*--\s*/, "")
            .trim() || undefined
    directives.push({
      line: index + 1,
      rules: rulesPart.split(/[\s,]+/).filter(Boolean),
      reason,
    })
  })
  return directives
}
