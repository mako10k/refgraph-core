import { lstat, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CID } from 'multiformats/cid'
import { AtomicFileRootStore } from './atomic-file-root-store.js'
import { CodecRegistry } from './codecs.js'
import {
  ClosedRepositoryError,
  ReadOnlyRepositoryError,
  StorageIoError,
  UnsafeFilesystemEntryError,
} from './errors.js'
import { LooseFileBlockStore } from './loose-file-block-store.js'
import { MemoryReverseIndex } from './memory.js'
import { ProcessWriterLock, inspectWriterLock } from './process-writer-lock.js'
import { RefGraph } from './ref-graph.js'
import type {
  BlockIssue,
  DerivedIssue,
  FsckReport,
  GcPlan,
  GcResult,
  Referrer,
  StoredBlock,
} from './types.js'

const DIRECTORY_MODE = 0o700

export type RepositoryMode = 'read-only' | 'writer'

export interface OpenRepositoryOptions {
  readonly mode: RepositoryMode
  readonly codecs?: CodecRegistry
}

interface OpenedRepository {
  readonly graph: RefGraph
  readonly writerLock?: ProcessWriterLock
  readonly openingErrors: readonly Error[]
}

/** Local, process-scoped composition of the neutral graph and filesystem adapters. */
export class LocalRepository {
  readonly path: string
  readonly mode: RepositoryMode
  readonly openingErrors: readonly Error[]

  private readonly graph: RefGraph
  private readonly writerLock: ProcessWriterLock | undefined
  private state: 'open' | 'closing' | 'closed' = 'open'
  private mutationTail: Promise<void> = Promise.resolve()

  private constructor(
    path: string,
    mode: RepositoryMode,
    graph: RefGraph,
    writerLock: ProcessWriterLock | undefined,
    openingErrors: readonly Error[],
  ) {
    this.path = path
    this.mode = mode
    this.graph = graph
    this.writerLock = writerLock
    this.openingErrors = Object.freeze([...openingErrors])
  }

  static async create(
    path: string,
    options: Omit<OpenRepositoryOptions, 'mode'> = {},
  ): Promise<LocalRepository> {
    const resolved = resolve(path)
    await createRepositoryDirectory(resolved)
    const opened = await openWriter(resolved, options.codecs, true)
    return new LocalRepository(
      resolved,
      'writer',
      opened.graph,
      opened.writerLock,
      opened.openingErrors,
    )
  }

  static async open(path: string, options: OpenRepositoryOptions): Promise<LocalRepository> {
    const resolved = resolve(path)
    const opened =
      options.mode === 'writer'
        ? await openWriter(resolved, options.codecs, false)
        : await openReadOnly(resolved, options.codecs)
    return new LocalRepository(
      resolved,
      options.mode,
      opened.graph,
      opened.writerLock,
      opened.openingErrors,
    )
  }

  static inspectWriterLock = inspectWriterLock

  async putRaw(bytes: Uint8Array): Promise<CID> {
    return this.mutate(() => this.graph.putRaw(bytes))
  }

  async putValue(value: unknown): Promise<CID> {
    return this.mutate(() => this.graph.putValue(value))
  }

  async putBlock(block: StoredBlock): Promise<CID> {
    return this.mutate(() => this.graph.putBlock(block))
  }

  async getBlock(cid: CID): Promise<Uint8Array> {
    this.assertOpen()
    return this.graph.getBlock(cid)
  }

  async hasBlock(cid: CID): Promise<boolean> {
    this.assertOpen()
    return this.graph.hasBlock(cid)
  }

  async getValue(cid: CID): Promise<unknown> {
    this.assertOpen()
    return this.graph.getValue(cid)
  }

  async refs(cid: CID): Promise<readonly CID[]> {
    this.assertOpen()
    return this.graph.refs(cid)
  }

  async incoming(cid: CID): Promise<readonly Referrer[]> {
    this.assertOpen()
    return this.graph.incoming(cid)
  }

  async rebuildIndex(): Promise<void> {
    this.assertOpen()
    return this.enqueue(async () => {
      await this.graph.rebuildIndex()
    })
  }

  async verifyIndex(): Promise<readonly DerivedIssue[]> {
    this.assertOpen()
    return this.graph.verifyIndex()
  }

  async addRoot(cid: CID): Promise<void> {
    return this.mutate(async () => this.graph.addRoot(cid))
  }

  async removeRoot(cid: CID): Promise<boolean> {
    return this.mutate(() => this.graph.removeRoot(cid))
  }

  async roots(): Promise<readonly CID[]> {
    this.assertOpen()
    return this.graph.roots()
  }

  async reachable(start?: readonly CID[]): Promise<readonly CID[]> {
    this.assertOpen()
    return this.graph.reachable(start)
  }

  async planGc(): Promise<GcPlan> {
    this.assertOpen()
    return this.graph.planGc()
  }

  async gcCandidates(): Promise<readonly CID[]> {
    this.assertOpen()
    return this.graph.gcCandidates()
  }

  async commitGc(plan: GcPlan): Promise<GcResult> {
    return this.mutate(() => this.graph.commitGc(plan))
  }

  async verifyBlock(cid: CID): Promise<readonly BlockIssue[]> {
    this.assertOpen()
    return this.graph.verifyBlock(cid)
  }

  async fsck(): Promise<FsckReport> {
    this.assertOpen()
    return this.graph.fsck()
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    if (this.state === 'closing') {
      await this.mutationTail
      return
    }
    this.state = 'closing'
    await this.enqueue(async () => {
      if (this.writerLock !== undefined) await this.writerLock.release()
      this.state = 'closed'
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mode !== 'writer') throw new ReadOnlyRepositoryError()
    this.assertOpen()
    return this.enqueue(operation)
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release = (): void => undefined
    this.mutationTail = new Promise<void>((resolveTail) => {
      release = resolveTail
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private assertOpen(): void {
    if (this.state !== 'open') throw new ClosedRepositoryError()
  }
}

async function openWriter(
  path: string,
  codecs: CodecRegistry | undefined,
  create: boolean,
): Promise<OpenedRepository> {
  const lock = await ProcessWriterLock.acquire(path)
  try {
    const blocks = create
      ? await LooseFileBlockStore.create(path)
      : await LooseFileBlockStore.open(path)
    const roots = await AtomicFileRootStore.open(path)
    const graph = new RefGraph({
      blocks,
      roots,
      index: new MemoryReverseIndex(),
      ...(codecs === undefined ? {} : { codecs }),
    })
    await graph.rebuildIndex()
    return { graph, writerLock: lock, openingErrors: [] }
  } catch (error) {
    return releaseAfterOpenFailure(lock, error)
  }
}

async function openReadOnly(
  path: string,
  codecs: CodecRegistry | undefined,
): Promise<OpenedRepository> {
  const blocks = await LooseFileBlockStore.open(path)
  const roots = await AtomicFileRootStore.connect(path)
  const graph = new RefGraph({
    blocks,
    roots,
    index: new MemoryReverseIndex(),
    ...(codecs === undefined ? {} : { codecs }),
  })
  const openingErrors: Error[] = []
  try {
    await roots.list()
  } catch (error) {
    openingErrors.push(asError(error))
  }
  try {
    await graph.rebuildIndex()
  } catch (error) {
    openingErrors.push(asError(error))
  }
  return { graph, openingErrors }
}

async function createRepositoryDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE })
  } catch (error) {
    if (!isNodeError(error, 'EEXIST'))
      throw new StorageIoError('repository creation', { cause: error })
  }
  try {
    const metadata = await lstat(path)
    if (!metadata.isDirectory())
      throw new UnsafeFilesystemEntryError(path, 'expected repository directory')
  } catch (error) {
    if (error instanceof UnsafeFilesystemEntryError) throw error
    throw new StorageIoError('repository validation', { cause: error })
  }
}

async function releaseAfterOpenFailure(lock: ProcessWriterLock, cause: unknown): Promise<never> {
  try {
    await lock.release()
  } catch (releaseError) {
    throw new AggregateError(
      [cause, releaseError],
      'repository open and writer lock release failed',
    )
  }
  throw cause
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
