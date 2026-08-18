# SealGraph projection of the loose-file storage audit

This standalone SealGraph graph reproduces the `based_on` DAG from
[`docs/loose-file-storage-audit.think`](../loose-file-storage-audit.think). It is development
provenance only and is not imported by, or a runtime dependency of, `refgraph-core`.

## Projection rule

- One llmthink statement ID becomes one logical SealGraph REF under
  `audit/loose-file-storage/<ID>`.
- A llmthink `based_on X` reference becomes an exact immutable SealGraph Cause edge to REF `X`'s
  current sealed generation at projection time.
- Each Seal content is a small projection record identifying the source document, statement ID,
  and role. The full reasoning remains in the `.think` document.
- Statements without `based_on` are explicit SealGraph roots. Root means provenance boundary only,
  not truth, approval, or trust.
- SealGraph Cause edges have no persisted role name. This projection preserves DAG topology, not
  llmthink's `problem`, `evidence`, `premise`, or `decision` semantics.
- Revision-parent edges are unused. Every projected REF has one initial generation.

## Frozen node and edge inventory

| Statement | Role     | Exact `based_on` / Cause targets        |
| --------- | -------- | --------------------------------------- |
| P1        | problem  | root                                    |
| EV1       | evidence | root                                    |
| EV2       | evidence | root                                    |
| EV3       | evidence | root                                    |
| EV4       | evidence | root                                    |
| PR1       | premise  | root                                    |
| PR2       | premise  | root                                    |
| D1        | decision | P1, EV1, EV4, PR1                       |
| D2        | decision | P1, EV1, PR2                            |
| D3        | decision | P1, EV4, PR2                            |
| D4        | decision | P1, EV2, EV3, PR2                       |
| D5        | decision | P1, EV3, EV4                            |
| D6        | decision | P1, EV1, PR2                            |
| D7        | decision | P1, EV2, EV3, EV4                       |
| D9        | decision | P1, EV1, EV4                            |
| D10       | decision | P1, EV2, EV3, PR2                       |
| D8        | decision | P1, D1, D2, D3, D4, D5, D6, D7, D9, D10 |

The projection intentionally excludes framework/domain declarations, step containers, file
resources, and inferred audit hints because none is a llmthink `based_on` DAG statement or edge.

## Verification

The canonical graph is stored in `.sealgraph/config`, `.sealgraph/objects/`, and
`.sealgraph/refs/seals/`. Runtime candidate, cache, lock, and log paths are ignored.

Verify without repair:

```sh
sealgraph fsck --format json
sealgraph graph --format json
```

The expected inventory is 17 current REFs, 17 Seals, zero revision-parent edges, and 41 Cause
edges. A SealGraph success is provenance-structure evidence; it does not replace the llmthink
semantic audit.

For subsequent decision changes, inspect the exact current statement generation with
`sealgraph impact` before editing or auditing the `.think` document. Review all returned downstream
REFs, then use llmthink for semantic audit. Impact is read-only structural evidence and does not
authorize a reseal or implementation change.

SealGraph and llmthink are expected future application candidates for the immutable reference-graph
stack. This projection records that development direction without adding either application's
identity or edge semantics to `refgraph-core`.
