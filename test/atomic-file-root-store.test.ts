import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { MemoryBlockStore, RefGraph } from '../src/index.js'
import { AtomicFileRootStore } from '../src/atomic-file-root-store.js'
import { RootStateCorruptionError, UnsafeFilesystemEntryError } from '../src/errors.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  )
})

describe('AtomicFileRootStore', () => {
  it('treats absence as the initial empty set and persists a canonical sorted CID set', async () => {
    const repository = await temporaryRepository()
    const store = await AtomicFileRootStore.open(repository)
    const rootB = await cid(Uint8Array.of(2))
    const rootA = await cid(Uint8Array.of(1))

    expect(await store.list()).toEqual([])
    await store.add(rootB)
    await store.add(rootA)
    await store.add(rootA)

    const expected = [rootA.toString(), rootB.toString()].sort()
    expect((await store.list()).map(String)).toEqual(expected)
    expect(await readFile(join(repository, 'roots.v1.json'), 'utf8')).toBe(
      `${JSON.stringify({ version: 1, roots: expected })}\n`,
    )
    expect((await stat(join(repository, 'roots.v1.json'))).mode & 0o777).toBe(0o600)
  })

  it('reopens persisted roots and persists an intentional empty set', async () => {
    const repository = await temporaryRepository()
    const root = await cid(Uint8Array.of(1))
    const store = await AtomicFileRootStore.open(repository)
    await store.add(root)

    const reopened = await AtomicFileRootStore.open(repository)
    expect((await reopened.list()).map(String)).toEqual([root.toString()])
    expect(await reopened.delete(root)).toBe(true)
    expect(await reopened.delete(root)).toBe(false)
    expect(await readFile(join(repository, 'roots.v1.json'), 'utf8')).toBe(
      '{"version":1,"roots":[]}\n',
    )
  })

  it('integrates with RefGraph without changing root CID identity', async () => {
    const repository = await temporaryRepository()
    const roots = await AtomicFileRootStore.open(repository)
    const graph = new RefGraph({ blocks: new MemoryBlockStore(), roots })
    const root = await graph.putRaw(Uint8Array.of(7))

    await graph.addRoot(root)
    const reopenedRoots = await AtomicFileRootStore.open(repository)
    const reopenedGraph = new RefGraph({ blocks: graph.blocks, roots: reopenedRoots })

    expect((await reopenedGraph.roots()).map(String)).toEqual([root.toString()])
    expect((await reopenedGraph.reachable()).map(String)).toEqual([root.toString()])
  })

  it.each([
    ['', 'empty'],
    ['{}\n', 'missing fields'],
    ['{"version":2,"roots":[]}\n', 'unsupported version'],
    ['{"version":1,"roots":[],"extra":true}\n', 'extra field'],
    ['{ "version": 1, "roots": [] }\n', 'noncanonical JSON'],
  ])('fails closed for corrupt root state: %s (%s)', async (document) => {
    const repository = await temporaryRepository()
    await writeFile(join(repository, 'roots.v1.json'), document)
    await expect(AtomicFileRootStore.open(repository)).rejects.toBeInstanceOf(
      RootStateCorruptionError,
    )
  })

  it('rejects duplicate, unsorted, malformed, and noncanonical root strings', async () => {
    const repository = await temporaryRepository()
    const a = await cid(Uint8Array.of(1))
    const b = await cid(Uint8Array.of(2))
    const malformedDocuments = [
      { version: 1, roots: [a.toString(), a.toString()] },
      { version: 1, roots: [b.toString(), a.toString()] },
      { version: 1, roots: ['not-a-cid'] },
      { version: 1, roots: [a.toString().toUpperCase()] },
    ]

    for (const document of malformedDocuments) {
      await writeFile(join(repository, 'roots.v1.json'), `${JSON.stringify(document)}\n`)
      await expect(AtomicFileRootStore.open(repository)).rejects.toBeInstanceOf(
        RootStateCorruptionError,
      )
    }
  })

  it('does not follow or replace a root-document symlink', async () => {
    const repository = await temporaryRepository()
    const outside = join(repository, 'outside.json')
    await writeFile(outside, '{"version":1,"roots":[]}\n')
    await symlink(outside, join(repository, 'roots.v1.json'))

    await expect(AtomicFileRootStore.open(repository)).rejects.toBeInstanceOf(
      UnsafeFilesystemEntryError,
    )
    expect(await readFile(outside, 'utf8')).toBe('{"version":1,"roots":[]}\n')
  })

  it('leaves the last valid document visible when publication fails before rename', async () => {
    const repository = await temporaryRepository()
    const original = await cid(Uint8Array.of(1))
    const next = await cid(Uint8Array.of(2))
    const store = await AtomicFileRootStore.open(repository, () => 'blocked')
    await store.add(original)
    const before = await readFile(join(repository, 'roots.v1.json'))

    await mkdir(join(repository, '.roots.blocked.tmp'))
    await expect(store.add(next)).rejects.toThrow()
    expect(await readFile(join(repository, 'roots.v1.json'))).toEqual(before)
  })
})

async function temporaryRepository(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'refgraph-core-roots-'))
  temporaryRoots.push(parent)
  const repository = join(parent, 'repository')
  await mkdir(repository, { mode: 0o700 })
  return repository
}

async function cid(bytes: Uint8Array): Promise<CID> {
  return CID.create(1, raw.code, await sha256.digest(bytes))
}
