# Spec: Utility Capability Broker

## Problem

Seven Au Pair review jobs in live loop 140 failed closed after three rejected
tool rounds. Every job requested an exact SHA-256 over one or more declared
files, but the broker exposed no file-inspection tool that could produce a
hash. The workers therefore tried `sha256sum`, `shasum`, `openssl`, raw `git`,
or raw `node`; the command broker correctly rejected those executables. This
was a capability-contract mismatch, not a provider or model failure.

The worker also receives tool schemas without a compact, replayable statement
of the effective tool names, read/write scopes, command prefixes, and safe
replacement for a denied shell-shaped operation. That makes policy discovery
depend on rejection and wastes bounded model rounds.

## Goal

Make the harness broker the single authority boundary while giving Nanny and
Au Pair every safe, bounded inspection capability they need for common review
work. Add first-class file metadata/hashing and JSON inspection tools, bind the
effective capability map into each immutable context capsule, and direct the
worker to use broker tools instead of probing denied executables.

## In scope

- Add `inspect_files` for one to eight declared regular files. Return path,
  byte count, SHA-256, newline count, and text/binary kind without returning
  file contents or spawning a command.
- Add `read_json` for one declared regular JSON file and one to sixteen JSON
  Pointers. Return only the selected bounded values and explicit found/missing
  state without spawning a command.
- Apply existing repository containment, protected-path, symlink, file-size,
  and output-size policy to both tools.
- Add a versioned capability map to every utility context capsule containing
  the tools exposed for that exact job, declared scopes, effective allowlisted
  command prefixes, and broker-tool alternatives for hash, JSON, Git, line
  count, search, and file reads.
- Instruct workers to use the capability map, never use `run_check` for an
  operation with a dedicated broker tool, and stop after one unavailable
  alternative rather than probing sibling executables.
- Include the effective command prefixes and dedicated-tool alternatives in
  command-denial feedback.
- Add producer-backed regressions using the live loop-140 failure shape.

## Non-goals

- Arbitrary shell, arbitrary executables, eval-capable runtimes, package
  installation, or repository-provided scripts outside the allowlist.
- Credential access, unrestricted environment variables, network access,
  remote mutation, destructive actions, process control, or release authority.
- Expanding read or write scope beyond the request admitted by Governess.
- Letting project instructions, model output, or a repository policy override
  protected paths or governing authority.
- Treating a policy refusal as approval or allowing workers to merge, deploy,
  or issue final review verdicts.

## Acceptance criteria

- [ ] `inspect_files` returns independently reproducible SHA-256, byte, line,
      and kind metadata for one to eight declared files without command
      execution or content disclosure.
- [ ] `read_json` implements bounded RFC 6901 pointer lookup and never returns
      undeclared sibling data.
- [ ] Both tools reject duplicates, directories, symlinks, protected paths,
      out-of-scope paths, oversized files, malformed JSON/pointers, and output
      overflow.
- [ ] Each persisted context capsule contains the exact exposed tool names,
      declared scopes, command prefixes, and dedicated safe alternatives, and
      the capsule hash changes when that capability map changes.
- [ ] The system prompt tells helpers to use `inspect_files` for hashes and
      `read_json` for JSON, and forbids probing denied executables.
- [ ] A loop-140-shaped review job can hash all declared files with one broker
      call and zero command-denied events.
- [ ] Existing focused checks, reads, search, Git inspection, patch proposal,
      protected-path enforcement, and bounded-output behavior remain green.
- [ ] Focused tests, full tests, static checks, build, diff checks, and the
      governed verification gate pass before exact-SHA supervisor review.

