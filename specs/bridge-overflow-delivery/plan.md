# Plan: Bridge Overflow Delivery

1. Extend the bridge event vocabulary with a durable `reported` receipt.
2. Derive unreported dead letters from the authoritative event sequence.
3. Expose and consume those records only through `receive_messages`.
4. Add explicit `deliveryStatus` and `failureReason` fields to dead-letter
   output while preserving the ordinary inbox shape.
5. Add queue-health accounting and regressions based on a captured xchan
   producer fixture plus bounded multi-batch coverage.
6. Serialize concurrent dead-letter reporting with a crash-recoverable,
   per-message filesystem claim.
7. Record focused, full, check, build, and eval evidence without installing or
   deploying a binary.
