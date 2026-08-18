import type { CID } from 'multiformats/cid'

export interface StoredBlock {
  readonly cid: CID
  readonly bytes: Uint8Array
}

export interface BlockStore {
  put(cid: CID, bytes: Uint8Array): Promise<void>
  get(cid: CID): Promise<Uint8Array | undefined>
  has(cid: CID): Promise<boolean>
  delete(cid: CID): Promise<boolean>
  iterate(): AsyncIterable<StoredBlock>
}

export interface Referrer {
  readonly cid: CID
}

export interface ReverseIndex {
  incoming(target: CID): Promise<readonly Referrer[]>
  replace(entries: ReadonlyMap<string, ReadonlyMap<string, Referrer>>): Promise<void>
  snapshot(): Promise<ReadonlyMap<string, ReadonlyMap<string, Referrer>>>
}

export interface RootStore {
  add(cid: CID): Promise<void>
  delete(cid: CID): Promise<boolean>
  list(): Promise<readonly CID[]>
}

export interface CodecAdapter {
  readonly code: number
  readonly name: string
  readonly leaf: boolean
  decode(bytes: Uint8Array): unknown
  encode(value: unknown): Uint8Array
  links(value: unknown): readonly CID[]
}

export type BlockIssueCode =
  | 'cid-mismatch'
  | 'unsupported-hash'
  | 'unsupported-codec'
  | 'decode-failed'
  | 'non-deterministic-encoding'

export interface BlockIssue {
  readonly cid: CID
  readonly code: BlockIssueCode
  readonly message: string
}

export type DerivedIssueCode = 'dangling-link' | 'index-mismatch' | 'missing-root'

export interface DerivedIssue {
  readonly code: DerivedIssueCode
  readonly message: string
  readonly cid: CID
  readonly related?: CID
}

export interface FsckReport {
  readonly ok: boolean
  readonly blockIssues: readonly BlockIssue[]
  readonly derivedIssues: readonly DerivedIssue[]
  readonly stored: readonly CID[]
  readonly reachable?: readonly CID[]
  readonly gcCandidates?: readonly CID[]
}

export interface GcPlan {
  readonly fingerprint: string
  readonly live: readonly CID[]
  readonly candidates: readonly CID[]
}

export interface GcResult {
  readonly deleted: readonly CID[]
}
