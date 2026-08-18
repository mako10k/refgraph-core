# Architecture

## Position and scope

`refgraph-core` is the lowest layer of the stack. It stores immutable IPLD blocks, discovers
untyped CID edges, maintains disposable derived indexes, and computes graph liveness from mutable
operational roots. It never assigns meaning to an edge.

The implementation has four boundaries:

1. `BlockStore` owns CID-addressed immutable bytes.
2. `CodecRegistry` decides which codecs can be decoded and how links are enumerated. The initial
   registry supports DAG-CBOR and raw.
3. `ReverseIndex` and `RootStore` own replaceable operational state.
4. `RefGraph` coordinates verified writes, canonical scans, fsck, and explicit garbage collection.

All interfaces are asynchronous so a filesystem, database, Git ODB, or existing blockstore adapter
can replace the in-memory implementations without changing CID identity.

## Core invariants

1. A stored key is a CID and its multihash must match the exact stored bytes.
2. Writes never replace different bytes at the same CID.
3. New core-created blocks use CIDv1 and SHA-256.
4. DAG-CBOR is accepted as deterministic only when decoding and re-encoding produces identical
   bytes.
5. Link extraction recursively visits every IPLD map, list, and nested value; field names are never
   inspected.
6. Raw blocks have no links. An unknown codec is not a leaf: canonical traversal and GC fail closed.
7. Forward links decoded from immutable blocks are canonical. The reverse index can be deleted and
   rebuilt and is never used to prove liveness.
8. Roots are mutable operational entry points and do not affect block identity.
9. Reachability is computed from roots and canonical forward links.
10. GC deletion requires an inspected plan and an explicit commit. A stale plan is rejected if the
    current roots or stored block set differ.
11. fsck reports immutable-block problems separately from repairable derived-state problems.
12. A persistent writer must hold the repository-scoped process lock for its complete mutable
    lifetime; the in-instance mutex is not cross-process exclusion.
13. Persistent block publication never replaces an existing CID path. Existing identical bytes are
    idempotent; any difference is immutable corruption.
14. Persistent root replacement is atomic operational state. Present-but-invalid root state never
    degrades to an empty root set.
15. Filesystem entries that are not regular files at exact CID-derived paths are never followed or
    inferred as blocks.

## Unknown codecs and hash algorithms

Blocks with a syntactically valid CID may be present in an adapter even when this version does not
support their codec or multihash. fsck reports them. Traversal, reachability, candidate calculation,
and GC abort rather than treating unknown content as a leaf. Public verified writes currently accept
SHA-256 CIDs only; support for another multihash requires registering an explicit verifier.

## Structural reverse index

Forward IPLD Links decoded from immutable blocks are canonical graph facts. The reverse index is a
derived physical access structure with exactly this logical mapping:

```text
target CID -> set of referrer block CIDs
```

It does not interpret field names or record why a link exists. If one block contains the same target
CID at multiple IPLD locations, `incoming(target)` returns that referrer once. Results are sorted by
canonical CID string for deterministic API behavior. IPLD locations are not retained because no
current core use case requires them.

`rebuildIndex()` performs a strict scan of every stored canonical block, builds a complete new map
separately, and calls `ReverseIndex.replace()` only after the scan succeeds. It is deterministic,
safe to rerun, and independent of roots or application semantics. A failed scan therefore leaves the
previous derived map available, but that older map must not be mistaken for a completeness claim;
the scan error remains authoritative. `verifyIndex()` computes the same expected map and compares it
with a derived snapshot. `fsck()` reports missing and extra edges as repairable `index-mismatch`
issues when canonical analysis succeeds. Immutable decode, hash, or codec problems remain block
issues and prevent a claim that the reverse index is complete.

Canonical block storage happens before derived maintenance. If a custom `ReverseIndex.replace()`
fails, the write operation surfaces that failure even though the immutable block may already be
present; the block remains valid, retry is idempotent, and `rebuildIndex()` can restore derived
availability. The shipped memory index builds its replacement before one assignment and does not
perform I/O. No index failure rewrites or rolls back canonical block bytes.

The current correctness-oriented write path stores one verified block and then rebuilds the entire
index. With `N` stored blocks and `E` decoded links, one rebuild is `O(N + E)` aside from codec and
I/O costs; repeated single-block ingestion can therefore approach quadratic total scanning work.
GC likewise performs canonical scans and rebuilds after deletion. This is accepted for the current
unspecified initial scale: the persistent repository keeps only a memory index, no workload or
benchmark currently justifies a broader incremental mutation contract, and whole-map replacement
keeps failure behavior simple. Incremental maintenance or a persistent structural index requires
measured need and must preserve canonical block success independently from derived maintenance.

The ownership boundary has three distinct levels:

1. The structural reverse index above belongs to `refgraph-core`.
2. A semantic reverse query belongs to `refgraph-semantic`: it resolves its external identity to
   internal CID candidates, calls core `incoming(CID)`, decodes those referrer blocks, and filters
   them using upper-layer meaning.
3. An optional materialized semantic index keyed by upper-layer identity and profile belongs to a
   semantic or application repository.

Neither upper level changes the core mapping or makes it canonical. A live reverse index is not
encoded as an ordinary IPLD graph object, and reverse edges are never used to prove reachability or
authorize GC.

## GC protocol

`planGc()` performs a strict canonical scan and returns live and candidate CIDs plus a fingerprint
of roots and stored CIDs. `commitGc(plan)` repeats the scan, rejects a stale or altered plan, then
deletes exactly its candidates. Index cleanup is derived maintenance; rebuilding it restores the
same result.

For the persistent adapter, the canonical rescan and deletion occur while one repository-scoped
writer lock is held. A crash may delete only a subset of garbage, but must never expose a path that
permits another conforming writer to change roots during that operation.

## Local repository lifecycle

`LocalRepository` is the public composition boundary for the first persistent adapter. Writer
creation or open acquires the repository process lock before exposing block or root mutation,
opens the loose-block and atomic-root adapters, and rebuilds the disposable reverse index from
canonical blocks. Any immutable corruption or unsupported codec aborts writer open and releases
the acquired lock. Read-only open takes no lock, denies all canonical mutation with a stable error,
and retains root-validation or index-rebuild failures in `openingErrors` so inspection can continue.

The composed repository delegates the neutral `RefGraph` API without exposing its mutable storage
adapters. Mutations and close share one queue; orderly close runs after earlier accepted mutations,
releases only the owned writer lock, and rejects later operations. The memory-only `RefGraph`
constructor remains supported and unchanged, so adding local persistence is backward-compatible.

## First persistent adapter

The accepted first persistence direction is a Linux local-filesystem loose block store, an
atomically replaced root document, and an in-memory reverse index rebuilt at repository open. CID
strings remain visible in filenames; confidentiality belongs to filesystem access, encryption, and
backup policy. The adapter does not claim equivalent guarantees on network filesystems, Windows, or
macOS.

Writer locks fail closed. A crashed writer's lock is inspected but never automatically stolen or
removed. Recovery requires an offline, evidence-retaining quarantine followed by read-only fsck.
The complete layout, durability sequence, lifecycle, error taxonomy, and recovery boundary are fixed
in [ADR 0001](adr/0001-loose-file-single-writer-storage.md).

## Non-goals

No semantic IDs or relations, authorization, tenants, network transport, daemon, discovery,
replication, Web API, MCP API, background GC, remote pinning, or application schema belongs here.
The first persistent adapter also excludes multi-writer transactions, automatic stale-lock recovery,
CID confidentiality, network filesystems, packed storage, encryption, and a persistent reverse
index.
