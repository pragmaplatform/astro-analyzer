# astro/no-unsanitized-html

HTML injected with Astro's `set:html`, Solid's `innerHTML` or React's `dangerouslySetInnerHTML` must be constant or sanitized.

## Why

These attributes insert a string into the page as markup, unescaped. If any part of that string comes from a user, a CMS, a third-party API or a URL, it can carry `<script>` tags or event handlers that run in your visitors' browsers.

## What it reports

Every `set:html` in `.astro` templates, and every `innerHTML` or `dangerouslySetInnerHTML={{ __html }}` on an HTML element in `.tsx` and `.jsx` files, unless the value is safe. A value is safe when it is:

- a string literal, or has a string-literal type (`const html = isNew ? "<b>New</b>" : "<i>Old</i>"`)
- `null` or `undefined`, which inject nothing
- a default import from a `?raw` module (`import icon from "./icon.svg?raw"`), or any import, named or namespace (`icons.Home`), from one of `trustedModules` or a subpath of one
- the result of calling one of `sanitizers`
- of one of `safeTypes`, such as a branded type your sanitizer returns
- a `const` initialized with any of the above, in the same file or imported from another, a template literal whose interpolations are all safe, or a `??`, `||`, `+` or ternary of safe values

A value whose type is a union is of a safe type when every non-nullish member is, so an optional `html?: SafeHtml` prop passes. Everything else is reported, including props, function parameters, object properties, and `let` variables. A `dangerouslySetInnerHTML` value that isn't an object literal is reported as a whole unless its type is safe, since the rule can't see its `__html`. In `.astro` templates only `set:html` is checked; Astro renders `innerHTML` and `dangerouslySetInnerHTML` there as plain attributes.

## Options

| Option           | Default | Description                                                                                                |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `sanitizers`     | `[]`    | Functions whose result is safe HTML, by name (`xss`, `sanitizeHtml`) or dotted path (`DOMPurify.sanitize`) |
| `safeTypes`      | `[]`    | Type names that mark a value as sanitized, such as a branded `SafeHtml`                                    |
| `trustedModules` | `[]`    | Modules whose exports are trusted markup, such as an icon package that exports SVG strings                 |

```js
"astro/no-unsanitized-html": ["error", { sanitizers: ["DOMPurify.sanitize"], trustedModules: ["lucide-static"] }]
```

A sanitizer name also matches method calls ending in it, so `sanitizers: ["t"]` covers `t(...)` and `Astro.locals.t(...)`. Only list a translation function when your translations are trusted and interpolated values are escaped (i18next does both by default).

## How to fix

Sanitize the value on the server before injecting it, with one of your configured `sanitizers`. For values that should never contain markup, render them as text instead (`{value}` in a template). The strongest setup is a sanitizer that returns a branded type, listed in `safeTypes`:

```ts
export type SafeHtml = string & { readonly __safeHtml: true }
export const sanitize = (html: string) => DOMPurify.sanitize(html) as SafeHtml
```

A value of that type then passes the rule wherever it travels, through props and across files.

## Exceptions

Findings are identified by `element`, the tag name (`div`, `script`), and `value`, the source text of the injected expression with whitespace collapsed, cut to 57 characters plus `...` when longer. An exception with both covers that expression on that kind of element anywhere in the file; one with only `element` covers every injection on that tag in the file. Changing the injected expression changes its `value`, so the exception stops matching and the new code is checked again.

## When to make an exception

When the markup is trusted at its source, for example a script your server generates from constants, or JSON-LD built from your own content. JSON-LD deserves a second look: `JSON.stringify` doesn't escape `</script>`, so data that can contain user text needs `<` escaped. See [Exceptions](../../README.md#exceptions).

## Limitations

Values are traced through `const` declarations and imports, but not through function parameters, function results or component props, so a sanitized value passed as a prop is reported unless its type is one of `safeTypes`. Solid's `innerHTML` and React's `dangerouslySetInnerHTML` are only checked on HTML elements, not on components that forward them.
