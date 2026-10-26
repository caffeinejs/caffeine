// The dependency graph Graphviz drew, made explorable: drag to move it, scroll to zoom, click a binding to keep only it,
// what it depends on and what depends on it, and click the background to show everything again. No library: the SVG is
// already on the page, and this only moves its viewBox and toggles classes.
for (const box of document.querySelectorAll('.di-graph')) {
  const svg = box.querySelector('svg')
  if (svg === null) {
    continue
  }

  // Sized by the box, not by the drawing: the viewBox is what zooms.
  svg.removeAttribute('width')
  svg.removeAttribute('height')

  const start = svg.viewBox.baseVal
  let view = { x: start.x, y: start.y, w: start.width, h: start.height }
  const show = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`)

  // The point under the cursor, in the drawing's own units.
  const at = event => {
    const rect = svg.getBoundingClientRect()
    return {
      x: view.x + ((event.clientX - rect.left) / rect.width) * view.w,
      y: view.y + ((event.clientY - rect.top) / rect.height) * view.h,
    }
  }

  box.addEventListener(
    'wheel',
    event => {
      event.preventDefault()
      const scale = event.deltaY < 0 ? 0.9 : 1 / 0.9
      const point = at(event)
      view = {
        x: point.x - (point.x - view.x) * scale,
        y: point.y - (point.y - view.y) * scale,
        w: view.w * scale,
        h: view.h * scale,
      }
      show()
    },
    { passive: false },
  )

  let drag
  let dragged = false

  box.addEventListener('pointerdown', event => {
    drag = { x: event.clientX, y: event.clientY, view: { ...view } }
    dragged = false
  })

  window.addEventListener('pointermove', event => {
    if (drag === undefined) {
      return
    }

    const rect = svg.getBoundingClientRect()
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    dragged ||= Math.abs(dx) + Math.abs(dy) > 3
    view = { ...view, x: drag.view.x - (dx * view.w) / rect.width, y: drag.view.y - (dy * view.h) / rect.height }
    show()
  })

  window.addEventListener('pointerup', () => {
    drag = undefined
  })

  // Graphviz titles a node with its name, `n12`, and an edge with the two it joins, `n12->n7`.
  const nameOf = group => group.querySelector('title')?.textContent ?? ''
  const nodes = new Map([...svg.querySelectorAll('g.node')].map(group => [nameOf(group), group]))
  const edges = [...svg.querySelectorAll('g.edge')].map(group => {
    const [from, to] = nameOf(group).split('->')
    return { group, from, to }
  })

  box.addEventListener('click', event => {
    if (dragged) {
      return
    }

    for (const lit of svg.querySelectorAll('.lit')) {
      lit.classList.remove('lit')
    }

    const node = event.target.closest('g.node')
    svg.classList.toggle('tracing', node !== null)

    if (node === null) {
      return
    }

    const name = nameOf(node)
    node.classList.add('lit')

    for (const edge of edges) {
      if (edge.from === name || edge.to === name) {
        edge.group.classList.add('lit')
        nodes.get(edge.from)?.classList.add('lit')
        nodes.get(edge.to)?.classList.add('lit')
      }
    }
  })
}
