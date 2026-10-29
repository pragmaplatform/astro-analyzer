export function RawHtml(props: { html: string; wrapped: { __html: string } }) {
  const __html = props.html
  return (
    <div>
      <div innerHTML={props.html} />
      <span dangerouslySetInnerHTML={{ __html: props.html }} />
      <p innerHTML={"<b>constant</b>"} />
      <b dangerouslySetInnerHTML={{ __html }} />
      <i dangerouslySetInnerHTML={{ __html: props.html }} />
      <u dangerouslySetInnerHTML={props.wrapped} />
    </div>
  )
}
