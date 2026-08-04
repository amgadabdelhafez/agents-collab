# Project World Model Research

## Research Question

What current graph-memory, code-graph, provenance, and world-model patterns can
ground Loop decisions without creating a second source of operational truth?

## Candidates Reviewed

- RepoGraph and CodexGraph: deterministic code structure and bounded subgraphs.
- Graphiti and Zep: temporal validity, supersession, episodes, and provenance.
- AriGraph: combined semantic and episodic state with decision-specific recall.
- HippoRAG 2: hybrid graph, passage, and factual retrieval.
- GraphRAG: derived community summaries for global sensemaking.
- A-Mem: emergent links and tags, unsuitable for authoritative mutation.
- PROV-O and SHACL: provenance vocabulary and graph validation patterns.
- SQLite: local recursive traversal, FTS5, transactions, and no daemon.

## Open-Source Patterns

- Preserve raw evidence beside derived relationships.
- Use validity windows and supersession instead of destructive replacement.
- Prefer deterministic extraction and treat model output as candidate knowledge.
- Retrieve a bounded decision-specific subgraph rather than the whole graph.
- Keep the index rebuildable from canonical sources.

## Reuse Decision

Build Phase 0 over bundled bun:sqlite with no new service or model dependency.
Borrow temporal, episodic, and provenance semantics from the reviewed systems.
Reconsider Graphiti only after a frozen competency-question bakeoff proves the
embedded implementation insufficient.

## Sources

- https://proceedings.iclr.cc/paper_files/paper/2025/file/4a4a3c197deac042461c677219efd36c-Paper-Conference.pdf
- https://aclanthology.org/2025.naacl-long.7/
- https://arxiv.org/abs/2501.13956
- https://github.com/getzep/graphiti
- https://arxiv.org/abs/2407.04363
- https://arxiv.org/abs/2502.14802
- https://arxiv.org/abs/2404.16130
- https://papers.nips.cc/paper_files/paper/2025/hash/19909c36f51abc4856b4560aff3d36d6-Abstract-Conference.html
- https://proceedings.mlr.press/v267/feng25p.html
- https://www.w3.org/TR/prov-o/
- https://www.w3.org/TR/shacl/
- https://www.sqlite.org/lang_with.html
- https://www.sqlite.org/fts5.html
