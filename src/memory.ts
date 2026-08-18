import type { CID } from 'multiformats/cid'
import type { BlockStore, Referrer, ReverseIndex, RootStore, StoredBlock } from './types.js'

export class MemoryBlockStore implements BlockStore {
  private readonly blocks = new Map<string, StoredBlock>()

  async put(cid: CID, bytes: Uint8Array): Promise<void> {
    const key = cid.toString()
    const current = this.blocks.get(key)
    if (current !== undefined && !bytesEqual(current.bytes, bytes)) {
      throw new Error(`refusing to replace bytes for CID ${key}`)
    }
    this.blocks.set(key, { cid, bytes: bytes.slice() })
  }

  async get(cid: CID): Promise<Uint8Array | undefined> {
    return this.blocks.get(cid.toString())?.bytes.slice()
  }

  async has(cid: CID): Promise<boolean> {
    return this.blocks.has(cid.toString())
  }

  async delete(cid: CID): Promise<boolean> {
    return this.blocks.delete(cid.toString())
  }

  async *iterate(): AsyncIterable<StoredBlock> {
    const blocks = [...this.blocks.values()].sort((a, b) =>
      a.cid.toString().localeCompare(b.cid.toString()),
    )
    for (const block of blocks) yield { cid: block.cid, bytes: block.bytes.slice() }
  }
}

export class MemoryReverseIndex implements ReverseIndex {
  private entries = new Map<string, Map<string, Referrer>>()

  async incoming(target: CID): Promise<readonly Referrer[]> {
    return [...(this.entries.get(target.toString())?.values() ?? [])].sort((a, b) =>
      a.cid.toString().localeCompare(b.cid.toString()),
    )
  }

  async replace(entries: ReadonlyMap<string, ReadonlyMap<string, Referrer>>): Promise<void> {
    this.entries = new Map([...entries].map(([target, referrers]) => [target, new Map(referrers)]))
  }

  async snapshot(): Promise<ReadonlyMap<string, ReadonlyMap<string, Referrer>>> {
    return new Map([...this.entries].map(([target, referrers]) => [target, new Map(referrers)]))
  }
}

export class MemoryRootStore implements RootStore {
  private readonly roots = new Map<string, CID>()

  async add(cid: CID): Promise<void> {
    this.roots.set(cid.toString(), cid)
  }

  async delete(cid: CID): Promise<boolean> {
    return this.roots.delete(cid.toString())
  }

  async list(): Promise<readonly CID[]> {
    return [...this.roots.values()].sort((a, b) => a.toString().localeCompare(b.toString()))
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
