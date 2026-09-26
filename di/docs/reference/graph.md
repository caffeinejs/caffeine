# Graph

CaffeineIoC can render a container's bindings as a dependency graph in several
formats. The graph functions have their own entry point, `@caffeinejs/di/graph`;
the package root does not export them.

```ts
import {
  buildBindingGraph,
  graphToDot,
  graphToJSON,
  graphToMarkdown,
  graphToMermaid,
  graphToText,
} from '@caffeinejs/di/graph'
```

Every renderer takes a container, its `entries()`, or a graph from
`buildBindingGraph`.

- [buildBindingGraph](#buildbindinggraph)
- [graphToText](#graphtotext)
- [graphToMarkdown](#graphtomarkdown)
- [graphToMermaid](#graphtomermaid)
- [graphToDot](#graphtodot)
- [graphToJSON](#graphtojson)

---

### buildBindingGraph

```ts
buildBindingGraph(bindings: Iterable<[InjectionToken, Binding]>): BindingGraph
```

Builds the graph the renderers draw: a node for each `[key, binding]` pair, and an
edge for every binding an injection receives.

The graph describes the pairs it is given. Pass an initialized container, or its
`entries()`, for a graph that matches resolution: before `init()`, profiles and
conditionals have not settled yet.

An injection gets an edge to what the container injects there: the only binding
answering to its key, or the primary among several; for `allOf`, `ordered` and
`mapped`, every one of them except the consumer's own. `$i.defer` targets and
`$i.object` fields are followed. Bindings sharing a name or a label are joined by
dashed group edges.

Dependencies the container wires outside injections have no edge: `aliasOf`,
`$i.value`, the configuration class behind a `@Provides` method, and aspects. A
key replaced with `rebind` while other bindings still name or extend it shows
those bindings as candidates too, though the container injects only the
replacement.

```ts
const graph = buildBindingGraph(container)
```

---

### graphToText

```ts
graphToText(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string
```

Renders the graph as a plain-text tree. Suitable for terminal output and
log files.

```ts
console.log(graphToText(container))
```

Example output:

```
UserService(scope=singleton)
  ├─ Logger(scope=singleton)
  └─ Database(scope=singleton)

Logger(scope=singleton)

Database(scope=singleton)
  └─ ConnectionPool(scope=singleton)
```

---

### graphToMarkdown

```ts
graphToMarkdown(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string
```

Renders the graph as a Markdown table. Suitable for embedding in GitHub
issues, wikis, and pull request descriptions.

```ts
console.log(graphToMarkdown(container))
```

---

### graphToMermaid

```ts
graphToMermaid(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string
```

Renders the graph as a [Mermaid](https://mermaid.js.org/) flowchart diagram.
GitHub renders Mermaid blocks natively in Markdown files.

```ts
console.log(graphToMermaid(container))
```

Example output:

````md
```mermaid
%%{init: {"flowchart": {"htmlLabels": false}}}%%
flowchart LR
  n0["UserService\nsingleton"]
  n1["Logger\nsingleton"]
  n0 --> n1
```
````

---

### graphToDot

```ts
graphToDot(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string
```

Renders the graph in [GraphViz DOT](https://graphviz.org/doc/info/lang.html)
format. Use `dot -Tsvg -o graph.svg` to render it to an image.

```ts
console.log(graphToDot(container))
```

---

### graphToJSON

```ts
graphToJSON(input: Iterable<[InjectionToken, Binding]> | BindingGraph): string
```

Renders the graph as a JSON string. Suitable for custom tooling or storage.

```ts
const json = graphToJSON(container)
```
