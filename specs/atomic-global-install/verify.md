# Verification

- `bun run test:file -- tests/install.test.ts`
  - proves later source mutation does not change installed bytes;
  - proves the installed target is a regular non-symlink file;
  - proves a failed replacement preserves an existing target;
  - proves a source path swap cannot change the inode copied for publication;
  - proves an owned stage is cleaned after a post-reservation failure;
  - proves a forced temp collision preserves the foreign file;
  - proves simultaneous writers publish one complete snapshot;
  - proves failed operations leave no installer temporary artifacts;
  - proves Unix and Windows alias payloads remain correct.
- `bun run check`
- `bun run build`
- `git diff --check`
- An independent reviewer confirms that no code path removes the live target
  before staging and that same-directory rename is the only publication step.
- This macOS run does not claim Windows filesystem atomicity; it verifies the
  Windows payload/branch and fail-closed error design only.
- No verification command invokes `bun run install:global`.
