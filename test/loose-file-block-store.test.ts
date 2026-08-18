import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { IntegrityError, MemoryBlockStore, RefGraph } from '../src/index.js'
import { UnsafeFilesystemEntryError } from '../src/errors.js'
import { LooseFileBlockStore } from '../src/loose-file-block-store.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  )
})

describe('LooseFileBlockStore', () => {
  it('publishes immutable blocks, copies byte boundaries, and reopens deterministically', async () => {
    const root = await temporaryRoot()
    const store = await LooseFileBlockStore.create(root)
    const blockB = await block(Uint8Array.of(2))
    const blockA = await block(Uint8Array.of(1))

    await store.put(blockB.cid, blockB.bytes)
    await store.put(blockA.cid, blockA.bytes)
    await store.put(blockA.cid, blockA.bytes)

    const read = await store.get(blockA.cid)
    expect(read).toEqual(blockA.bytes)
    if (read === undefined) throw new Error('expected stored bytes')
    read[0] = 99
    expect(await store.get(blockA.cid)).toEqual(blockA.bytes)

    const reopened = await LooseFileBlockStore.open(root)
    expect((await collect(reopened)).map(({ cid }) => cid.toString())).toEqual(
      [blockA.cid.toString(), blockB.cid.toString()].sort(),
    )
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'blocks'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'tmp'))).mode & 0o777).toBe(0o700)
    expect((await stat(blockPath(root, blockA.cid))).mode & 0o777).toBe(0o600)
  })

  it('integrates with canonical RefGraph scans without changing CID identity', async () => {
    const root = await temporaryRoot()
    const graph = new RefGraph({ blocks: await LooseFileBlockStore.create(root) })
    const bytes = new TextEncoder().encode('persistent payload')
    const cid = await graph.putRaw(bytes)

    expect(await graph.getBlock(cid)).toEqual(bytes)
    expect(cid.equals((await block(bytes)).cid)).toBe(true)
    expect((await graph.fsck()).ok).toBe(true)
  })

  it('rejects CID mismatches before publishing any destination', async () => {
    const root = await temporaryRoot()
    const store = await LooseFileBlockStore.create(root)
    const expected = await block(Uint8Array.of(1))

    await expect(store.put(expected.cid, Uint8Array.of(2))).rejects.toBeInstanceOf(IntegrityError)
    expect(await store.has(expected.cid)).toBe(false)
    expect(await collect(store)).toEqual([])
  })

  it('never replaces a corrupt existing CID path', async () => {
    const root = await temporaryRoot()
    const store = await LooseFileBlockStore.create(root)
    const expected = await block(Uint8Array.of(1))
    await store.put(expected.cid, expected.bytes)
    await writeFile(blockPath(root, expected.cid), Uint8Array.of(9))

    await expect(store.put(expected.cid, expected.bytes)).rejects.toBeInstanceOf(IntegrityError)
    expect(await readFile(blockPath(root, expected.cid))).toEqual(Buffer.from([9]))
  })

  it('ignores temporary residue but rejects malformed canonical inventory', async () => {
    const root = await temporaryRoot()
    const store = await LooseFileBlockStore.create(root)
    await writeFile(join(root, 'tmp', 'interrupted.block.tmp'), Uint8Array.of(1))
    expect(await collect(store)).toEqual([])

    await mkdir(join(root, 'blocks', 'zz'))
    await expect(collect(store)).rejects.toBeInstanceOf(UnsafeFilesystemEntryError)
  })

  it('rejects symlinks at exact block locations for get, has, and inventory', async () => {
    const root = await temporaryRoot()
    const store = await LooseFileBlockStore.create(root)
    const expected = await block(Uint8Array.of(1))
    const destination = blockPath(root, expected.cid)
    await mkdir(join(root, 'blocks', shard(expected.cid, 0)), { recursive: true })
    await mkdir(join(root, 'blocks', shard(expected.cid, 0), shard(expected.cid, 1)))
    const target = join(root, 'outside')
    await writeFile(target, expected.bytes)
    await symlink(target, destination)

    await expect(store.get(expected.cid)).rejects.toBeInstanceOf(UnsafeFilesystemEntryError)
    await expect(store.has(expected.cid)).rejects.toBeInstanceOf(UnsafeFilesystemEntryError)
    await expect(store.delete(expected.cid)).rejects.toBeInstanceOf(UnsafeFilesystemEntryError)
    await expect(collect(store)).rejects.toBeInstanceOf(UnsafeFilesystemEntryError)
  })

  it('rejects a valid CID placed under the wrong digest shard', async () => {
    const root = await temporaryRoot()
    const store = await LooseFileBlockStore.create(root)
    const expected = await block(Uint8Array.of(1))
    const wrongDirectory = join(root, 'blocks', '00', '00')
    await mkdir(wrongDirectory, { recursive: true })
    await writeFile(join(wrongDirectory, `${expected.cid.toString()}.block`), expected.bytes)

    await expect(collect(store)).rejects.toBeInstanceOf(UnsafeFilesystemEntryError)
  })

  it('deletes only regular exact paths and syncs the containing shard', async () => {
    const root = await temporaryRoot()
    const store = await LooseFileBlockStore.create(root)
    const expected = await block(Uint8Array.of(1))
    await store.put(expected.cid, expected.bytes)

    expect(await store.delete(expected.cid)).toBe(true)
    expect(await store.delete(expected.cid)).toBe(false)
    expect(await store.has(expected.cid)).toBe(false)
  })

  it('keeps the in-memory backend independent from filesystem layout', async () => {
    const graph = new RefGraph({ blocks: new MemoryBlockStore() })
    const cid = await graph.putRaw(Uint8Array.of(1))
    expect(await graph.hasBlock(cid)).toBe(true)
  })
})

async function temporaryRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'refgraph-core-loose-'))
  temporaryRoots.push(parent)
  return join(parent, 'repository')
}

async function block(bytes: Uint8Array): Promise<{ cid: CID; bytes: Uint8Array }> {
  return { cid: CID.create(1, raw.code, await sha256.digest(bytes)), bytes }
}

async function collect(
  store: LooseFileBlockStore,
): Promise<Array<{ cid: CID; bytes: Uint8Array }>> {
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = []
  for await (const item of store.iterate()) blocks.push(item)
  return blocks
}

function blockPath(root: string, cid: CID): string {
  return join(root, 'blocks', shard(cid, 0), shard(cid, 1), `${cid.toString()}.block`)
}

function shard(cid: CID, index: number): string {
  const byte = cid.multihash.digest[index]
  if (byte === undefined) throw new Error('digest too short')
  return byte.toString(16).padStart(2, '0')
}
