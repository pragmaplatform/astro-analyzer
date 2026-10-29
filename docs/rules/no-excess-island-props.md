# astro/no-excess-island-props

Values passed to an island must not carry fields the component's props don't declare.

## Why

TypeScript only rejects extra fields on object literals written inline. Pass a variable and it compiles as long as the variable has the declared fields:

```astro
---
const user = await getUser(id) // { id, name, email, notes, ... }
---
<UserCard user={user} client:load /> <!-- UserCard declares { id, name } -->
```

Astro serializes the value, not the declared type, so `email` and `notes` are in the page source even though `UserCard` never reads them.

## What it reports

Every field of a value passed to a `client:*` island that the component's prop type doesn't declare, checked recursively through nested objects, arrays, `Map`s and `Set`s. For a spread (`{...props}`), top-level primitive extras are allowed, since spreads commonly forward HTML attributes; nested objects are still checked. Untyped (`any` or `unknown`) props have nothing to compare against and are left to [`no-server-objects`](no-server-objects.md). `server:defer` islands are skipped.

The rule has no options.

## How to fix

Build an object with only the declared fields on the server, ideally with a projection function next to the code that loads the data, and pass that:

```astro
<UserCard user={{ id: user.id, name: user.name }} client:load />
```

## When to make an exception

Only when the extra fields are safe for every viewer of the page. See [Exceptions](../../README.md#exceptions).

## Limitations

The rule needs the component's declared props, which come from its first call signature: React, Preact and Solid function components. Svelte and Vue components and class components are skipped; [`no-server-objects`](no-server-objects.md) still checks what is passed to them.
