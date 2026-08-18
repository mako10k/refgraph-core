import * as dagCbor from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { CodecRegistry } from './codecs.js'
import {
  IntegrityError,
  MissingBlockError,
  StaleGcPlanError,
  UnsupportedCodecError,
  UnsupportedHashError,
} from './errors.js'
import { bytesEqual, MemoryReverseIndex, MemoryRootStore } from './memory.js'
import type {
  BlockIssue,
  BlockStore,
  DerivedIssue,
  FsckReport,
  GcPlan,
  GcResult,
  Referrer,
  ReverseIndex,
  RootStore,
  StoredBlock,
} from './types.js'

export interface RefGraphOptions {
  readonly blocks: BlockStore
  readonly index?: ReverseIndex
  readonly roots?: RootStore
  readonly codecs?: CodecRegistry
}

export class RefGraph {
  readonly blocks: BlockStore
  readonly index: ReverseIndex
  readonly rootStore: RootStore
  readonly codecs: CodecRegistry
  private writeTail: Promise<void> = Promise.resolve()

  constructor(options: RefGraphOptions) {
    this.blocks = options.blocks
    this.index = options.index ?? new MemoryReverseIndex()
    this.rootStore = options.roots ?? new MemoryRootStore()
    this.codecs = options.codecs ?? new CodecRegistry()
  }

  async putRaw(bytes: Uint8Array): Promise<CID> {
    return this.putEncoded(raw.code, bytes)
  }

  async putValue(value: unknown): Promise<CID> {
    return this.putEncoded(dagCbor.code, dagCbor.encode(value))
  }

  async putBlock(block: StoredBlock): Promise<CID> {
    return this.exclusive(async () => {
      await this.verifyForWrite(block.cid, block.bytes)
      await this.blocks.put(block.cid, block.bytes)
      await this.rebuildIndexUnlocked()
      return block.cid
    })
  }

  async getBlock(cid: CID): Promise<Uint8Array> {
    const bytes = await this.blocks.get(cid)
    if (bytes === undefined) throw new MissingBlockError(cid.toString())
    return bytes
  }

  async hasBlock(cid: CID): Promise<boolean> {
    return this.blocks.has(cid)
  }

  async getValue(cid: CID): Promise<unknown> {
    if (cid.code !== dagCbor.code) throw new UnsupportedCodecError(cid.code)
    const bytes = await this.getBlock(cid)
    await this.assertIntegrity(cid, bytes)
    const value = dagCbor.decode(bytes)
    if (!bytesEqual(dagCbor.encode(value), bytes)) {
      throw new IntegrityError(`non-deterministic DAG-CBOR bytes for ${cid.toString()}`)
    }
    return value
  }

  async refs(cid: CID): Promise<readonly CID[]> {
    const bytes = await this.getBlock(cid)
    await this.assertIntegrity(cid, bytes)
    return this.refsFromBlock(cid, bytes)
  }

  async incoming(cid: CID): Promise<readonly Referrer[]> {
    return this.index.incoming(cid)
  }

  async rebuildIndex(): Promise<void> {
    await this.exclusive(() => this.rebuildIndexUnlocked())
  }

  async verifyIndex(): Promise<readonly DerivedIssue[]> {
    const expected = await this.scanIndexStrict()
    return compareIndexes(expected, await this.index.snapshot())
  }

  async addRoot(cid: CID): Promise<void> {
    await this.exclusive(async () => this.rootStore.add(cid))
  }

  async removeRoot(cid: CID): Promise<boolean> {
    return this.exclusive(async () => this.rootStore.delete(cid))
  }

  async roots(): Promise<readonly CID[]> {
    return this.rootStore.list()
  }

  async reachable(start?: readonly CID[]): Promise<readonly CID[]> {
    const seen = new Map<string, CID>()
    const pending = [...(start ?? (await this.rootStore.list()))]
    while (pending.length > 0) {
      const cid = pending.pop()
      if (cid === undefined || seen.has(cid.toString())) continue
      seen.set(cid.toString(), cid)
      const bytes = await this.blocks.get(cid)
      if (bytes === undefined) continue
      await this.assertIntegrity(cid, bytes)
      for (const link of this.refsFromBlock(cid, bytes)) pending.push(link)
    }
    return sortCids(seen.values())
  }

  async planGc(): Promise<GcPlan> {
    return this.calculateGcPlan()
  }

  async gcCandidates(): Promise<readonly CID[]> {
    return (await this.planGc()).candidates
  }

  async commitGc(plan: GcPlan): Promise<GcResult> {
    return this.exclusive(async () => {
      const current = await this.calculateGcPlan()
      if (
        current.fingerprint !== plan.fingerprint ||
        !sameCids(current.candidates, plan.candidates)
      ) {
        throw new StaleGcPlanError()
      }
      const deleted: CID[] = []
      for (const cid of plan.candidates) {
        if (await this.blocks.delete(cid)) deleted.push(cid)
      }
      await this.rebuildIndexUnlocked()
      return { deleted }
    })
  }

  async verifyBlock(cid: CID): Promise<readonly BlockIssue[]> {
    const bytes = await this.getBlock(cid)
    return this.inspectBlock(cid, bytes)
  }

  async fsck(): Promise<FsckReport> {
    const storedBlocks = await collectBlocks(this.blocks)
    const blockIssues: BlockIssue[] = []
    const derivedIssues: DerivedIssue[] = []
    const expectedIndex = new Map<string, Map<string, Referrer>>()
    const inventory = new Map(storedBlocks.map(({ cid }) => [cid.toString(), cid]))

    for (const block of storedBlocks) {
      const issues = await this.inspectBlock(block.cid, block.bytes)
      blockIssues.push(...issues)
      if (issues.length > 0) continue
      for (const target of this.refsFromBlock(block.cid, block.bytes)) {
        addIndexEdge(expectedIndex, target, block.cid)
        if (!inventory.has(target.toString())) {
          derivedIssues.push({
            code: 'dangling-link',
            cid: block.cid,
            related: target,
            message: `${block.cid.toString()} links to missing ${target.toString()}`,
          })
        }
      }
    }

    if (blockIssues.length === 0) {
      derivedIssues.push(...compareIndexes(expectedIndex, await this.index.snapshot()))
    }
    for (const root of await this.rootStore.list()) {
      if (!inventory.has(root.toString())) {
        derivedIssues.push({
          code: 'missing-root',
          cid: root,
          message: `root is missing: ${root.toString()}`,
        })
      }
    }

    let reachable: readonly CID[] | undefined
    let gcCandidates: readonly CID[] | undefined
    if (blockIssues.length === 0) {
      reachable = await this.reachable()
      const live = new Set(reachable.map(String))
      gcCandidates = storedBlocks.map(({ cid }) => cid).filter((cid) => !live.has(cid.toString()))
    }
    const report: FsckReport = {
      ok: blockIssues.length === 0 && derivedIssues.length === 0,
      blockIssues,
      derivedIssues,
      stored: storedBlocks.map(({ cid }) => cid),
      ...(reachable === undefined ? {} : { reachable }),
      ...(gcCandidates === undefined ? {} : { gcCandidates }),
    }
    return report
  }

  private async putEncoded(code: number, bytes: Uint8Array): Promise<CID> {
    const digest = await sha256.digest(bytes)
    return this.putBlock({ cid: CID.create(1, code, digest), bytes })
  }

  private async verifyForWrite(cid: CID, bytes: Uint8Array): Promise<void> {
    const codec = this.codecs.get(cid.code)
    if (codec === undefined) throw new UnsupportedCodecError(cid.code)
    await this.assertIntegrity(cid, bytes)
    let value: unknown
    try {
      value = codec.decode(bytes)
    } catch (error) {
      throw new IntegrityError(`invalid ${codec.name} bytes: ${errorMessage(error)}`)
    }
    if (!this.codecs.isDeterministic(codec, bytes, value)) {
      throw new IntegrityError(`non-deterministic ${codec.name} bytes for ${cid.toString()}`)
    }
  }

  private async assertIntegrity(cid: CID, bytes: Uint8Array): Promise<void> {
    if (cid.multihash.code !== sha256.code) throw new UnsupportedHashError(cid.multihash.code)
    const expected = CID.create(cid.version, cid.code, await sha256.digest(bytes))
    if (!cid.equals(expected))
      throw new IntegrityError(`CID does not match bytes: ${cid.toString()}`)
  }

  private refsFromBlock(cid: CID, bytes: Uint8Array): readonly CID[] {
    const codec = this.codecs.get(cid.code)
    if (codec === undefined) throw new UnsupportedCodecError(cid.code)
    const value = codec.decode(bytes)
    if (!this.codecs.isDeterministic(codec, bytes, value)) {
      throw new IntegrityError(`non-deterministic ${codec.name} bytes for ${cid.toString()}`)
    }
    return codec.links(value)
  }

  private async inspectBlock(cid: CID, bytes: Uint8Array): Promise<readonly BlockIssue[]> {
    if (cid.multihash.code !== sha256.code) {
      return [
        {
          cid,
          code: 'unsupported-hash',
          message: `unsupported multihash 0x${cid.multihash.code.toString(16)}`,
        },
      ]
    }
    const expected = CID.create(cid.version, cid.code, await sha256.digest(bytes))
    if (!cid.equals(expected))
      return [{ cid, code: 'cid-mismatch', message: 'CID does not match stored bytes' }]
    const codec = this.codecs.get(cid.code)
    if (codec === undefined)
      return [
        { cid, code: 'unsupported-codec', message: `unsupported codec 0x${cid.code.toString(16)}` },
      ]
    let value: unknown
    try {
      value = codec.decode(bytes)
    } catch (error) {
      return [{ cid, code: 'decode-failed', message: errorMessage(error) }]
    }
    try {
      if (!this.codecs.isDeterministic(codec, bytes, value)) {
        return [
          {
            cid,
            code: 'non-deterministic-encoding',
            message: `${codec.name} bytes are not canonical`,
          },
        ]
      }
    } catch (error) {
      return [{ cid, code: 'non-deterministic-encoding', message: errorMessage(error) }]
    }
    return []
  }

  private async rebuildIndexUnlocked(): Promise<void> {
    await this.index.replace(await this.scanIndexStrict())
  }

  private async scanIndexStrict(): Promise<Map<string, Map<string, Referrer>>> {
    const entries = new Map<string, Map<string, Referrer>>()
    for await (const block of this.blocks.iterate()) {
      await this.assertIntegrity(block.cid, block.bytes)
      for (const target of this.refsFromBlock(block.cid, block.bytes))
        addIndexEdge(entries, target, block.cid)
    }
    return entries
  }

  private async calculateGcPlan(): Promise<GcPlan> {
    // The strict scan proves every stored block has a supported codec before any candidate is exposed.
    await this.scanIndexStrict()
    const stored = (await collectBlocks(this.blocks)).map(({ cid }) => cid)
    const roots = await this.rootStore.list()
    const live = await this.reachable(roots)
    const liveKeys = new Set(live.map(String))
    const candidates = stored.filter((cid) => !liveKeys.has(cid.toString()))
    return { fingerprint: await fingerprint(roots, stored), live, candidates }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail
    let release = (): void => undefined
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function addIndexEdge(index: Map<string, Map<string, Referrer>>, target: CID, referrer: CID): void {
  const targetKey = target.toString()
  const incoming = index.get(targetKey) ?? new Map<string, Referrer>()
  incoming.set(referrer.toString(), { cid: referrer })
  index.set(targetKey, incoming)
}

function compareIndexes(
  expected: ReadonlyMap<string, ReadonlyMap<string, Referrer>>,
  actual: ReadonlyMap<string, ReadonlyMap<string, Referrer>>,
): DerivedIssue[] {
  const expectedEdges = flattenIndex(expected)
  const actualEdges = flattenIndex(actual)
  const issues: DerivedIssue[] = []
  for (const [key, edge] of expectedEdges) {
    if (!actualEdges.has(key)) {
      issues.push({
        code: 'index-mismatch',
        cid: edge.referrer,
        related: edge.target,
        message: `missing index edge ${key}`,
      })
    }
  }
  for (const [key, edge] of actualEdges) {
    if (!expectedEdges.has(key)) {
      issues.push({
        code: 'index-mismatch',
        cid: edge.referrer,
        related: edge.target,
        message: `extraneous index edge ${key}`,
      })
    }
  }
  return issues.sort((a, b) => a.message.localeCompare(b.message))
}

function flattenIndex(
  index: ReadonlyMap<string, ReadonlyMap<string, Referrer>>,
): Map<string, { target: CID; referrer: CID }> {
  const edges = new Map<string, { target: CID; referrer: CID }>()
  for (const [targetKey, referrers] of index) {
    for (const referrer of referrers.values()) {
      edges.set(`${referrer.cid.toString()}->${targetKey}`, {
        target: CID.parse(targetKey),
        referrer: referrer.cid,
      })
    }
  }
  return edges
}

async function collectBlocks(store: BlockStore): Promise<StoredBlock[]> {
  const blocks: StoredBlock[] = []
  for await (const block of store.iterate()) blocks.push(block)
  return blocks.sort((a, b) => a.cid.toString().localeCompare(b.cid.toString()))
}

function sortCids(cids: Iterable<CID>): CID[] {
  return [...cids].sort((a, b) => a.toString().localeCompare(b.toString()))
}

function sameCids(a: readonly CID[], b: readonly CID[]): boolean {
  return a.length === b.length && a.every((cid, index) => cid.equals(b[index] as CID))
}

async function fingerprint(roots: readonly CID[], stored: readonly CID[]): Promise<string> {
  const text = `roots\n${sortCids(roots).join('\n')}\nblocks\n${sortCids(stored).join('\n')}`
  const digest = await sha256.digest(new TextEncoder().encode(text))
  return [...digest.digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
