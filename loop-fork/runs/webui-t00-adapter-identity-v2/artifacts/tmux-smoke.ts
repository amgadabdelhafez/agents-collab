import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import {
  captureTmuxAdapterIdentity,
  createTmuxAdapterContext,
  tmuxAdapterSessionLiveness,
} from "../../../src/loop/tmux-control";

const root = mkdtempSync(join(tmpdir(), "webui-t00-smoke-"));
const socketA = join(root, "a.sock");
const socketB = join(root, "b.sock");
const session = "same-name";

const tmux = (socketPath: string, ...args: string[]): void => {
  const result = spawnSync(["tmux", "-S", socketPath, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
};

const stop = (socketPath: string): void => {
  spawnSync(["tmux", "-S", socketPath, "kill-server"], {
    stderr: "ignore",
    stdout: "ignore",
  });
};

try {
  tmux(socketA, "new-session", "-d", "-s", session);
  tmux(socketB, "new-session", "-d", "-s", session);

  const firstA = captureTmuxAdapterIdentity(session, { socketPath: socketA });
  const firstB = captureTmuxAdapterIdentity(session, { socketPath: socketB });
  const contextA = createTmuxAdapterContext(firstA);
  const contextB = createTmuxAdapterContext(firstB);
  const initial = {
    a: tmuxAdapterSessionLiveness(contextA, session),
    b: tmuxAdapterSessionLiveness(contextB, session),
  };
  if (initial.a !== "live" || initial.b !== "live") {
    throw new Error(`two-socket isolation failed: ${JSON.stringify(initial)}`);
  }

  stop(socketA);
  rmSync(socketA, { force: true });
  tmux(socketA, "new-session", "-d", "-s", session);
  const reincarnatedA = captureTmuxAdapterIdentity(session, {
    socketPath: socketA,
  });
  const reincarnation = {
    new: tmuxAdapterSessionLiveness(
      createTmuxAdapterContext(reincarnatedA),
      session
    ),
    old: tmuxAdapterSessionLiveness(contextA, session),
  };
  if (reincarnation.old !== "unknown" || reincarnation.new !== "live") {
    throw new Error(
      `same-socket reincarnation failed: ${JSON.stringify(reincarnation)}`
    );
  }

  console.log(
    JSON.stringify(
      { firstA, firstB, initial, reincarnatedA, reincarnation },
      null,
      2
    )
  );
} finally {
  stop(socketA);
  stop(socketB);
  rmSync(root, { force: true, recursive: true });
}
