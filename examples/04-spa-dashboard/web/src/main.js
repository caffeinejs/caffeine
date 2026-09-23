import './styles.css'

// The whole client: a History-API router, a session it learns from `/auth/me`, and `fetch` against the API.
// Plain JavaScript on purpose — the example is about the server, and a build step for the browser would
// otherwise need a second tsconfig that the server's type-check has to be told to ignore.
//
// Two things here are the client half of a server decision:
//
//   * the CSRF token is fetched from `/auth/csrf` and sent as `x-csrf-token` on every unsafe request. The
//     `_csrf` cookie holding the secret is HttpOnly, so the token cannot be read from `document.cookie` — it
//     has to come back in a body.
//   * a 401 from the API means the session went away underneath us, so the client goes to `/login`. It does
//     *not* try to guess: the server already redirected the navigation that brought us here.

const state = {
  csrf: '',
  user: null,
  error: '',
}

const routes = [
  { path: '/', render: home, title: 'Home' },
  { path: '/about', render: about, title: 'About' },
  { path: '/login', render: login, title: 'Sign in' },
  { path: '/forbidden', render: forbidden, title: 'Not allowed' },
  { path: '/dashboard', render: dashboard, title: 'Dashboard' },
  { path: '/projects', render: projects, title: 'Projects' },
  { path: '/admin', render: admin, title: 'Administration' },
]

async function api(path, options = {}) {
  const method = options.method ?? 'GET'
  const headers = { accept: 'application/json', ...options.headers }

  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-csrf-token'] = state.csrf
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
    }
  }

  // Same-origin, so the session cookie rides along without the client holding a token of its own.
  const res = await fetch(path, { ...options, method, headers, credentials: 'same-origin' })

  if (res.status === 401) {
    state.user = null
    go('/login')
    return null
  }

  return res
}

async function refreshCsrf() {
  const res = await fetch('/auth/csrf', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
  const body = await res.json()
  state.csrf = body.token
}

async function refreshUser() {
  const res = await fetch('/auth/me', { headers: { accept: 'application/json' }, credentials: 'same-origin' })
  state.user = res.ok ? await res.json() : null
}

function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )
}

function go(path) {
  if (path !== location.pathname) {
    history.pushState(null, '', path)
  }

  void render()
}

function chrome() {
  const links = [
    ['/', 'Home'],
    ['/about', 'About'],
    ['/dashboard', 'Dashboard'],
    ['/projects', 'Projects'],
    ['/admin', 'Admin'],
  ]
  const nav = links
    .map(([href, label]) => {
      const current = href === location.pathname ? ' aria-current="page"' : ''
      return `<a href="${href}"${current}>${label}</a>`
    })
    .join('')

  const session = state.user
    ? `<span class="hint">${escape(state.user.name)} (${escape(state.user.roles.join(', '))})</span>
       <button class="link" data-action="logout">Sign out</button>`
    : '<a href="/login">Sign in</a>'

  return `<header><strong>Caffeine SPA</strong><nav>${nav}</nav>${session}</header>`
}

function home() {
  return `<h1>A single-page application on Caffeine</h1>
    <p class="lede">Every page below is a route the application declared. Reload any of them — the server
    serves this same shell and the client routes from there.</p>
    <ul class="cards">
      <li><h2>Public</h2><p><code>/</code>, <code>/about</code>, <code>/login</code></p></li>
      <li><h2>Signed in</h2><p><code>/dashboard</code>, <code>/projects</code></p></li>
      <li><h2>Administrators</h2><p><code>/admin</code></p></li>
    </ul>`
}

function about() {
  return `<h1>About</h1>
    <p class="lede">The API lives under <code>/api</code> and is protected by the same session cookie this
    page uses. There is no token in JavaScript.</p>`
}

function forbidden() {
  return `<h1>Not allowed</h1>
    <p class="lede">You are signed in, but this page needs a role you do not have. The server sent you here
    because you navigated; an API call would have received a plain 403.</p>`
}

function login() {
  if (state.user) {
    return `<h1>Already signed in</h1><p class="lede">You are ${escape(state.user.name)}.</p>`
  }

  const error = state.error ? `<p class="error">${escape(state.error)}</p>` : ''

  return `<h1>Sign in</h1>
    ${error}
    <form data-action="login">
      <label>Username<input name="username" autocomplete="username" value="user" required /></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" value="user123" required /></label>
      <button type="submit">Sign in</button>
    </form>
    <p class="hint">Demo accounts: <code>admin</code>/<code>admin123</code> and <code>user</code>/<code>user123</code>.</p>`
}

async function dashboard() {
  const res = await api('/api/profile')
  if (!res) {
    return ''
  }

  const profile = await res.json()

  return `<h1>Dashboard</h1>
    <p class="lede">Read from <code>GET /api/profile</code> with the session cookie.</p>
    <table>
      <tr><th>Subject</th><td>${escape(profile.sub)}</td></tr>
      <tr><th>Name</th><td>${escape(profile.name)}</td></tr>
      <tr><th>Roles</th><td>${escape(profile.roles.join(', '))}</td></tr>
    </table>`
}

async function projects() {
  const res = await api('/api/projects')
  if (!res) {
    return ''
  }

  const body = await res.json()
  const items = body.projects
    .map(p => `<li><h2>${escape(p.name)}</h2><p>${escape(p.status)} · ${escape(p.owner)}</p></li>`)
    .join('')

  return `<h1>Projects</h1>
    <p class="lede">From the programmatic router at <code>/api/projects</code>.</p>
    <ul class="cards">${items}</ul>`
}

async function admin() {
  const res = await api('/api/admin/users')
  if (!res) {
    return ''
  }

  if (res.status === 403) {
    return forbidden()
  }

  const body = await res.json()
  const rows = body.users
    .map(u => `<tr><td>${escape(u.id)}</td><td>${escape(u.name)}</td><td>${escape(u.roles.join(', '))}</td></tr>`)
    .join('')

  return `<h1>Administration</h1>
    <p class="lede">From <code>GET /api/admin/users</code>, which needs the <code>admin</code> role.</p>
    <table><tr><th>ID</th><th>Name</th><th>Roles</th></tr>${rows}</table>`
}

function notFound() {
  return `<h1>Nothing here</h1>
    <p class="lede">No client route matches <code>${escape(location.pathname)}</code>.</p>
    <p><a href="/">Back home</a></p>`
}

async function render() {
  const route = routes.find(r => r.path === location.pathname)
  const body = route ? await route.render() : notFound()

  document.title = route ? `${route.title} · Caffeine SPA` : 'Not found · Caffeine SPA'
  document.getElementById('root').innerHTML = `${chrome()}<main>${body}</main>`
  state.error = ''
}

async function onLogin(form) {
  const data = new FormData(form)

  const res = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
  })

  if (!res) {
    return
  }

  const body = await res.json()

  if (!res.ok) {
    state.error = 'Those credentials were not accepted.'
    await render()
    return
  }

  // The server rotated the CSRF secret at the session boundary and handed back a token bound to the new one,
  // so the token in hand is stale and this is the replacement — no second round trip.
  state.csrf = body.csrfToken
  state.user = body.user

  const returnURL = new URLSearchParams(location.search).get('returnUrl')
  go(returnURL && returnURL.startsWith('/') && !returnURL.startsWith('//') ? returnURL : '/dashboard')
}

async function onLogout() {
  const res = await api('/auth/logout', { method: 'POST' })
  if (res) {
    state.csrf = (await res.json()).csrfToken
  }

  state.user = null
  go('/')
}

document.addEventListener('click', event => {
  const anchor = event.target.closest('a[href^="/"]')
  if (anchor && !anchor.hasAttribute('download') && anchor.target !== '_blank') {
    event.preventDefault()
    go(anchor.getAttribute('href'))
    return
  }

  if (event.target.closest('[data-action="logout"]')) {
    event.preventDefault()
    void onLogout()
  }
})

document.addEventListener('submit', event => {
  const form = event.target.closest('form[data-action="login"]')
  if (form) {
    event.preventDefault()
    void onLogin(form)
  }
})

addEventListener('popstate', () => void render())

async function start() {
  await refreshCsrf()
  await refreshUser()
  await render()
}

void start()
