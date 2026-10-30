// The page chrome a person sets: the theme, and whether the sidebar is collapsed. Each choice is kept in localStorage
// and set on the root element from the <head>, before the page first paints, so a page never flashes the other one.
// Without a choice, the theme follows the system and the sidebar is expanded.
const root = document.documentElement
const THEME = 'caffeine-devtools:theme'
const SIDEBAR = 'caffeine-devtools:sidebar'

// Storage can be refused, in a private window or with site data blocked: the choice then lasts for the page alone.
// Even naming the storage can throw then, so it is read inside the try.
function load(key, area = 'localStorage') {
  try {
    return globalThis[area].getItem(key)
  } catch {
    return null
  }
}

function keep(key, value, area = 'localStorage') {
  try {
    globalThis[area].setItem(key, value)
  } catch {
    // Refused: see load.
  }
}

const chosen = load(THEME)
if (chosen === 'light' || chosen === 'dark') {
  root.dataset.theme = chosen
}

if (load(SIDEBAR) === 'collapsed') {
  root.dataset.sidebar = 'collapsed'
}

function dark() {
  return root.dataset.theme === undefined
    ? matchMedia('(prefers-color-scheme: dark)').matches
    : root.dataset.theme === 'dark'
}

function collapsed() {
  return root.dataset.sidebar === 'collapsed'
}

// Each switch says what pressing it does next.
function describe() {
  const theme = dark() ? 'Switch to the light theme' : 'Switch to the dark theme'
  const sidebar = collapsed() ? 'Expand the sidebar' : 'Collapse the sidebar'

  for (const button of document.querySelectorAll('[data-action="theme"]')) {
    button.title = theme
    button.setAttribute('aria-label', theme)
  }

  for (const button of document.querySelectorAll('[data-action="sidebar"]')) {
    button.title = sidebar
    button.setAttribute('aria-expanded', String(!collapsed()))
  }
}

function switchTheme() {
  root.dataset.theme = dark() ? 'light' : 'dark'
  keep(THEME, root.dataset.theme)
}

function switchSidebar() {
  if (collapsed()) {
    delete root.dataset.sidebar
  } else {
    root.dataset.sidebar = 'collapsed'
  }
  keep(SIDEBAR, collapsed() ? 'collapsed' : 'expanded')
}

// This runs before the body is parsed: one listener on the document serves the switches the body will hold.
const actions = new Map([
  ['theme', switchTheme],
  ['sidebar', switchSidebar],
])

document.addEventListener('click', event => {
  const action = actions.get(event.target.closest('[data-action]')?.dataset.action)

  if (action !== undefined) {
    action()
    describe()
  }
})

document.addEventListener('DOMContentLoaded', describe)
document.addEventListener('DOMContentLoaded', showStars)
// Without a choice the theme follows the system, and so does what the theme switch says it does.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', describe)

// The star count of the repository the header links to. GitHub allows a browser 60 unauthenticated requests an hour,
// so the count is fetched once a session. Offline, or when GitHub refuses or takes more than a few seconds, the count
// the page was served with stays.
const STARS = 'caffeine-devtools:github-stars'
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

async function fetchStars() {
  const response = await fetch('https://api.github.com/repos/caffeinejs/caffeine', {
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`)
  }

  const count = (await response.json()).stargazers_count
  if (!Number.isInteger(count)) {
    throw new TypeError('GitHub sent no star count')
  }

  keep(STARS, String(count), 'sessionStorage')
  return count
}

async function showStars() {
  const shown = document.querySelectorAll('[data-github-stars]')
  if (shown.length === 0) {
    return
  }

  try {
    const cached = Number.parseInt(load(STARS, 'sessionStorage') ?? '', 10)
    const count = Number.isInteger(cached) ? cached : await fetchStars()

    for (const element of shown) {
      element.textContent = compact.format(count)
    }
  } catch {
    // Offline, refused or too slow: see above.
  }
}
