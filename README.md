# @mako10k/refgraph-core

A small, domain-neutral local IPLD immutable reference graph engine. CID-addressed blocks and their
forward IPLD Links are canonical; reverse references and roots are replaceable operational state.

```ts
import { CID } from 'multiformats/cid'
import { MemoryBlockStore, RefGraph } from '@mako10k/refgraph-core'

const graph = new RefGraph({ blocks: new MemoryBlockStore() })
const leaf = await graph.putRaw(new TextEncoder().encode('payload'))
const root = await graph.putValue({ child: leaf })
await graph.addRoot(root)

const links: ReadonlySet<string> = new Set((await graph.refs(root)).map(String))
const live: ReadonlySet<string> = new Set((await graph.reachable()).map(String))

const plan = await graph.planGc() // inspection only
await graph.commitGc(plan) // explicit destructive action

CID.parse(root.toString()) // public identity is a normal CID
void links
void live
```

Unknown codecs fail closed during traversal and GC. `fsck()` distinguishes immutable block failures
from rebuildable index/root-state failures. See [the architecture](docs/architecture.md) and
[the complete example](examples/basic.ts).

For durable local storage on a supported Linux local filesystem:

```ts
import { LocalRepository } from '@mako10k/refgraph-core'

const repository = await LocalRepository.create('/path/to/repository')
try {
  const leaf = await repository.putRaw(new TextEncoder().encode('payload'))
  const root = await repository.putValue({ child: leaf })
  await repository.addRoot(root)

  const plan = await repository.planGc() // canonical dry-run
  // await repository.commitGc(plan)      // separate destructive decision
} finally {
  await repository.close()
}
```

See [the persistent example](examples/persistent.ts) for writer reopen and read-only inspection.

## Local persistence

`LocalRepository` composes the filesystem adapters without changing CID identity or graph
semantics. `create(path)` creates a writer repository. `open(path, { mode: 'writer' })` requires an
existing layout and acquires the lifetime process lock. `open(path, { mode: 'read-only' })` takes no
lock, permits inspection and in-memory index rebuild, and rejects block, root, and GC mutation.

```text
repository/
  blocks/<sha256-byte-0>/<sha256-byte-1>/<canonical-cid>.block
  tmp/
  roots.v1.json
  writer.lock
```

- This first adapter supports Linux local filesystems providing atomic link/rename/mkdir and file
  and directory `fsync`. It does not claim the same guarantees for network filesystems, Windows, or
  macOS.
- New directories and files use modes `0700` and `0600`. The library does not manage ACLs, mount
  policy, encryption, backups, or an existing directory's access policy.
- Canonical CID strings are filenames. CID confidentiality is therefore outside this package and
  must be enforced by filesystem visibility controls.
- `roots.v1.json` is a versioned, unique, sorted CID set. Updates use temporary write, file sync,
  atomic rename, and repository-directory sync. Absence is the initial empty set; present invalid
  state fails closed and is never replaced with an inferred empty set.
- The reverse index is memory-only and rebuilt from canonical blocks at open. Rebuild cost is
  proportional to stored blocks and links. Writer open rejects immutable corruption and unsupported
  codecs; read-only open retains those failures in `openingErrors` for inspection.
- A writer owns `writer.lock` for its full lifetime. Contention never waits, steals, or auto-breaks
  the lock. After a crash, inspect with `LocalRepository.inspectWriterLock(path)`, stop every writer,
  retain host/process evidence, quarantine the lock offline, run read-only verification, and only
  then open a new writer. The library intentionally provides no stale-lock removal API.
- Persistent GC remains two-phase. `planGc()` is non-destructive; `commitGc(plan)` rescans under the
  writer lock and rejects drift. A crash may leave some garbage undeleted, but reachable blocks are
  not candidates and a restart safely recomputes the remaining set.

Filesystem hazards and operational-state corruption use stable `RefGraphError` subclasses such as
`StorageIoError`, `UnsafeFilesystemEntryError`, `RootStateCorruptionError`, and
`WriterLockContendedError`. Immutable block failures remain `IntegrityError`; derived index state is
rebuildable and never rewrites damaged immutable content.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm run check
npm pack --dry-run
```

## Public surface

`RefGraph` provides verified block/value writes, reads, generic `refs`, reverse `incoming`, index
rebuild/verification, roots, reachability, fsck, and two-phase GC. Storage boundaries are
`BlockStore`, `ReverseIndex`, and `RootStore`; deterministic in-memory implementations are included.
`LocalRepository` is the public filesystem composition boundary; individual filesystem adapters are
not package exports.

Licensed under MIT.
