export type SafeHtml = string & { readonly safeHtml: true }

export const clean = (html: string) => html.replace(/</g, "&lt;")

export const brand = (html: string) => clean(html) as SafeHtml

export const CLEANED = clean("<b>imported</b>")
