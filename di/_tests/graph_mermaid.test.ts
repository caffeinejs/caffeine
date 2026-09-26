// @vitest-environment jsdom
// Mermaid sanitizes labels with DOMPurify, which needs a window, so this file alone runs on jsdom.
import mermaid from 'mermaid'
import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { graphToMermaid } from '../graph/index.js'
import { $i } from '../injection.js'
import { token } from '../key.js'

// Devtools renders this output with Mermaid, and a single label Mermaid cannot parse breaks the whole diagram. So the
// output is checked with Mermaid's own parser rather than with string assertions. Parsing proves the syntax only:
// how the diagram lays out still takes a real render.
describe('graphToMermaid output, parsed by Mermaid', function () {
  it('parses for a container using every node and edge feature', async function () {
    abstract class Channel {
      abstract send(): string
    }

    class EmailChannel extends Channel {
      send(): string {
        return 'email'
      }
    }

    class SmsChannel extends Channel {
      send(): string {
        return 'sms'
      }
    }

    interface Clock {
      now(): number
    }

    class SystemClock implements Clock {
      now(): number {
        return 0
      }
    }

    class Audit {
      record(): string {
        return 'recorded'
      }
    }

    class Repo {}

    // Keys, names and labels carrying every character Mermaid treats specially.
    const kClock = token<Clock>('clock "utc" #tz; a|b [x"] (y) {z} <w> \\ end')
    const kAudit = token<Audit>(Symbol('audit "log" #1;'))
    const kTransport = token<Channel>('transport | "primary" #quot;')
    const kFeature = Symbol('feature | "beta" #x;')

    class Notifier {
      audit!: Audit
      clock?: Clock

      constructor(
        readonly channels: Channel[],
        readonly deps: { repo: Repo; later: Repo },
      ) {}

      setClock(clock: Clock): void {
        this.clock = clock
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(EmailChannel, t => t.toSelf().extends(Channel).names(kTransport).labels(kFeature).primary())
    di.bind(SmsChannel, t => t.toSelf().extends(Channel).names(kTransport).labels(kFeature).lazy())
    di.bind(kClock, t => t.toClass(SystemClock))
    di.bind(Audit, t => t.toSelf().names(kAudit))
    di.bind(Repo, t => t.toSelf())
    di.bind(Notifier, t =>
      t
        .toSelf([$i.allOf(Channel), $i.object({ repo: Repo, later: $i.defer(() => Repo) })])
        .injectProperty('audit', kAudit)
        .injectMethod('setClock', kClock),
    )
    await di.init()

    const diagram = graphToMermaid(di)

    // Every edge kind the renderer draws is present, so the parse covers all of them.
    expect(diagram).toContain('-->')
    expect(diagram).toContain('-.->')
    expect(diagram).toContain('[primary]')

    await expect(mermaid.parse(diagram)).resolves.toMatchObject({
      diagramType: expect.stringContaining('flowchart'),
    })
  })

  it('parses for a container holding a single binding', async function () {
    class Lonely {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Lonely, t => t.toSelf())
    await di.init()

    await expect(mermaid.parse(graphToMermaid(di))).resolves.toMatchObject({
      diagramType: expect.stringContaining('flowchart'),
    })
  })

  it('is checked by a parser that rejects what the escaping prevents', async function () {
    // A quote followed by `]` closes the node early unless it is written as an entity code, and a raw quote breaks
    // an edge label the same way.
    await expect(mermaid.parse('flowchart LR\n  n1["a"]b"]')).rejects.toThrow()
    await expect(mermaid.parse('flowchart LR\n  n1["x"] -->|"a"b"| n2["y"]')).rejects.toThrow()

    await expect(mermaid.parse('flowchart LR\n  n1["a#quot;]b"]')).resolves.toBeDefined()
    await expect(mermaid.parse('flowchart LR\n  n1["x"] -->|"a#quot;b"| n2["y"]')).resolves.toBeDefined()
  })
})
