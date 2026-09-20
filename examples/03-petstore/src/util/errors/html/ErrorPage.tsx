import { Layout } from '../../html/Layout.js'

export interface ErrorPageField {
  field: string
  message: string
}

/**
 * The error page a browser gets instead of the JSON body an API client gets.
 *
 * `safe` throughout: the message and the field names come from a thrown error and from the request's own body,
 * so neither is this application's text.
 */
export function ErrorPage(props: {
  status: number
  code: string
  message: string
  errors?: ErrorPageField[]
}): JSX.Element {
  return (
    <Layout title={`Error ${props.status}`}>
      <h1>Error {props.status}</h1>
      <p class="lead">
        <code safe>{props.code}</code>
      </p>
      <p class="err-message" safe>
        {props.message}
      </p>
      {props.errors !== undefined && props.errors.length > 0 && (
        <ul class="err-fields">
          {props.errors.map(error => (
            <li>
              <code safe>{error.field}</code>: <span safe>{error.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p>
        <a class="btn github" href="/">
          Back home
        </a>
      </p>
    </Layout>
  )
}
