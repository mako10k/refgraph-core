import { randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { link, lstat, mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import {
  IntegrityError,
  StorageIoError,
  UnsafeFilesystemEntryError,
  UnsupportedHashError,
  UnsupportedPlatformError,
} from './errors.js'
import { bytesEqual } from './memory.js'
import type { BlockStore, StoredBlock } from './types.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const HEX_BYTE = /^[0-9a-f]{2}$/u
const BLOCK_SUFFIX = '.block'

/**
 * Linux local-filesystem block adapter implementing ADR 0001.
 *
 * This module is intentionally not exported from the package root until repository-scoped writer
 * locking and lifecycle composition are implemented. Direct construction is an internal test seam,
 * not mutation authority for external callers.
 */
export class LooseFileBlockStore implements BlockStore {
  readonly repositoryPath: string
  readonly blocksPath: string
  readonly temporaryPath: string

  private constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath)
    this.blocksPath = join(this.repositoryPath, 'blocks')
    this.temporaryPath = join(this.repositoryPath, 'tmp')
  }

  static async create(repositoryPath: string): Promise<LooseFileBlockStore> {
    assertSupportedPlatform()
    const store = new LooseFileBlockStore(repositoryPath)
    await createDirectory(store.repositoryPath)
    if (await createDirectory(store.blocksPath)) await syncDirectory(store.repositoryPath)
    if (await createDirectory(store.temporaryPath)) await syncDirectory(store.repositoryPath)
    return store
  }

  static async open(repositoryPath: string): Promise<LooseFileBlockStore> {
    assertSupportedPlatform()
    const store = new LooseFileBlockStore(repositoryPath)
    await requireDirectory(store.repositoryPath)
    await requireDirectory(store.blocksPath)
    await requireDirectory(store.temporaryPath)
    return store
  }

  async put(cid: CID, bytes: Uint8Array): Promise<void> {
    await assertCidMatchesBytes(cid, bytes)
    const location = this.location(cid)
    if (await createDirectory(location.firstShardPath)) await syncDirectory(this.blocksPath)
    if (await createDirectory(location.secondShardPath))
      await syncDirectory(location.firstShardPath)

    const temporaryFile = join(this.temporaryPath, `${randomUUID()}.block.tmp`)
    let temporaryHandle: FileHandle | undefined
    try {
      temporaryHandle = await open(
        temporaryFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        FILE_MODE,
      )
      await temporaryHandle.writeFile(bytes)
      await temporaryHandle.sync()
      await temporaryHandle.close()
      temporaryHandle = undefined

      try {
        await link(temporaryFile, location.blockPath)
        await syncDirectory(location.secondShardPath)
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
        const existing = await readRegularFile(location.blockPath)
        await assertCidMatchesBytes(cid, existing)
        if (!bytesEqual(existing, bytes)) {
          throw new IntegrityError(`stored bytes differ for CID ${cid.toString()}`)
        }
      }
    } catch (error) {
      if (
        error instanceof IntegrityError ||
        error instanceof UnsupportedHashError ||
        error instanceof UnsafeFilesystemEntryError ||
        error instanceof StorageIoError
      ) {
        throw error
      }
      throw new StorageIoError('block publication', { cause: error })
    } finally {
      if (temporaryHandle !== undefined) await closeAfterFailure(temporaryHandle)
      await removeTemporary(temporaryFile, this.temporaryPath)
    }
  }

  async get(cid: CID): Promise<Uint8Array | undefined> {
    try {
      return await readRegularFile(this.location(cid).blockPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined
      if (error instanceof UnsafeFilesystemEntryError) throw error
      throw new StorageIoError('block read', { cause: error })
    }
  }

  async has(cid: CID): Promise<boolean> {
    const blockPath = this.location(cid).blockPath
    try {
      const metadata = await lstat(blockPath)
      if (!metadata.isFile())
        throw new UnsafeFilesystemEntryError(blockPath, 'expected a regular file')
      return true
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false
      if (error instanceof UnsafeFilesystemEntryError) throw error
      throw new StorageIoError('block existence check', { cause: error })
    }
  }

  async delete(cid: CID): Promise<boolean> {
    const location = this.location(cid)
    try {
      const metadata = await lstat(location.blockPath)
      if (!metadata.isFile()) {
        throw new UnsafeFilesystemEntryError(
          location.blockPath,
          'refusing to delete a non-regular entry',
        )
      }
      await unlink(location.blockPath)
      await syncDirectory(location.secondShardPath)
      return true
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false
      if (error instanceof UnsafeFilesystemEntryError) throw error
      throw new StorageIoError('block deletion', { cause: error })
    }
  }

  async *iterate(): AsyncIterable<StoredBlock> {
    const firstShards = await readValidatedDirectory(this.blocksPath, 'directory')
    for (const firstShard of firstShards) {
      if (!HEX_BYTE.test(firstShard.name)) {
        throw new UnsafeFilesystemEntryError(
          join(this.blocksPath, firstShard.name),
          'invalid first shard name',
        )
      }
      const firstShardPath = join(this.blocksPath, firstShard.name)
      const secondShards = await readValidatedDirectory(firstShardPath, 'directory')
      for (const secondShard of secondShards) {
        if (!HEX_BYTE.test(secondShard.name)) {
          throw new UnsafeFilesystemEntryError(
            join(firstShardPath, secondShard.name),
            'invalid second shard name',
          )
        }
        const secondShardPath = join(firstShardPath, secondShard.name)
        const entries = await readValidatedDirectory(secondShardPath, 'file')
        for (const entry of entries) {
          const entryPath = join(secondShardPath, entry.name)
          if (!entry.name.endsWith(BLOCK_SUFFIX)) {
            throw new UnsafeFilesystemEntryError(entryPath, 'block filename lacks .block suffix')
          }
          const cidText = entry.name.slice(0, -BLOCK_SUFFIX.length)
          let cid: CID
          try {
            cid = CID.parse(cidText)
          } catch (error) {
            throw new UnsafeFilesystemEntryError(entryPath, 'block filename is not a CID', {
              cause: error,
            })
          }
          if (cid.toString() !== cidText) {
            throw new UnsafeFilesystemEntryError(
              entryPath,
              'block filename is not the canonical CID string',
            )
          }
          const expected = this.location(cid)
          if (expected.blockPath !== entryPath) {
            throw new UnsafeFilesystemEntryError(
              entryPath,
              'CID is stored under the wrong digest shard',
            )
          }
          yield { cid, bytes: await readRegularFile(entryPath) }
        }
      }
    }
  }

  private location(cid: CID): BlockLocation {
    if (cid.multihash.code !== sha256.code) throw new UnsupportedHashError(cid.multihash.code)
    const digest = cid.multihash.digest
    const first = byteHex(digest[0])
    const second = byteHex(digest[1])
    const firstShardPath = join(this.blocksPath, first)
    const secondShardPath = join(firstShardPath, second)
    return {
      firstShardPath,
      secondShardPath,
      blockPath: join(secondShardPath, `${cid.toString()}${BLOCK_SUFFIX}`),
    }
  }
}

interface BlockLocation {
  readonly firstShardPath: string
  readonly secondShardPath: string
  readonly blockPath: string
}

function assertSupportedPlatform(): void {
  if (process.platform !== 'linux') throw new UnsupportedPlatformError(process.platform)
}

async function assertCidMatchesBytes(cid: CID, bytes: Uint8Array): Promise<void> {
  if (cid.multihash.code !== sha256.code) throw new UnsupportedHashError(cid.multihash.code)
  const expected = CID.create(cid.version, cid.code, await sha256.digest(bytes))
  if (!cid.equals(expected)) throw new IntegrityError(`CID does not match bytes: ${cid.toString()}`)
}

async function createDirectory(path: string): Promise<boolean> {
  let created = false
  try {
    await mkdir(path, { mode: DIRECTORY_MODE })
    created = true
  } catch (error) {
    if (!isNodeError(error, 'EEXIST'))
      throw new StorageIoError('directory creation', { cause: error })
  }
  await requireDirectory(path)
  return created
}

async function requireDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isDirectory()) throw new UnsafeFilesystemEntryError(path, 'expected a directory')
  } catch (error) {
    if (error instanceof UnsafeFilesystemEntryError) throw error
    throw new StorageIoError('directory validation', { cause: error })
  }
}

async function readValidatedDirectory(
  path: string,
  expected: 'directory' | 'file',
): Promise<Dirent[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new StorageIoError('directory inventory', { cause: error })
  }
  entries.sort((a, b) => compareStrings(a.name, b.name))
  for (const entry of entries) {
    const valid = expected === 'directory' ? entry.isDirectory() : entry.isFile()
    if (!valid) {
      throw new UnsafeFilesystemEntryError(join(path, entry.name), `expected a regular ${expected}`)
    }
  }
  return entries
}

async function readRegularFile(path: string): Promise<Uint8Array> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new UnsafeFilesystemEntryError(path, 'expected a regular file')
    return new Uint8Array(await handle.readFile())
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) {
      throw new UnsafeFilesystemEntryError(path, 'symbolic links are not followed', {
        cause: error,
      })
    }
    throw error
  } finally {
    if (handle !== undefined) await closeAfterFailure(handle)
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    await handle.sync()
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) {
      throw new UnsafeFilesystemEntryError(path, 'symbolic-link directory is not followed', {
        cause: error,
      })
    }
    throw new StorageIoError('directory sync', { cause: error })
  } finally {
    if (handle !== undefined) await closeAfterFailure(handle)
  }
}

async function closeAfterFailure(handle: FileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // Preserve the primary filesystem failure. Successful paths close before reaching this helper.
  }
}

async function removeTemporary(path: string, temporaryDirectory: string): Promise<void> {
  try {
    await unlink(path)
    await syncDirectory(temporaryDirectory)
  } catch (error) {
    if (error instanceof StorageIoError || error instanceof UnsafeFilesystemEntryError) throw error
    if (!isNodeError(error, 'ENOENT'))
      throw new StorageIoError('temporary cleanup', { cause: error })
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function byteHex(byte: number | undefined): string {
  if (byte === undefined) throw new IntegrityError('SHA-256 digest is unexpectedly short')
  return byte.toString(16).padStart(2, '0')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
