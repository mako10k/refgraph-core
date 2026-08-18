import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import {
  IntegrityError,
  LocalRepository,
  StaleGcPlanError,
  UnsupportedCodecError,
  WriterLockContendedError,
} from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  )
})

describe('persistent single-writer GC acceptance', () => {
  it('keeps dry-run inspection separate and deletes only unreachable canonical blocks', async () => {
    const path = await repositoryPath()
    const repository = await LocalRepository.create(path)
    const child = await repository.putRaw(Uint8Array.of(1))
    const root = await repository.putValue({ anyField: child })
    const garbage = await repository.putRaw(Uint8Array.of(2))
    await repository.addRoot(root)

    const plan = await repository.planGc()
    expect(plan.live.map(String).sort()).toEqual([child.toString(), root.toString()].sort())
    expect(plan.candidates.map(String)).toEqual([garbage.toString()])
    expect(await repository.hasBlock(garbage)).toBe(true)

    const result = await repository.commitGc(plan)
    expect(result.deleted.map(String)).toEqual([garbage.toString()])
    expect(await repository.hasBlock(root)).toBe(true)
    expect(await repository.hasBlock(child)).toBe(true)
    expect((await repository.verifyIndex()).map(({ code }) => code)).toEqual([])
    await repository.close()

    const reopened = await LocalRepository.open(path, { mode: 'writer' })
    expect((await reopened.reachable()).map(String).sort()).toEqual(
      [child.toString(), root.toString()].sort(),
    )
    expect(await reopened.hasBlock(garbage)).toBe(false)
    expect(await reopened.verifyIndex()).toEqual([])
    await reopened.close()
  })

  it('rejects a stale plan after roots change and preserves every block', async () => {
    const path = await repositoryPath()
    const repository = await LocalRepository.create(path)
    const candidate = await repository.putRaw(Uint8Array.of(1))
    const plan = await repository.planGc()
    await repository.addRoot(candidate)

    await expect(repository.commitGc(plan)).rejects.toBeInstanceOf(StaleGcPlanError)
    expect(await repository.hasBlock(candidate)).toBe(true)
    expect(await repository.gcCandidates()).toEqual([])
    await repository.close()
  })

  it('holds the writer lock throughout planning, root mutation, and commit', async () => {
    const path = await repositoryPath()
    const repository = await LocalRepository.create(path)
    const garbage = await repository.putRaw(Uint8Array.of(1))
    const plan = await repository.planGc()

    await expect(LocalRepository.open(path, { mode: 'writer' })).rejects.toBeInstanceOf(
      WriterLockContendedError,
    )
    expect((await repository.commitGc(plan)).deleted.map(String)).toEqual([garbage.toString()])
    await repository.close()
  })

  it('exposes no candidates after immutable corruption is discovered', async () => {
    const path = await repositoryPath()
    const repository = await LocalRepository.create(path)
    const candidate = await repository.putRaw(Uint8Array.of(1))
    const destination = blockPath(path, candidate)
    await writeFile(destination, Uint8Array.of(9))

    await expect(repository.planGc()).rejects.toBeInstanceOf(IntegrityError)
    expect(await readBytes(destination)).toEqual(Uint8Array.of(9))
    await repository.close()
  })

  it('exposes no candidates when an unsupported codec enters canonical inventory', async () => {
    const path = await repositoryPath()
    const repository = await LocalRepository.create(path)
    const reachable = await repository.putRaw(Uint8Array.of(1))
    await repository.addRoot(reachable)
    const bytes = Uint8Array.of(3)
    const unsupported = CID.create(1, 0x300001, await sha256.digest(bytes))
    const destination = blockPath(path, unsupported)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, bytes)

    await expect(repository.gcCandidates()).rejects.toBeInstanceOf(UnsupportedCodecError)
    expect(await repository.hasBlock(reachable)).toBe(true)
    expect(await readBytes(destination)).toEqual(bytes)
    await repository.close()
  })

  it('recovers safely after a crash-like partial deletion of garbage', async () => {
    const path = await repositoryPath()
    const repository = await LocalRepository.create(path)
    const root = await repository.putRaw(Uint8Array.of(1))
    const garbageA = await repository.putRaw(Uint8Array.of(2))
    const garbageB = await repository.putRaw(Uint8Array.of(3))
    await repository.addRoot(root)
    const originalPlan = await repository.planGc()
    expect(originalPlan.candidates.map(String).sort()).toEqual(
      [garbageA.toString(), garbageB.toString()].sort(),
    )
    await repository.close()

    await unlink(blockPath(path, garbageA))
    const reopened = await LocalRepository.open(path, { mode: 'writer' })
    const resumedPlan = await reopened.planGc()
    expect(resumedPlan.candidates.map(String)).toEqual([garbageB.toString()])
    expect(await reopened.hasBlock(root)).toBe(true)
    expect((await reopened.commitGc(resumedPlan)).deleted.map(String)).toEqual([
      garbageB.toString(),
    ])
    expect(await reopened.hasBlock(root)).toBe(true)
    await reopened.close()
  })
})

async function repositoryPath(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'refgraph-core-gc-'))
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

async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}
