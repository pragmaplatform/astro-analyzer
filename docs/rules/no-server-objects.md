# astro/no-server-objects

Island props and Astro Action results must not carry server-only types.

## Why

Astro serializes every field of every `client:*` island prop into the page HTML, and sends every field of an action's result to the browser. A server object (a database row, an API response, an SDK model) usually holds more than the browser needs: internal notes, other users' details, API keys and tokens, configuration. Passing it whole publishes all of it in the page source, whatever the component renders.

## What it reports

With `serverTypes` set to the files that declare server-only types, the rule reports:

- an island prop whose declared type contains one of those types, anywhere in its shape (`items[].owner`, `settings.config`, `byId<value>` for a `Map`, ...)
- an untyped (`any` or `unknown`) island prop, or untyped position inside one, that receives one of those types
- an island spread (`{...props}`) whose value contains one of those types
- an action whose handler resolves to a value containing one of those types

`Omit<T>`, `Partial<T>`, `Required<T>`, `Readonly<T>` and `NonNullable<T>` of a server type count as the type itself: they keep every field the server adds later. An explicit `Pick<T, ...>` or a type you declare yourself does not. `server:defer` islands are skipped because Astro encrypts their props.

## Options

| Option        | Default | Description                                                                                                |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `serverTypes` | `[]`    | Globs, relative to the project root, of the files that declare server-only types. Required.                |
| `allowTypes`  | `[]`    | Names of types from those files that are plain values (a date range, a pagination cursor) and safe to send |
| `actions`     | `true`  | Also check action results                                                                                  |

```js
"astro/no-server-objects": ["error", { serverTypes: ["src/server/**"], allowTypes: ["DateRange"] }]
```

Point `serverTypes` at whatever declares your server data: your own server or database modules (`src/server/**`, `src/db/**`), a generated API client's output directory, or an ORM's generated types. Globs match the path TypeScript resolves the declaration to, relative to the project root: package managers that symlink `node_modules` (such as pnpm) resolve to the real path under `node_modules/.pnpm/`, so for generated clients prefer a custom output directory inside your project (Prisma's `output` option, for example) or a glob starting with `**/`.

## How to fix

1. List the fields the component (or the action's caller) actually reads, including nested ones.
2. Declare a view type with only those fields, next to the code that loads the data.
3. Write a projection that builds the view from the server object field by field, and call it on the server. Type the island prop or the action's result as the view type.

```ts
export type UserCardView = { id: number; name: string; avatarUrl: string | null }

export const toUserCardView = (user: User): UserCardView => ({
  id: user.id,
  name: user.name,
  avatarUrl: user.avatar_url,
})
```

Copy fields explicitly. Spreading the object (`{ ...user, extra }`) or deriving the view with `Omit<User, ...>` brings back every field the server adds later. Filter on the server too: if some rows or nested items must not reach this viewer, drop them in the projection.

## When to make an exception

Only when the full value is safe for every viewer of that page or action, for example the signed-in user's own record or data that is already public. Say why in the exception's reason. See [Exceptions](../../README.md#exceptions).

## Limitations

The rule matches type names, so it follows what the type checker sees. A server object copied with `{ ...object }` or `Object.assign` into an anonymous type no longer carries its name, and a value typed `any` has no shape to inspect. When such a copy reaches an island whose prop type is narrower, [`no-excess-island-props`](no-excess-island-props.md) still reports the extra fields. Svelte and Vue components have no declared props here, so everything passed to them is checked as if the prop were untyped.
