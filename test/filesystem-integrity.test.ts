import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import {
  LocalRepository,
  RootStateCorruptionError,
  StorageIoError,
  UnsafeFilesystemEntryError,
} from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  )
})

describe('persistent filesystem integrity acceptance', () => {
  it('ignores interrupted temporary block residue across restart without inventing a block', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    const stored = await writer.putRaw(Uint8Array.of(1))
    await writer.close()
    await writeFile(join(path, 'tmp', 'crashed.block.tmp'), Uint8Array.of(9))

    const reopened = await LocalRepository.open(path, { mode: 'writer' })
    expect(await reopened.hasBlock(stored)).toBe(true)
    expect((await reopened.fsck()).stored.map(String)).toEqual([stored.toString()])
    expect(await readdir(join(path, 'tmp'))).toEqual(['crashed.block.tmp'])
    await reopened.close()
  })

  it('reports non-regular and symlink inventory entries without following or repairing them', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    await writer.close()
    await mkdir(join(path, 'blocks', '00'))
    await symlink(join(path, 'blocks', '00'), join(path, 'blocks', '01'))

    const reader = await LocalRepository.open(path, { mode: 'read-only' })
    expect(reader.openingErrors[0]).toBeInstanceOf(UnsafeFilesystemEntryError)
    expect(await readdir(join(path, 'blocks'))).toEqual(['00', '01'])
    await reader.close()
  })

  it('reports permission failures and leaves inaccessible canonical state untouched', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    const root = await writer.putRaw(Uint8Array.of(1))
    await writer.addRoot(root)
    await writer.close()
    const rootsPath = join(path, 'roots.v1.json')
    const before = await readFile(rootsPath)
    await chmod(rootsPath, 0o000)

    try {
      await expect(LocalRepository.open(path, { mode: 'writer' })).rejects.toBeInstanceOf(
        StorageIoError,
      )
      expect((await LocalRepository.inspectWriterLock(path)).state).toBe('absent')
    } finally {
      await chmod(rootsPath, 0o600)
    }
    expect(await readFile(rootsPath)).toEqual(before)
  })

  it('does not rewrite immutable corruption during read-only fsck', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    const cid = await writer.putRaw(Uint8Array.of(1))
    await writer.close()
    const destination = blockPath(path, cid)
    await writeFile(destination, Uint8Array.of(9))
    const corrupt = await readFile(destination)

    const reader = await LocalRepository.open(path, { mode: 'read-only' })
    const report = await reader.fsck()
    expect(report.blockIssues.map(({ code }) => code)).toEqual(['cid-mismatch'])
    expect(report.derivedIssues).toEqual([])
    await reader.close()
    expect(await readFile(destination)).toEqual(corrupt)
  })

  it('distinguishes operational root corruption and never substitutes an empty set', async () => {
    const path = await repositoryPath()
    const writer = await LocalRepository.create(path)
    const root = await writer.putRaw(Uint8Array.of(1))
    await writer.addRoot(root)
    await writer.close()
    const rootsPath = join(path, 'roots.v1.json')
    await writeFile(rootsPath, '{"version":1,"roots":[}\n')

    const reader = await LocalRepository.open(path, { mode: 'read-only' })
    expect(reader.openingErrors[0]).toBeInstanceOf(RootStateCorruptionError)
    await expect(reader.roots()).rejects.toBeInstanceOf(RootStateCorruptionError)
    await reader.close()
    expect(await readFile(rootsPath, 'utf8')).toBe('{"version":1,"roots":[}\n')
  })
})

async function repositoryPath(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'refgraph-core-integrity-'))
  temporaryRoots.push(parent)
  return join(parent, 'repository')
}

function blockPath(repository: string, cid: CID): string {
  const first = digestByte(cid, 0)
  const second = digestByte(cid, 1)
  return join(repository, 'blocks', first, second, `${cid.toString()}.block`)
}

function digestByte(cid: CID, index: number): string {
  const byte = cid.multihash.digest[index]
  if (byte === undefined) throw new Error('digest too short')
  return byte.toString(16).padStart(2, '0')
}
