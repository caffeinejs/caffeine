import { createHash } from 'node:crypto'

/** The UI's one stylesheet. Light and dark follow the browser's preference. */
export const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f8;
  --panel: #ffffff;
  --text: #1d1d20;
  --muted: #64646e;
  --line: #e2e2e6;
  --accent: #8a4b14;
  --ok: #17803d;
  --warn: #9a6700;
  --bad: #c0262d;
  --code: #f0f0f2;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141416;
    --panel: #1c1c1f;
    --text: #e7e7ea;
    --muted: #9b9ba5;
    --line: #2e2e33;
    --accent: #e0a066;
    --ok: #4cc27a;
    --warn: #d9a83e;
    --bad: #f0686e;
    --code: #232327;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

header .brand { font-weight: 600; color: var(--text); }

.shell { display: flex; min-height: calc(100vh - 49px); }

nav {
  width: 220px;
  flex-shrink: 0;
  padding: 16px;
  border-right: 1px solid var(--line);
  background: var(--panel);
}

nav h2 {
  margin: 16px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

nav h2:first-child { margin-top: 0; }
nav ul { list-style: none; margin: 0; padding: 0; }
nav li a { display: block; padding: 3px 8px; border-radius: 4px; color: var(--text); }
nav li a.active { background: var(--code); font-weight: 600; }

main { flex: 1; min-width: 0; padding: 24px; }

h1 { margin: 0 0 4px; font-size: 20px; }
h2 { margin: 24px 0 8px; font-size: 15px; }

.lead { margin: 0 0 16px; color: var(--muted); }

table {
  width: 100%;
  border-collapse: collapse;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
}

th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { font-size: 12px; font-weight: 600; color: var(--muted); }
tr:last-child td { border-bottom: 0; }

code, pre {
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--code);
  border-radius: 4px;
}

code { padding: 1px 4px; }
pre { margin: 0; padding: 12px; overflow: auto; }

dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; }

.badge {
  display: inline-block;
  padding: 0 6px;
  border: 1px solid currentColor;
  border-radius: 10px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

.ok { color: var(--ok); }
.warn { color: var(--warn); }
.bad { color: var(--bad); }
.muted { color: var(--muted); }

form.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 12px; }
form.filters input[type="search"] {
  min-width: 260px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text);
}

button {
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
}

details { margin-top: 16px; }
summary { cursor: pointer; color: var(--accent); }
.adjacency li { margin: 2px 0; }
.problem { padding: 16px; border: 1px solid var(--bad); border-radius: 6px; background: var(--panel); }
`

/** Where the stylesheet is served: the name changes with the content, so a browser may keep it forever. */
export const STYLE_PATH = `/_ui/style.${createHash('sha256').update(STYLE).digest('hex').slice(0, 10)}.css`
