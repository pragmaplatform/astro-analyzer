import type { DateRange, User } from "../server/models"

export function UserProfile(props: { user: User; range?: Partial<Readonly<DateRange>> }) {
  return props.user.name
}
