import { useCallback, useState } from 'react'

import { Layout } from './components/layout/Layout.js'
import { Navbar } from './components/layout/Navbar.js'
import { Sidebar } from './components/layout/Sidebar.js'
import { useTheme } from './hooks/useTheme.js'
import type { Tab } from './types.js'
import { Bindings } from './views/Bindings.js'
import { Events } from './views/Events.js'
import { Routes } from './views/Routes.js'
import { useDevtoolsWs } from './ws/client.js'
import type { BindingSnapshot, DevtoolsEvent, RouteSnapshot, WsMessage } from './ws/protocol.js'

export function App() {
  const [tab, setTab] = useState<Tab>('bindings')
  const [bindings, setBindings] = useState<BindingSnapshot[]>([])
  const [routes, setRoutes] = useState<RouteSnapshot[]>([])
  const [events, setEvents] = useState<DevtoolsEvent[]>([])

  const onMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'snapshot') {
      setBindings(msg.bindings)
      setRoutes(msg.routes)
      setEvents(msg.events)
    } else {
      setEvents(prev => {
        const next = [...prev, msg.event]
        return next.length > 500 ? next.slice(-500) : next
      })
    }
  }, [])

  const connected = useDevtoolsWs(onMessage)
  const { theme, toggle } = useTheme()
  const visibleBindings = bindings.filter(b => !b.internal)

  return (
    <Layout
      sidebar={
        <Sidebar
          tab={tab}
          onTab={setTab}
          connected={connected}
          counts={{
            bindings: visibleBindings.length,
            routes: routes.length,
            events: events.length,
          }}
        />
      }
      navbar={<Navbar theme={theme} onToggle={toggle} />}
    >
      {tab === 'bindings' && <Bindings bindings={bindings} />}
      {tab === 'routes' && <Routes routes={routes} />}
      {tab === 'events' && <Events events={events} />}
    </Layout>
  )
}
