// Draws every `<pre class="mermaid">` on the page. Strict: a label is text, never markup or a link.
globalThis.mermaid?.initialize({
  startOnLoad: true,
  securityLevel: 'strict',
  maxTextSize: 2_000_000,
  maxEdges: 20_000,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
  flowchart: { htmlLabels: false },
})
