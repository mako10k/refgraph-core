# ADR 0001: Loose-file storage with a single process writer

- Status: accepted
- Date: 2026-08-18
- Scope: the first persistent local adapter for `refgraph-core`

## Context

The core interfaces are asynchronous and backend-neutral, but the repository currently ships only
in-memory implementations. The selected first persistent adapter stores immutable blocks as loose
files, operational roots in one atomically replaced document, and the reverse index only in memory.

A CID-derived filename exposes the existence and equality of stored blocks to anyone who can list
the repository. `refgraph-core` does not promise CID confidentiality. Directory access, encrypted
filesystems, snapshots, and backup visibility remain storage and operating-system responsibilities.

The current `RefGraph` mutex serializes mutations only inside one JavaScript object. It does not
exclude another process or a second `RefGraph` instance using the same files. Safe root updates and
GC therefore require a repository-scoped writer lock.

## Decision

### Supported persistence environment

The first persistent adapter guarantees durability and exclusion only on Linux local filesystems
that provide the following semantics:

- atomic same-filesystem `link(2)`, `rename(2)`, and `mkdir(2)` operations;
- file and directory `fsync(2)`;
- reliable exclusive creation and regular-file metadata;
- process-local Node.js filesystem behavior consistent with those primitives.

NFS, SMB, FUSE implementations without equivalent guarantees, distributed filesystems, Windows,
and macOS are not guaranteed by the first adapter. The in-memory backend remains portable. A future
adapter may add another platform contract without changing CID identity or graph semantics.

An unsupported environment must not silently downgrade durability or locking. Repository open must
fail before mutation readiness when required primitives or the accepted layout cannot be verified.

### Repository layout

The layout is versioned independently of block identity:

```text
repository/
  FORMAT
  writer.lock
  blocks/<digest-byte-0>/<digest-byte-1>/<canonical-cid>.block
  roots.v1.json
  tmp/
  lock-quarantine/
```

`FORMAT` identifies the repository layout version. Shards are the first two SHA-256 digest bytes in
lowercase hexadecimal, not the low-entropy CID string prefix. The filename is the canonical CID
string. Paths are always derived internally from a parsed CID; callers never provide relative block
paths. Backend layout metadata does not participate in CID calculation.

Directories are created with mode `0700` and files with mode `0600`, subject to the host enforcing
POSIX permissions. Existing access policy is not broadened automatically.

### Immutable block publication

For a block write, the adapter:

1. verifies the CID, supported multihash, codec policy, and exact bytes before filesystem mutation;
2. writes a uniquely named file under `tmp/` with exclusive creation;
3. writes all bytes, syncs the file, and closes it;
4. creates the destination with an atomic hard link, which must fail if the CID path already exists;
5. syncs the destination shard directory;
6. removes the temporary name and syncs `tmp/`.

If the destination already exists, the adapter reads and verifies it. Exact bytes make the put an
idempotent success; different or invalid bytes are immutable corruption. The adapter never replaces
an existing block file. Temporary residue is never enumerated as a block and may be reported for
explicit cleanup.

Only regular files at the exact derived location are blocks. Symlinks, directories, devices,
malformed filenames, noncanonical CID strings, and shard mismatches are unsafe entries. They are
reported and never followed, interpreted as blocks, moved, or repaired automatically.

### Operational roots

`roots.v1.json` is operational state, not an IPLD block and not part of CID identity. Its shape is:

```json
{ "version": 1, "roots": ["<canonical CID>"] }
```

Roots are unique and sorted by canonical CID string. An absent document means the initial empty root
set. Once present, empty, truncated, malformed, unsupported-version, duplicate, or noncanonical
content is operational-state corruption and must not be converted to an empty set.

Updates use an exclusively created temporary file, complete write, file sync, close, atomic rename,
and repository-directory sync. Injected failure must leave either the previous valid document or the
complete new document visible.

### Writer lifecycle and mutation authority

Repository open has explicit `read-only` and `writer` modes. Read-only mode may inventory, verify,
rebuild an in-memory reverse index, and calculate reachability, but mutation methods fail with a
stable read-only error. Writer mode must acquire `writer.lock` before exposing mutable adapters.

The writer lock is held for the complete writer repository lifetime, not acquired independently for
each method. Its exclusively created JSON record contains a format version, random ownership token,
PID, process start evidence where available, hostname, and acquisition time. The file is synced
before writer readiness. A second writer fails closed and receives the inspected owner record; it
does not wait indefinitely or steal the lock.

Orderly close verifies the private ownership token before unlinking the lock and syncing the
repository directory. A process may remove only the lock it acquired. `RefGraph`'s in-instance mutex
remains useful but is not the process exclusion authority.

### Stale lock recovery

A crashed writer leaves `writer.lock`. The first version provides read-only lock inspection but no
public API that automatically removes or overrides it. PID absence, elapsed time, or malformed
metadata alone is insufficient proof because of PID reuse, containers, copied repositories, clock
changes, and unavailable host evidence.

Recovery is an explicit offline operator procedure:

1. prevent all writers from accessing the repository;
2. retain and inspect `writer.lock` plus host/process evidence;
3. verify that no writer owns the repository;
4. atomically rename `writer.lock` into `lock-quarantine/` with a unique evidence-bearing name;
5. run read-only fsck before opening a new writer.

The library documents this boundary but does not infer authorization or perform the quarantine in
the first implementation. Deleting or replacing a lock while a writer may be alive violates the
adapter contract.

### Reverse index and GC

The first persistent adapter does not persist the reverse index. Repository open rebuilds it from
canonical blocks. An unsupported codec or immutable corruption prevents writer readiness; it is not
silently indexed as a leaf.

`planGc()` remains non-destructive. `commitGc()` runs only through a writer repository while its
process lock is held, recomputes the canonical scan, rejects a stale plan, and then deletes only the
recomputed candidates. A crash may leave a safe subset of candidates deleted and derived index
state incomplete; reopening rebuilds the index. All reachable blocks must remain present.

### Error classes

The adapter must distinguish at least:

- immutable block corruption;
- operational root corruption;
- writer lock contention;
- malformed or potentially stale lock state;
- unsupported platform or filesystem semantics;
- unsafe filesystem entry;
- read-only mutation attempt;
- ordinary I/O failure with its underlying cause retained.

These errors do not add graph or application semantics.

## Consequences

- CID identity is unchanged across memory, loose-file, or future backends.
- CID visibility is explicit and delegated to filesystem access controls.
- A conforming writer has a simple, auditable exclusion model.
- Crashes favor fail-closed recovery over automatic availability.
- The initial persistent adapter is intentionally not cross-platform.
- Index startup cost is proportional to stored canonical blocks.
- Multi-writer transactions, lock leasing, automatic stale-lock breaking, packed storage, encryption,
  and index persistence remain future adapter concerns.

## Acceptance boundary

This ADR fixes the contract only. It does not implement the adapter, mark its runtime behavior
available, authorize destructive recovery, publish a package, or change any upper-layer repository.
