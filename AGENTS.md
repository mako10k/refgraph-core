# Contributor guardrails

- This package is domain-neutral. Do not add application identity, relation, authorization, tenancy, protocol, or UI concepts.
- A link is only a CID edge. Never interpret field names or link meaning.
- Immutable block bytes and their CID are canonical. Reverse indexes and roots are separate operational state.
- Unknown codecs fail closed for graph traversal and garbage collection.
- Do not make destructive GC implicit. Candidate inspection must precede an explicit commit.
- Prefer IPLD and Multiformats primitives over local identity, encoding, or canonicalization schemes.
- Changes to public interfaces require an architecture note and compatibility consideration.
- The first persistent adapter follows `docs/adr/0001-loose-file-single-writer-storage.md`: Linux
  local filesystems, CID-visible loose files, atomic roots, and one lifetime process writer lock.
- Never auto-break a writer lock. Stale-lock recovery is an offline evidence and quarantine boundary.
- Never follow symlinks or interpret malformed/non-regular filesystem entries as canonical blocks.
- Keep filesystem mutation behind `LocalRepository`; do not export individual mutable filesystem
  adapters before a lifecycle boundary provides equivalent writer ownership.
- Persistent integration and package smoke tests must use isolated temporary repositories and close
  writers before cleanup. A test must never auto-break or silently repair a retained lock.
- Before changing a decision represented in SealGraph, run read-only `sealgraph impact` on its exact
  current generation and review downstream REFs before updating or auditing the corresponding
  llmthink document. SealGraph impact is structural evidence, not change authority.
- SealGraph and llmthink may later be rebuilt as applications over this stack, but that future
  direction must remain in upper repositories. Do not import their identities or semantics into
  `refgraph-core`.
