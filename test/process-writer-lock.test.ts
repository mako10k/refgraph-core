import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MalformedWriterLockError,
  UnsafeFilesystemEntryError,
  WriterLockContendedError,
} from '../src/errors.js'
import {
  inspectWriterLock,
  ProcessWriterLock,
  type WriterLockRecord,
} from '../src/process-writer-lock.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  )
})

describe('ProcessWriterLock', () => {
  it('publishes an inspectable owner record and removes only on orderly release', async () => {
    const repository = await temporaryRepository()
    const lock = await ProcessWriterLock.acquire(repository)

    expect(lock.isHeld).toBe(true)
    expect((await stat(lock.lockPath)).mode & 0o777).toBe(0o600)
    const inspection = await inspectWriterLock(repository)
    expect(inspection).toEqual({ state: 'held', record: lock.record })
    expect(lock.record).not.toHaveProperty('cwd')
    expect(lock.record).not.toHaveProperty('argv')
    expect(lock.record).not.toHaveProperty('environment')

    await lock.release()
    await lock.release()
    expect(lock.isHeld).toBe(false)
    expect(await inspectWriterLock(repository)).toEqual({ state: 'absent' })
  })

  it('rejects a second same-process writer without stealing the lock', async () => {
    const repository = await temporaryRepository()
    const first = await ProcessWriterLock.acquire(repository)
    try {
      const rejected = ProcessWriterLock.acquire(repository)
      await expect(rejected).rejects.toBeInstanceOf(WriterLockContendedError)
      await expect(rejected).rejects.toMatchObject({ owner: first.record })
      expect((await inspectWriterLock(repository)).state).toBe('held')
    } finally {
      await first.release()
    }
  })

  it('uses an OS-visible exclusive file that rejects a child-process writer', async () => {
    const repository = await temporaryRepository()
    const lock = await ProcessWriterLock.acquire(repository)
    try {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `const fs=require('node:fs');try{const fd=fs.openSync(process.argv[1],fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);fs.closeSync(fd);process.stdout.write('acquired')}catch(error){if(error.code==='EEXIST')process.stdout.write('contended');else throw error}`,
          lock.lockPath,
        ],
        { encoding: 'utf8' },
      )
      expect(child.status).toBe(0)
      expect(child.stdout).toBe('contended')
      expect(lock.isHeld).toBe(true)
    } finally {
      await lock.release()
    }
  })

  it('fails closed on a potentially stale valid record and never removes it', async () => {
    const repository = await temporaryRepository()
    const previous = await ProcessWriterLock.acquire(repository)
    const stale: WriterLockRecord = {
      ...previous.record,
      pid: 2_147_483_647,
      process_start_ticks: '1',
    }
    await previous.release()
    const bytes = `${JSON.stringify(stale)}\n`
    await writeFile(join(repository, 'writer.lock'), bytes, { mode: 0o600, flag: 'wx' })

    expect(await inspectWriterLock(repository)).toEqual({ state: 'held', record: stale })
    await expect(ProcessWriterLock.acquire(repository)).rejects.toBeInstanceOf(
      WriterLockContendedError,
    )
    expect(await readFile(join(repository, 'writer.lock'), 'utf8')).toBe(bytes)
  })

  it('reports malformed records without treating them as absent or repairing them', async () => {
    const repository = await temporaryRepository()
    await writeFile(join(repository, 'writer.lock'), new Uint8Array(), { mode: 0o600, flag: 'wx' })

    expect(await inspectWriterLock(repository)).toEqual({
      state: 'malformed',
      reason: 'record is not valid JSON',
    })
    await expect(ProcessWriterLock.acquire(repository)).rejects.toBeInstanceOf(
      MalformedWriterLockError,
    )
    expect((await stat(join(repository, 'writer.lock'))).size).toBe(0)
  })

  it('rejects noncanonical and unknown lock members', async () => {
    const repository = await temporaryRepository()
    const lock = await ProcessWriterLock.acquire(repository)
    const record = lock.record
    await lock.release()
    await writeFile(
      join(repository, 'writer.lock'),
      `${JSON.stringify({ ...record, unexpected: true })}\n`,
      { mode: 0o600, flag: 'wx' },
    )

    expect(await inspectWriterLock(repository)).toMatchObject({
      state: 'malformed',
      reason: 'record members or order differ from v1',
    })
  })

  it('never follows a writer.lock symbolic link', async () => {
    const repository = await temporaryRepository()
    const target = join(repository, 'outside')
    await writeFile(target, 'not a lock')
    await symlink(target, join(repository, 'writer.lock'))

    await expect(inspectWriterLock(repository)).rejects.toBeInstanceOf(UnsafeFilesystemEntryError)
    await expect(ProcessWriterLock.acquire(repository)).rejects.toBeInstanceOf(
      UnsafeFilesystemEntryError,
    )
  })

  it('bounds lock inspection input without deleting an oversized record', async () => {
    const repository = await temporaryRepository()
    await writeFile(join(repository, 'writer.lock'), Buffer.alloc(4097), {
      mode: 0o600,
      flag: 'wx',
    })

    expect(await inspectWriterLock(repository)).toEqual({
      state: 'malformed',
      reason: 'record exceeds 4096 bytes',
    })
    expect((await stat(join(repository, 'writer.lock'))).size).toBe(4097)
  })
})

async function temporaryRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'refgraph-core-lock-'))
  temporaryRoots.push(repository)
  return repository
}
