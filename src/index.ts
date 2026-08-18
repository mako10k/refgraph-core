export { CodecRegistry, dagCborAdapter, rawAdapter } from './codecs.js'
export {
  IntegrityError,
  ClosedRepositoryError,
  MissingBlockError,
  ReadOnlyRepositoryError,
  RefGraphError,
  RootStateCorruptionError,
  StaleGcPlanError,
  StorageIoError,
  UnsafeFilesystemEntryError,
  UnsupportedCodecError,
  UnsupportedHashError,
  UnsupportedPlatformError,
  WriterLockContendedError,
} from './errors.js'
export { LocalRepository } from './local-repository.js'
export type { OpenRepositoryOptions, RepositoryMode } from './local-repository.js'
export { MemoryBlockStore, MemoryReverseIndex, MemoryRootStore } from './memory.js'
export { RefGraph } from './ref-graph.js'
export type { RefGraphOptions } from './ref-graph.js'
export type {
  BlockIssue,
  BlockIssueCode,
  BlockStore,
  CodecAdapter,
  DerivedIssue,
  DerivedIssueCode,
  FsckReport,
  GcPlan,
  GcResult,
  Referrer,
  ReverseIndex,
  RootStore,
  StoredBlock,
} from './types.js'
