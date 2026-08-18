import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import {
  ClosedRepositoryError,
  LocalRepository,
  ReadOnlyRepositoryError,
  WriterLockContendedError,
} from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  )
})

describe('LocalRepository', () => {
  it('creates, closes, reopens, and rebuilds the reverse index from canonical blocks', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    const leaf = await writer.putRaw(Uint8Array.of(1))
    const root = await writer.putValue({ arbitrary: leaf })
    await writer.addRoot(root)
    expect((await writer.incoming(leaf)).map(({ cid }) => cid.toString())).toEqual([
      root.toString(),
    ])
    await writer.close()

    const reopened = await LocalRepository.open(path, { mode: 'writer' })
    expect((await reopened.roots()).map(String)).toEqual([root.toString()])
    expect((await reopened.reachable()).map(String).sort()).toEqual(
      [leaf.toString(), root.toString()].sort(),
    )
    expect((await reopened.incoming(leaf)).map(({ cid }) => cid.toString())).toEqual([
      root.toString(),
    ])
    await reopened.close()
  })

  it('holds one process writer for the complete repository lifetime', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)

    await expect(LocalRepository.open(path, { mode: 'writer' })).rejects.toBeInstanceOf(
      WriterLockContendedError,
    )
    expect((await LocalRepository.inspectWriterLock(path)).state).toBe('held')
    await writer.close()
    expect((await LocalRepository.inspectWriterLock(path)).state).toBe('absent')
  })

  it('allows read-only verification while rejecting every canonical mutation', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    const cid = await writer.putRaw(Uint8Array.of(1))
    await writer.close()

    const reader = await LocalRepository.open(path, { mode: 'read-only' })
    expect(reader.openingErrors).toEqual([])
    expect(await reader.hasBlock(cid)).toBe(true)
    await expect(reader.putRaw(Uint8Array.of(2))).rejects.toBeInstanceOf(ReadOnlyRepositoryError)
    await expect(reader.addRoot(cid)).rejects.toBeInstanceOf(ReadOnlyRepositoryError)
    await expect(reader.removeRoot(cid)).rejects.toBeInstanceOf(ReadOnlyRepositoryError)
    await expect(reader.commitGc(await reader.planGc())).rejects.toBeInstanceOf(
      ReadOnlyRepositoryError,
    )
    await reader.close()
  })

  it('retains immutable rebuild failure evidence in read-only mode but rejects writer open', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    const cid = await writer.putRaw(Uint8Array.of(1))
    await writer.close()
    await writeFile(blockPath(path, cid), Uint8Array.of(9))

    const reader = await LocalRepository.open(path, { mode: 'read-only' })
    expect(reader.openingErrors).toHaveLength(1)
    expect((await reader.fsck()).blockIssues.map(({ code }) => code)).toEqual(['cid-mismatch'])
    await reader.close()

    await expect(LocalRepository.open(path, { mode: 'writer' })).rejects.toThrow(
      'CID does not match bytes',
    )
    expect((await LocalRepository.inspectWriterLock(path)).state).toBe('absent')
  })

  it('retains corrupt-root evidence in read-only mode and rejects writer readiness', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    await writer.putRaw(Uint8Array.of(1))
    await writer.close()
    await writeFile(join(path, 'roots.v1.json'), '')

    const reader = await LocalRepository.open(path, { mode: 'read-only' })
    expect(reader.openingErrors).toHaveLength(1)
    await expect(reader.roots()).rejects.toThrow('roots.v1.json is corrupt')
    await reader.close()

    await expect(LocalRepository.open(path, { mode: 'writer' })).rejects.toThrow(
      'roots.v1.json is corrupt',
    )
    expect((await LocalRepository.inspectWriterLock(path)).state).toBe('absent')
  })

  it('fails writer readiness closed for an unsupported stored codec', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    await writer.close()
    const bytes = Uint8Array.of(3)
    const unsupported = CID.create(1, 0x300001, await sha256.digest(bytes))
    const destination = blockPath(path, unsupported)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, bytes)

    const reader = await LocalRepository.open(path, { mode: 'read-only' })
    expect(reader.openingErrors[0]?.message).toContain('unsupported codec')
    await reader.close()

    await expect(LocalRepository.open(path, { mode: 'writer' })).rejects.toThrow(
      'unsupported codec',
    )
    expect((await LocalRepository.inspectWriterLock(path)).state).toBe('absent')
  })

  it('rejects operations accepted after orderly close begins', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    await writer.close()
    await writer.close()

    await expect(writer.putRaw(Uint8Array.of(1))).rejects.toBeInstanceOf(ClosedRepositoryError)
    await expect(writer.roots()).rejects.toBeInstanceOf(ClosedRepositoryError)
  })
})

async function repositoryPath(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'refgraph-core-repository-'))
  temporaryRoots.push(parent)
  return join(parent, 'repository')
}

function blockPath(repository: string, cid: CID): string {
  const first = byteHex(cid, 0)
  const second = byteHex(cid, 1)
  return join(repository, 'blocks', first, second, `${cid.toString()}.block`)
}

function byteHex(cid: CID, index: number): string {
  const byte = cid.multihash.digest[index]
  if (byte === undefined) throw new Error('digest too short')
  return byte.toString(16).padStart(2, '0')
}
