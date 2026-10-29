import type { User } from "../server/models"

function defineAction<T>(options: { handler: () => Promise<T> }) {
  return options
}

export const notAnAction = defineAction({ handler: async () => ({}) as User })
