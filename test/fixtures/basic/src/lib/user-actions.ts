import { defineAction as action } from "astro:actions"
import type { User } from "../server/models"

export const rename = action({ handler: async () => ({}) as User })
