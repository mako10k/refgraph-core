import { MemoryBlockStore, RefGraph } from '../src/index.js'

const graph = new RefGraph({ blocks: new MemoryBlockStore() })
const payload = await graph.putRaw(new TextEncoder().encode('hello'))
const root = await graph.putValue({ payload, nested: [{ sameEdge: payload }] })
await graph.addRoot(root)

console.log({
  root: root.toString(),
  refs: (await graph.refs(root)).map(String),
  reachable: (await graph.reachable()).map(String),
  fsck: await graph.fsck(),
})
