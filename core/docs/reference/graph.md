# Graph

CaffeineIoC can render a container's bindings as a dependency graph in several
formats. All graph functions are exported from the main package.

```ts
import {
  graphToText,
  graphToMarkdown,
  graphToMermaid,
  graphToDot,
  graphToJson,
} from '@caffeine-projects/dicaf'
```

- [graphToText](#graphtotext)
- [graphToMarkdown](#graphtomarkdown)
- [graphToMermaid](#graphtomermaid)
- [graphToDot](#graphtodot)
- [graphToJson](#graphtojson)

---

### graphToText

```ts
graphToText(input: Iterable<[Key, Binding]>): string
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
graphToMarkdown(input: Iterable<[Key, Binding]>): string
```

Renders the graph as a Markdown table. Suitable for embedding in GitHub
issues, wikis, and pull request descriptions.

```ts
console.log(graphToMarkdown(container))
```

---

### graphToMermaid

```ts
graphToMermaid(input: Iterable<[Key, Binding]>): string
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
graphToDot(input: Iterable<[Key, Binding]>): string
```

Renders the graph in [GraphViz DOT](https://graphviz.org/doc/info/lang.html)
format. Use `dot -Tsvg -o graph.svg` to render it to an image.

```ts
console.log(graphToDot(container))
```

---

### graphToJson

```ts
graphToJson(input: Iterable<[Key, Binding]>): string
```

Renders the graph as a JSON string. Suitable for custom tooling or storage.

```ts
const json = graphToJson(container)
```
