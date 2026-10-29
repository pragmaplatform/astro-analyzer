import { defineAction } from "astro:actions"
import type { User } from "../server/models"

export const server = {
  getUser: defineAction({ handler: async () => ({}) as User }),
  // astro-analyzer-ignore-next-line astro/no-server-objects -- returns the caller's own record
  getOwnUser: defineAction({ handler: async () => ({}) as User }),
  getName: defineAction({ handler: async () => ({ name: "x" }) }),
  account: {
    update: defineAction({ handler: async () => ({}) as User }),
  },
}
