import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as raw from 'multiformats/codecs/raw'
import {
  IntegrityError,
  MemoryBlockStore,
  MemoryReverseIndex,
  RefGraph,
  StaleGcPlanError,
  UnsupportedCodecError,
} from '../src/index.js'

describe('RefGraph vertical slice', () => {
  it('stores raw and deterministic DAG-CBOR blocks and extracts generic nested links', async () => {
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    const leaf = await graph.putRaw(new TextEncoder().encode('leaf'))
    const root = await graph.putValue({
      arbitrary: [{ deeply: leaf }],
      anotherName: leaf,
      bytes: new Uint8Array([1, 2, 3]),
    })

    expect((await graph.refs(leaf)).map(String)).toEqual([])
    expect((await graph.refs(root)).map(String)).toEqual([leaf.toString()])
    expect((await graph.incoming(leaf)).map(({ cid }) => cid.toString())).toEqual([root.toString()])
    expect(await graph.getValue(root)).toMatchObject({ arbitrary: [{ deeply: leaf }] })
  })

  it('rebuilds and verifies a deliberately corrupted derived index', async () => {
    const blocks = new MemoryBlockStore()
    const index = new MemoryReverseIndex()
    const graph = new RefGraph({ blocks, index })
    const leaf = await graph.putRaw(new Uint8Array([1]))
    const root = await graph.putValue({ leaf })

    await index.replace(new Map())
    expect((await graph.verifyIndex()).map((issue) => issue.code)).toEqual(['index-mismatch'])
    const damaged = await graph.fsck()
    expect(damaged.blockIssues).toEqual([])
    expect(damaged.derivedIssues.some((issue) => issue.code === 'index-mismatch')).toBe(true)

    await graph.rebuildIndex()
    expect(await graph.verifyIndex()).toEqual([])
    expect((await graph.incoming(leaf))[0]?.cid.equals(root)).toBe(true)
  })

  it('computes reachability from operational roots without using the reverse index', async () => {
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    const leaf = await graph.putRaw(new Uint8Array([1]))
    const middle = await graph.putValue({ child: leaf })
    const root = await graph.putValue({ child: middle })
    await graph.putRaw(new Uint8Array([99]))
    await graph.addRoot(root)

    expect(new Set((await graph.reachable()).map(String))).toEqual(
      new Set([root, middle, leaf].map(String)),
    )
  })

  it('reports dangling links and missing roots as derived-state issues', async () => {
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    const missing = await cidFor(raw.code, new Uint8Array([44]))
    const root = await graph.putValue({ anyField: missing })
    const missingRoot = await cidFor(raw.code, new Uint8Array([45]))
    await graph.addRoot(root)
    await graph.addRoot(missingRoot)

    const report = await graph.fsck()
    expect(report.blockIssues).toEqual([])
    expect(report.derivedIssues.map((issue) => issue.code).sort()).toEqual([
      'dangling-link',
      'missing-root',
    ])
    expect(report.reachable?.map(String)).toContain(missing.toString())
  })
})

describe('integrity and fail-closed behavior', () => {
  it('rejects a public write when CID and bytes do not match', async () => {
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    const cid = await cidFor(raw.code, new Uint8Array([1]))
    await expect(graph.putBlock({ cid, bytes: new Uint8Array([2]) })).rejects.toBeInstanceOf(
      IntegrityError,
    )
  })

  it('reports immutable corruption separately from derived corruption', async () => {
    const blocks = new MemoryBlockStore()
    const goodBytes = new Uint8Array([1])
    const cid = await cidFor(raw.code, goodBytes)
    await blocks.put(cid, new Uint8Array([2]))
    const graph = new RefGraph({ blocks })

    const report = await graph.fsck()
    expect(report.blockIssues.map((issue) => issue.code)).toEqual(['cid-mismatch'])
    expect(report.derivedIssues).toEqual([])
    expect(report).not.toHaveProperty('gcCandidates')
  })

  it('rejects non-canonical DAG-CBOR rather than silently normalizing it', async () => {
    // {"b": 1, "a": 2}; valid CBOR but map keys are in non-canonical DAG-CBOR order.
    const bytes = Uint8Array.from([0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02])
    const cid = await cidFor(0x71, bytes)
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    await expect(graph.putBlock({ cid, bytes })).rejects.toBeInstanceOf(IntegrityError)
  })

  it('fails traversal and GC closed when an adapter contains an unknown codec', async () => {
    const blocks = new MemoryBlockStore()
    const bytes = new Uint8Array([0])
    const unknown = await cidFor(0x300001, bytes)
    await blocks.put(unknown, bytes)
    const graph = new RefGraph({ blocks })

    await expect(graph.refs(unknown)).rejects.toBeInstanceOf(UnsupportedCodecError)
    await expect(graph.planGc()).rejects.toBeInstanceOf(UnsupportedCodecError)
    expect((await graph.fsck()).blockIssues.map((issue) => issue.code)).toEqual([
      'unsupported-codec',
    ])
  })
})

describe('explicit garbage collection', () => {
  it('inspects candidates before deleting and never deletes reachable blocks', async () => {
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    const leaf = await graph.putRaw(new Uint8Array([1]))
    const root = await graph.putValue({ leaf })
    const garbage = await graph.putRaw(new Uint8Array([2]))
    await graph.addRoot(root)

    const plan = await graph.planGc()
    expect(plan.candidates.map(String)).toEqual([garbage.toString()])
    expect(await graph.hasBlock(garbage)).toBe(true)

    const result = await graph.commitGc(plan)
    expect(result.deleted.map(String)).toEqual([garbage.toString()])
    expect(await graph.hasBlock(root)).toBe(true)
    expect(await graph.hasBlock(leaf)).toBe(true)
  })

  it('rejects a plan made stale by a root change', async () => {
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    const candidate = await graph.putRaw(new Uint8Array([1]))
    const plan = await graph.planGc()
    await graph.addRoot(candidate)

    await expect(graph.commitGc(plan)).rejects.toBeInstanceOf(StaleGcPlanError)
    expect(await graph.hasBlock(candidate)).toBe(true)
  })

  it('produces deterministic rebuild and GC candidate ordering', async () => {
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    await Promise.all([
      graph.putRaw(new Uint8Array([3])),
      graph.putRaw(new Uint8Array([1])),
      graph.putRaw(new Uint8Array([2])),
    ])
    const first = (await graph.gcCandidates()).map(String)
    await graph.rebuildIndex()
    const second = (await graph.gcCandidates()).map(String)
    expect(second).toEqual(first)
    expect(first).toEqual([...first].sort())
  })
})

async function cidFor(code: number, bytes: Uint8Array): Promise<CID> {
  return CID.create(1, code, await sha256.digest(bytes))
}
