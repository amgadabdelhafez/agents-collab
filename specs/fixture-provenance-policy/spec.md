# Spec: Cross-Component Fixture Provenance

## Problem

Hand-authored test fixtures can accidentally encode a consumer's expectation
instead of the producer's real output. Run-102 exposed this gap: unit and smoke
fixtures modeled a shortened Claude startup modal and omitted the real transient
warning, so they could not certify the startup seam they represented.

## Goal

Any fixture used to certify a cross-component or cross-process seam carries
reproducible producer provenance, while explicitly synthetic fixtures remain
available for isolated unit behavior but cannot certify integration.

## Non-goals

- Do not capture or commit secrets, credentials, or personal data.
- Do not retroactively rewrite every existing fixture in this slice.
- Do not manufacture a run-102 Claude modal that was not captured raw.

## Acceptance criteria

- [ ] `evals/README.md` defines required producer/version/capture/raw evidence and
      deterministic normalization metadata.
- [ ] It distinguishes captured fixtures from labeled synthetic fixtures and
      states that synthetic fixtures cannot certify an integration seam.
- [ ] The verification template makes fixture provenance an explicit checklist.
- [ ] The rule requires sanitization before commit and preserves a raw SHA/reference
      when raw bytes cannot safely be checked in.
