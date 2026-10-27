// The page chrome a person sets: the theme, and whether the sidebar is collapsed. Each choice is kept in localStorage
// and set on the root element from the <head>, before the page first paints, so a page never flashes the other one.
// Without a choice, the theme follows the system and the sidebar is expanded.
const root = document.documentElement
const THEME = 'caffeine-devtools:theme'
const SIDEBAR = 'caffeine-devtools:sidebar'

// Storage can be refused, in a private window or with site data blocked: the choice then lasts for the page alone.
function load(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function keep(key, value) {
  try {
    localStorage.setItem(key, value)
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
// Without a choice the theme follows the system, and so does what the theme switch says it does.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', describe)
