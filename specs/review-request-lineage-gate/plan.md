# Plan

1. Add a fail-closed review-request emitter.
2. Resolve candidate and required tip to full commit SHAs.
3. Require ancestry plus all deployed-protection symbols from committed blobs.
4. Emit the request body and machine-readable stamp only after every check passes.
5. Cover pass, sibling-lineage refusal, and missing-symbol refusal.
6. Wrap the durable channel sender so only stamped output can reach it.
7. Prove gate failure makes zero sender calls.
