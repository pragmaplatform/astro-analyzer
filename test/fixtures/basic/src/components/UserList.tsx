import type { User } from "../server/models"

export function UserList(props: { users: Map<string, User> }) {
  return props.users.size
}
