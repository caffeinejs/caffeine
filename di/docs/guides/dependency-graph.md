# Dependency Graph

CaffeineIoC can render the bindings of a container as a dependency graph in several
formats. This is useful for auditing dependency relationships, spotting
unexpected couplings, and generating architecture diagrams.

## Rendering formats

Five renderers are available, all from the `@caffeinejs/di/graph` entry point. Each accepts the container, its
`.entries()` result or a graph from `buildBindingGraph`, and returns a string.

### Text

A plain-text tree suitable for logging or terminal output.

```ts
import { CaffeineIoC } from '@caffeinejs/di'
import { graphToText } from '@caffeinejs/di/graph'

const container = new CaffeineIoC()
await container.init()

console.log(graphToText(container))
```

### Markdown

A Markdown table for embedding in documentation or GitHub issues.

```ts
import { graphToMarkdown } from '@caffeinejs/di/graph'

console.log(graphToMarkdown(container))
```

### Mermaid

A [Mermaid](https://mermaid.js.org/) diagram for rendering in Markdown
previews, Notion, or GitHub README files.

```ts
import { graphToMermaid } from '@caffeinejs/di/graph'

console.log(graphToMermaid(container))
```

### GraphViz DOT

A [DOT](https://graphviz.org/doc/info/lang.html) language file for rendering
with GraphViz tools (`dot`, `neato`, etc.).

```ts
import { graphToDot } from '@caffeinejs/di/graph'

console.log(graphToDot(container))
```

### JSON

A machine-readable JSON representation of the graph for custom tooling.

```ts
import { graphToJSON } from '@caffeinejs/di/graph'

const json = graphToJSON(container)
```

## Validating the graph

Call `assertResolvable()` before rendering to ensure every dependency can be
resolved. It throws if a required key is missing or resolves to more than one
binding with none of them primary.

```ts
container.assertResolvable()
console.log(graphToText(container))
```

## Generating a graph at startup

A common pattern is to write the graph file as part of the application's
startup check:

```ts
import { writeFileSync } from 'node:fs'
import { CaffeineIoC } from '@caffeinejs/di'
import { graphToMermaid } from '@caffeinejs/di/graph'

const container = new CaffeineIoC()
await container.init()
container.assertResolvable()

if (process.env.GENERATE_GRAPH) {
  writeFileSync('dependency-graph.md', graphToMermaid(container))
}
```
