import { Layout } from '../../util/html/Layout.js'

export interface DashboardRow {
  label: string
  value: string
}

/**
 * The post-sign-in profile page.
 *
 * Every interpolation here is marked `safe`: the values are a GitHub display name, an email and an avatar URL,
 * all of them whatever the account's owner typed into their profile. `@kitajs/html` escapes nothing by default,
 * which is the one thing to remember when reading JSX rather than a template language that escapes for you.
 */
export function Dashboard(props: { name: string; avatar?: string; rows: DashboardRow[] }): JSX.Element {
  return (
    <Layout title="Petstore — Signed in">
      {props.avatar !== undefined && <img class="avatar" src={props.avatar} alt="" width="64" height="64" />}
      <h1>
        Welcome, <span safe>{props.name}</span> 👋
      </h1>
      <p class="lead">You are signed in to the Petstore API.</p>

      <table>
        {props.rows.map(row => (
          <tr>
            <th safe>{row.label}</th>
            <td safe>{row.value}</td>
          </tr>
        ))}
      </table>

      <div class="actions">
        <a class="btn" href="/me">
          View raw <code>/me</code> JSON
        </a>
        <form method="post" action="/logout">
          <button class="btn primary" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </Layout>
  )
}
