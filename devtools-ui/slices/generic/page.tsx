import { Layout, type Nav } from '../../pages/layout.js'

/** A slice the UI has no page for, shown as the JSON it answered with. */
export function SlicePage(props: { nav: Nav; application: string; id: string; value: unknown }): JSX.Element {
  return (
    <Layout title={`${props.id} · ${props.application}`} nav={props.nav}>
      <h1 safe>{props.id}</h1>
      <p class="lead">This slice has no page of its own: here is what it answered with.</p>
      <pre safe>{JSON.stringify(props.value, null, 2)}</pre>
    </Layout>
  )
}
