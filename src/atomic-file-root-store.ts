import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CID } from 'multiformats/cid'
import {
  RootStateCorruptionError,
  StorageIoError,
  UnsafeFilesystemEntryError,
  UnsupportedPlatformError,
} from './errors.js'
import type { RootStore } from './types.js'

const ROOTS_FILENAME = 'roots.v1.json'
const FILE_MODE = 0o600
const MAX_ROOT_DOCUMENT_BYTES = 16 * 1024 * 1024

interface RootDocument {
  readonly version: 1
  readonly roots: readonly string[]
}

/**
 * Atomic operational-root storage implementing ADR 0001.
 *
 * This adapter is internal until the repository writer lifecycle composes it behind the process
 * lock. Callers must serialize mutations; RefGraph already does so within one instance.
 */
export class AtomicFileRootStore implements RootStore {
  readonly repositoryPath: string
  readonly rootsPath: string
  private readonly randomId: () => string
  private readonly beforeRename: (() => void | Promise<void>) | undefined

  private constructor(
    repositoryPath: string,
    randomId: () => string,
    beforeRename: (() => void | Promise<void>) | undefined,
  ) {
    this.repositoryPath = resolve(repositoryPath)
    this.rootsPath = join(this.repositoryPath, ROOTS_FILENAME)
    this.randomId = randomId
    this.beforeRename = beforeRename
  }

  static async open(
    repositoryPath: string,
    randomId: () => string = randomUUID,
    beforeRename?: () => void | Promise<void>,
  ): Promise<AtomicFileRootStore> {
    const store = await AtomicFileRootStore.connect(repositoryPath, randomId, beforeRename)
    await store.list()
    return store
  }

  static async connect(
    repositoryPath: string,
    randomId: () => string = randomUUID,
    beforeRename?: () => void | Promise<void>,
  ): Promise<AtomicFileRootStore> {
    assertSupportedPlatform()
    const store = new AtomicFileRootStore(repositoryPath, randomId, beforeRename)
    await requireDirectory(store.repositoryPath)
    return store
  }

  async add(cid: CID): Promise<void> {
    const roots = new Map((await this.list()).map((root) => [root.toString(), root]))
    roots.set(cid.toString(), cid)
    await this.replace([...roots.values()])
  }

  async delete(cid: CID): Promise<boolean> {
    const roots = new Map((await this.list()).map((root) => [root.toString(), root]))
    if (!roots.delete(cid.toString())) return false
    await this.replace([...roots.values()])
    return true
  }

  async list(): Promise<readonly CID[]> {
    let bytes: Uint8Array
    try {
      bytes = await readRegularFile(this.rootsPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      if (
        error instanceof UnsafeFilesystemEntryError ||
        error instanceof RootStateCorruptionError
      ) {
        throw error
      }
      throw new StorageIoError('root document read', { cause: error })
    }
    return decodeRootDocument(bytes)
  }

  private async replace(roots: readonly CID[]): Promise<void> {
    const sorted = [...roots].sort((a, b) => compareStrings(a.toString(), b.toString()))
    const document: RootDocument = { version: 1, roots: sorted.map((cid) => cid.toString()) }
    const bytes = new TextEncoder().encode(`${JSON.stringify(document)}\n`)
    const temporaryPath = join(this.repositoryPath, `.roots.${this.randomId()}.tmp`)
    let handle: FileHandle | undefined
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        FILE_MODE,
      )
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.beforeRename?.()
      await rename(temporaryPath, this.rootsPath)
      await syncDirectory(this.repositoryPath)
    } catch (error) {
      if (error instanceof UnsafeFilesystemEntryError || error instanceof StorageIoError)
        throw error
      throw new StorageIoError('root document replacement', { cause: error })
    } finally {
      if (handle !== undefined) await closeAfterFailure(handle)
      await removeTemporary(temporaryPath)
    }
  }
}

function decodeRootDocument(bytes: Uint8Array): readonly CID[] {
  if (bytes.length === 0) throw new RootStateCorruptionError('document is empty')
  if (bytes.length > MAX_ROOT_DOCUMENT_BYTES)
    throw new RootStateCorruptionError('document exceeds the size limit')

  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new RootStateCorruptionError('document is not valid UTF-8 JSON', { cause: error })
  }
  if (!isRecord(value) || Object.keys(value).length !== 2)
    throw new RootStateCorruptionError('document must contain only version and roots')
  if (value.version !== 1) throw new RootStateCorruptionError('unsupported version')
  if (!Array.isArray(value.roots)) throw new RootStateCorruptionError('roots must be an array')

  const roots: CID[] = []
  let previous: string | undefined
  for (const item of value.roots) {
    if (typeof item !== 'string') throw new RootStateCorruptionError('every root must be a string')
    let cid: CID
    try {
      cid = CID.parse(item)
    } catch (error) {
      throw new RootStateCorruptionError('root is not a CID', { cause: error })
    }
    if (cid.toString() !== item)
      throw new RootStateCorruptionError('root is not a canonical CID string')
    if (previous !== undefined && compareStrings(previous, item) >= 0)
      throw new RootStateCorruptionError('roots must be unique and sorted')
    previous = item
    roots.push(cid)
  }

  const canonical = `${JSON.stringify({ version: 1, roots: roots.map(String) })}\n`
  if (!bytesEqual(bytes, new TextEncoder().encode(canonical)))
    throw new RootStateCorruptionError('document encoding is not canonical')
  return roots
}

async function readRegularFile(path: string): Promise<Uint8Array> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new UnsafeFilesystemEntryError(path, 'expected a regular file')
    if (metadata.size > MAX_ROOT_DOCUMENT_BYTES)
      throw new RootStateCorruptionError('document exceeds the size limit')
    return new Uint8Array(await handle.readFile())
  } catch (error) {
    if (isNodeError(error, 'ELOOP'))
      throw new UnsafeFilesystemEntryError(path, 'symbolic links are not followed', {
        cause: error,
      })
    throw error
  } finally {
    if (handle !== undefined) await closeAfterFailure(handle)
  }
}

async function requireDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isDirectory()) throw new UnsafeFilesystemEntryError(path, 'expected a directory')
  } catch (error) {
    if (error instanceof UnsafeFilesystemEntryError) throw error
    throw new StorageIoError('root repository validation', { cause: error })
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    await handle.sync()
  } catch (error) {
    if (isNodeError(error, 'ELOOP'))
      throw new UnsafeFilesystemEntryError(path, 'symbolic-link directory is not followed', {
        cause: error,
      })
    throw new StorageIoError('root repository sync', { cause: error })
  } finally {
    if (handle !== undefined) await closeAfterFailure(handle)
  }
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT'))
      throw new StorageIoError('root temporary cleanup', { cause: error })
  }
}

async function closeAfterFailure(handle: FileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // Preserve the primary filesystem failure.
  }
}

function assertSupportedPlatform(): void {
  if (process.platform !== 'linux') throw new UnsupportedPlatformError(process.platform)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
