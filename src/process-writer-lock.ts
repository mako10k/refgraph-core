import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { open, lstat, readFile, unlink, type FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
  MalformedWriterLockError,
  StorageIoError,
  UnsafeFilesystemEntryError,
  UnsupportedPlatformError,
  WriterLockContendedError,
  WriterLockOwnershipError,
} from './errors.js'

const LOCK_SCHEMA = 'refgraph-core/writer-lock/v1'
const LOCK_FILENAME = 'writer.lock'
const LOCK_MODE = 0o600
const MAX_LOCK_BYTES = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const DECIMAL = /^[0-9]+$/u

export interface WriterLockRecord {
  readonly schema: typeof LOCK_SCHEMA
  readonly token: string
  readonly pid: number
  readonly process_start_ticks: string
  readonly boot_id: string
  readonly hostname: string
  readonly acquired_at: string
}

export type WriterLockInspection =
  | { readonly state: 'absent' }
  | { readonly state: 'held'; readonly record: WriterLockRecord }
  | { readonly state: 'malformed'; readonly reason: string }

/** Repository-scoped process writer guard from ADR 0001. Not yet a package-root export. */
export class ProcessWriterLock {
  readonly repositoryPath: string
  readonly lockPath: string
  readonly record: WriterLockRecord
  private readonly handle: FileHandle
  private closed = false

  private constructor(repositoryPath: string, handle: FileHandle, record: WriterLockRecord) {
    this.repositoryPath = repositoryPath
    this.lockPath = join(repositoryPath, LOCK_FILENAME)
    this.handle = handle
    this.record = record
  }

  static async acquire(repositoryPath: string): Promise<ProcessWriterLock> {
    assertSupportedPlatform()
    const resolvedRepository = resolve(repositoryPath)
    await requireDirectory(resolvedRepository)
    const lockPath = join(resolvedRepository, LOCK_FILENAME)
    const record = await createRecord()
    const bytes = encodeRecord(record)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle: FileHandle
      try {
        handle = await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          LOCK_MODE,
        )
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) {
          if (isNodeError(error, 'ELOOP')) {
            throw new UnsafeFilesystemEntryError(
              lockPath,
              'symbolic links are not valid writer locks',
              {
                cause: error,
              },
            )
          }
          throw new StorageIoError('writer lock acquisition', { cause: error })
        }
        const inspection = await inspectWriterLock(resolvedRepository)
        if (inspection.state === 'absent') continue
        if (inspection.state === 'malformed') throw new MalformedWriterLockError(inspection.reason)
        throw new WriterLockContendedError(inspection.record)
      }

      try {
        await handle.writeFile(bytes)
        await handle.sync()
        await syncDirectory(resolvedRepository)
        return new ProcessWriterLock(resolvedRepository, handle, record)
      } catch (error) {
        await removeFailedAcquisition(lockPath, handle)
        if (
          error instanceof UnsafeFilesystemEntryError ||
          error instanceof StorageIoError ||
          error instanceof WriterLockOwnershipError
        ) {
          throw error
        }
        throw new StorageIoError('writer lock publication', { cause: error })
      }
    }
    throw new StorageIoError('writer lock acquisition race', {
      cause: new Error('writer.lock repeatedly disappeared during inspection'),
    })
  }

  get isHeld(): boolean {
    return !this.closed
  }

  async release(): Promise<void> {
    if (this.closed) return
    const inspection = await inspectWriterLock(this.repositoryPath)
    if (inspection.state !== 'held' || inspection.record.token !== this.record.token) {
      throw new WriterLockOwnershipError()
    }

    const owned = await this.handle.stat()
    const current = await lstat(this.lockPath)
    if (!sameFile(owned, current) || !current.isFile()) throw new WriterLockOwnershipError()

    try {
      await unlink(this.lockPath)
      this.closed = true
      await syncDirectory(this.repositoryPath)
    } catch (error) {
      if (this.closed && error instanceof StorageIoError) throw error
      throw new StorageIoError('writer lock release', { cause: error })
    } finally {
      if (this.closed) await closeIgnoringError(this.handle)
    }
  }
}

export async function inspectWriterLock(repositoryPath: string): Promise<WriterLockInspection> {
  assertSupportedPlatform()
  const resolvedRepository = resolve(repositoryPath)
  await requireDirectory(resolvedRepository)
  const lockPath = join(resolvedRepository, LOCK_FILENAME)
  let handle: FileHandle | undefined
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new UnsafeFilesystemEntryError(lockPath, 'writer lock must be a regular file')
    }
    if (metadata.size > MAX_LOCK_BYTES) {
      return { state: 'malformed', reason: `record exceeds ${String(MAX_LOCK_BYTES)} bytes` }
    }
    const bytes = new Uint8Array(await handle.readFile())
    if (bytes.length > MAX_LOCK_BYTES) {
      return { state: 'malformed', reason: `record exceeds ${String(MAX_LOCK_BYTES)} bytes` }
    }
    return decodeRecord(bytes)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { state: 'absent' }
    if (isNodeError(error, 'ELOOP')) {
      throw new UnsafeFilesystemEntryError(lockPath, 'symbolic links are not valid writer locks', {
        cause: error,
      })
    }
    if (error instanceof UnsafeFilesystemEntryError) throw error
    throw new StorageIoError('writer lock inspection', { cause: error })
  } finally {
    if (handle !== undefined) await closeIgnoringError(handle)
  }
}

async function createRecord(): Promise<WriterLockRecord> {
  try {
    const [procStat, bootId] = await Promise.all([
      readFile('/proc/self/stat', 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ])
    const processStartTicks = parseProcessStartTicks(procStat)
    const normalizedBootId = bootId.trim()
    if (!UUID.test(normalizedBootId)) throw new Error('Linux boot ID is not a UUID')
    return {
      schema: LOCK_SCHEMA,
      token: randomUUID(),
      pid: process.pid,
      process_start_ticks: processStartTicks,
      boot_id: normalizedBootId,
      hostname: hostname(),
      acquired_at: new Date().toISOString(),
    }
  } catch (error) {
    throw new StorageIoError('Linux process identity capture', { cause: error })
  }
}

function parseProcessStartTicks(procStat: string): string {
  const commandEnd = procStat.lastIndexOf(') ')
  if (commandEnd < 0) throw new Error('/proc/self/stat has no command terminator')
  const fieldsFromState = procStat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u)
  const startTicks = fieldsFromState[19]
  if (startTicks === undefined || !DECIMAL.test(startTicks)) {
    throw new Error('/proc/self/stat has no valid process start ticks')
  }
  return startTicks
}

function encodeRecord(record: WriterLockRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(record)}\n`)
}

function decodeRecord(bytes: Uint8Array): WriterLockInspection {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { state: 'malformed', reason: 'record is not valid UTF-8' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { state: 'malformed', reason: 'record is not valid JSON' }
  }
  const reason = validateRecord(value)
  if (reason !== undefined) return { state: 'malformed', reason }
  const record = value as WriterLockRecord
  if (!bytesEqual(bytes, encodeRecord(record))) {
    return { state: 'malformed', reason: 'record bytes are not canonical' }
  }
  return { state: 'held', record }
}

function validateRecord(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return 'record is not an object'
  const record = value as Record<string, unknown>
  const expectedKeys = [
    'schema',
    'token',
    'pid',
    'process_start_ticks',
    'boot_id',
    'hostname',
    'acquired_at',
  ]
  if (JSON.stringify(Object.keys(record)) !== JSON.stringify(expectedKeys))
    return 'record members or order differ from v1'
  if (record.schema !== LOCK_SCHEMA) return 'schema is not writer-lock/v1'
  if (typeof record.token !== 'string' || !UUID.test(record.token)) return 'token is not a UUID'
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0)
    return 'pid is not a positive safe integer'
  if (typeof record.process_start_ticks !== 'string' || !DECIMAL.test(record.process_start_ticks)) {
    return 'process_start_ticks is not decimal'
  }
  if (typeof record.boot_id !== 'string' || !UUID.test(record.boot_id))
    return 'boot_id is not a UUID'
  if (
    typeof record.hostname !== 'string' ||
    record.hostname.length === 0 ||
    record.hostname.length > 255 ||
    hasAsciiControl(record.hostname)
  ) {
    return 'hostname is invalid'
  }
  if (typeof record.acquired_at !== 'string' || !isCanonicalTimestamp(record.acquired_at)) {
    return 'acquired_at is not a canonical timestamp'
  }
  return undefined
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

async function requireDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isDirectory())
      throw new UnsafeFilesystemEntryError(path, 'expected repository directory')
  } catch (error) {
    if (error instanceof UnsafeFilesystemEntryError) throw error
    throw new StorageIoError('repository directory validation', { cause: error })
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    await handle.sync()
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) {
      throw new UnsafeFilesystemEntryError(path, 'symbolic-link repository is not supported', {
        cause: error,
      })
    }
    throw new StorageIoError('repository directory sync', { cause: error })
  } finally {
    if (handle !== undefined) await closeIgnoringError(handle)
  }
}

async function removeFailedAcquisition(path: string, handle: FileHandle): Promise<void> {
  try {
    const owned = await handle.stat()
    const current = await lstat(path)
    if (!sameFile(owned, current)) throw new WriterLockOwnershipError()
    await unlink(path)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      await closeIgnoringError(handle)
      throw error
    }
  }
  await closeIgnoringError(handle)
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

async function closeIgnoringError(handle: FileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // Preserve the primary ownership or durability result.
  }
}

function assertSupportedPlatform(): void {
  if (process.platform !== 'linux') throw new UnsupportedPlatformError(process.platform)
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
