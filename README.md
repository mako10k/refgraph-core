# @mako10k/refgraph-core

A small, domain-neutral local IPLD immutable reference graph engine. CID-addressed blocks and their
forward IPLD Links are canonical; reverse references and roots are replaceable operational state.

```ts
import { CID } from 'multiformats/cid'
import { MemoryBlockStore, RefGraph } from '@mako10k/refgraph-core'

const graph = new RefGraph({ blocks: new MemoryBlockStore() })
const leaf = await graph.putRaw(new TextEncoder().encode('payload'))
const root = await graph.putValue({ child: leaf })
await graph.addRoot(root)

const links: ReadonlySet<string> = new Set((await graph.refs(root)).map(String))
const live: ReadonlySet<string> = new Set((await graph.reachable()).map(String))

const plan = await graph.planGc() // inspection only
await graph.commitGc(plan) // explicit destructive action

CID.parse(root.toString()) // public identity is a normal CID
void links
void live
```

Unknown codecs fail closed during traversal and GC. `fsck()` distinguishes immutable block failures
from rebuildable index/root-state failures. See [the architecture](docs/architecture.md) and
[the complete example](examples/basic.ts).

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm run check
npm pack --dry-run
```

## Public surface

`RefGraph` provides verified block/value writes, reads, generic `refs`, reverse `incoming`, index
rebuild/verification, roots, reachability, fsck, and two-phase GC. Storage boundaries are
`BlockStore`, `ReverseIndex`, and `RootStore`; deterministic in-memory implementations are included.

Licensed under MIT.
