export function UserCard(props: { user: { id: number; name: string } }) {
  return props.user.name
}
