# Dependency Graph

CaffeineIoC can render the bindings of a container as a dependency graph in several
formats. This is useful for auditing dependency relationships, spotting
unexpected couplings, and generating architecture diagrams.

## Rendering formats

Five renderers are available. All accept the container instance or `.entries()` result and return a string.

### Text

A plain-text tree suitable for logging or terminal output.

```ts
import { graphToText } from '@caffeinejs/core'

const container = new CaffeineIoC()
await container.init()

console.log(graphToText(container))
```

### Markdown

A Markdown table for embedding in documentation or GitHub issues.

```ts
import { graphToMarkdown } from '@caffeinejs/core'

console.log(graphToMarkdown(container))
```

### Mermaid

A [Mermaid](https://mermaid.js.org/) diagram for rendering in Markdown
previews, Notion, or GitHub README files.

```ts
import { graphToMermaid } from '@caffeinejs/core'

console.log(graphToMermaid(container))
```

### GraphViz DOT

A [DOT](https://graphviz.org/doc/info/lang.html) language file for rendering
with GraphViz tools (`dot`, `neato`, etc.).

```ts
import { graphToDot } from '@caffeinejs/core'

console.log(graphToDot(container))
```

### JSON

A machine-readable JSON representation of the graph for custom tooling.

```ts
import { graphToJson } from '@caffeinejs/core'

const json = graphToJson(container)
```

## Validating the graph

Call `assertResolvable()` before rendering to ensure every dependency can be
resolved. It throws if a required key is missing or a cycle is unresolvable.

```ts
container.assertResolvable()
console.log(graphToText(container))
```

## Generating a graph at startup

A common pattern is to write the graph file as part of the application's
startup check:

```ts
import { writeFileSync } from 'node:fs'
import { graphToMermaid } from '@caffeinejs/core'

const container = new CaffeineIoC()
await container.init()
container.assertResolvable()

if (process.env.GENERATE_GRAPH) {
  writeFileSync('dependency-graph.md', graphToMermaid(container))
}
```
