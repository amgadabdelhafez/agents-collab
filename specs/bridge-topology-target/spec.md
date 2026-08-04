# Bridge topology target validation

## Problem

`send_message` accepts every known agent name even when the run manifest declares a smaller paired topology. A message to an absent agent is durably queued with no possible delivery route.

## Requirement

When a manifest declares pane agents, reject a target outside that declared set before writing the bridge ledger. Preserve topology-free standalone ledger bridges such as the agent channel.
