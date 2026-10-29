import type { Plugin } from "../types.js"
import { noExcessIslandProps } from "./no-excess-island-props.js"
import { noServerObjects } from "./no-server-objects.js"
import { noUnsanitizedHtml } from "./no-unsanitized-html.js"

export { noExcessIslandProps, noServerObjects, noUnsanitizedHtml }

export const builtinPlugin: Plugin = {
  name: "astro",
  rules: [noServerObjects, noExcessIslandProps, noUnsanitizedHtml],
}
