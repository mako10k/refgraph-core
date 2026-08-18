export class RefGraphError extends Error {
  override readonly name: string = 'RefGraphError'
}

export class UnsupportedCodecError extends RefGraphError {
  override readonly name = 'UnsupportedCodecError'

  constructor(readonly code: number) {
    super(`unsupported codec: 0x${code.toString(16)}`)
  }
}

export class UnsupportedHashError extends RefGraphError {
  override readonly name = 'UnsupportedHashError'

  constructor(readonly code: number) {
    super(`unsupported multihash: 0x${code.toString(16)}`)
  }
}

export class IntegrityError extends RefGraphError {
  override readonly name = 'IntegrityError'
}

export class MissingBlockError extends RefGraphError {
  override readonly name = 'MissingBlockError'

  constructor(readonly cidString: string) {
    super(`block not found: ${cidString}`)
  }
}

export class StaleGcPlanError extends RefGraphError {
  override readonly name = 'StaleGcPlanError'

  constructor() {
    super('GC plan is stale or does not match the current canonical scan')
  }
}

export class UnsupportedPlatformError extends RefGraphError {
  override readonly name = 'UnsupportedPlatformError'

  constructor(readonly platform: string) {
    super(`persistent loose-file storage is unsupported on platform: ${platform}`)
  }
}

export class UnsafeFilesystemEntryError extends RefGraphError {
  override readonly name = 'UnsafeFilesystemEntryError'

  constructor(
    readonly entry: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`unsafe filesystem entry ${JSON.stringify(entry)}: ${reason}`, options)
  }
}

export class StorageIoError extends RefGraphError {
  override readonly name = 'StorageIoError'

  constructor(operation: string, options: ErrorOptions) {
    super(`loose-file storage I/O failed during ${operation}`, options)
  }
}

export class RootStateCorruptionError extends RefGraphError {
  override readonly name = 'RootStateCorruptionError'

  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`roots.v1.json is corrupt: ${reason}`, options)
  }
}

export class WriterLockContendedError extends RefGraphError {
  override readonly name = 'WriterLockContendedError'

  constructor(readonly owner: unknown) {
    super('repository already has a process writer; inspect writer.lock without removing it')
  }
}

export class MalformedWriterLockError extends RefGraphError {
  override readonly name = 'MalformedWriterLockError'

  constructor(readonly reason: string) {
    super(`writer.lock is malformed or incomplete: ${reason}`)
  }
}

export class WriterLockOwnershipError extends RefGraphError {
  override readonly name = 'WriterLockOwnershipError'

  constructor() {
    super('writer.lock is no longer the exact lock owned by this process; refusing to remove it')
  }
}

export class ReadOnlyRepositoryError extends RefGraphError {
  override readonly name = 'ReadOnlyRepositoryError'

  constructor() {
    super('repository is read-only')
  }
}

export class ClosedRepositoryError extends RefGraphError {
  override readonly name = 'ClosedRepositoryError'

  constructor() {
    super('repository is closed')
  }
}
