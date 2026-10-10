// Claude Code first-run prompts in a fresh workspace (fix8-launch-startup).
//
// Observed 2026-10-11 in a freshly created git repo with the installed r7
// build: `loop --tmux -p "..."` waited 22 s on Claude Code's folder trust
// dialog and failed with the generic "did not reach an input-ready prompt"
// error. Once the folder was trusted by hand, the development-channels prompt
// for the run's own loop-bridge server followed. Every capture here is a fake
// pane; no tmux server and no Claude process is involved.

import { expect, test } from "bun:test";
import { tmuxInternals } from "../../src/loop/tmux";

const WORKSPACE = "/Users/dev/dummy-project";
const CHANNEL = "loop-bridge-dummy-project-1";

interface Startup {
  channelServer: string | undefined;
  trustWorkspace: boolean;
  workspacePaths: string[];
}

const startup = (overrides: Partial<Startup> = {}): Startup => ({
  channelServer: CHANNEL,
  trustWorkspace: false,
  workspacePaths: [WORKSPACE],
  ...overrides,
});

/** The trust dialog as the live pane showed it: exit selected first. */
const trustDialog = (
  selected: "exit" | "trust",
  path: string = WORKSPACE
): string =>
  [
    "─".repeat(80),
    " Do you trust this folder?",
    "",
    ` ${path}`,
    "",
    " Claude Code will be able to read, edit, and execute files here.",
    "",
    selected === "exit" ? " ❯ No, exit" : "   No, exit",
    selected === "trust"
      ? " ❯ Yes, I trust this folder"
      : "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

/** The development-channels prompt naming `channels` (wrapped at `width`). */
const devChannelPrompt = (channels: string, width = 200): string => {
  const listed = `  Channels: ${channels}`;
  const rows: string[] = [];
  for (let start = 0; start < listed.length; start += width) {
    rows.push(listed.slice(start, start + width));
  }
  return [
    "  WARNING: Loading development channels",
    "",
    "  --dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.",
    "",
    "  Please use --channels to run a list of approved channels.",
    "",
    ...rows,
    "",
    "  ❯ 1. I am using this for local development",
    "    2. Exit",
    "",
    "  Enter to confirm · Esc to cancel",
  ].join("\n");
};

interface Pane {
  keys: string[][];
  sleeps: number;
}

/**
 * Drives `unblockClaudePane` over a scripted pane. `next` maps the keys sent
 * so far to the current frame; the pane's activity advances on every key.
 */
const drive = async (
  frame: (keys: string[][]) => string,
  context: Startup
): Promise<Pane> => {
  const pane: Pane = { keys: [], sleeps: 0 };
  await tmuxInternals.unblockClaudePane(
    "%2",
    {
      capturePane: () => frame(pane.keys),
      capturePaneSnapshot: () => ({
        activeClients: 0,
        cursor: { x: -1, y: -1 },
        pipeOpen: false,
        text: frame(pane.keys),
        windowActivity: 100 + pane.keys.length,
      }),
      nowMs: () => 0,
      sendKeys: (_pane, keys) => {
        pane.keys.push(keys);
      },
      sleep: () => {
        pane.sleeps += 1;
        return Promise.resolve();
      },
    },
    context
  );
  return pane;
};

const driveRejected = async (
  frame: (keys: string[][]) => string,
  context: Startup,
  message: string
): Promise<Pane> => {
  const pane: Pane = { keys: [], sleeps: 0 };
  await expect(
    tmuxInternals.unblockClaudePane(
      "%2",
      {
        capturePane: () => frame(pane.keys),
        capturePaneSnapshot: () => ({
          activeClients: 0,
          cursor: { x: -1, y: -1 },
          pipeOpen: false,
          text: frame(pane.keys),
          windowActivity: 100 + pane.keys.length,
        }),
        nowMs: () => 0,
        sendKeys: (_pane, keys) => {
          pane.keys.push(keys);
        },
        sleep: () => {
          pane.sleeps += 1;
          return Promise.resolve();
        },
      },
      context
    )
  ).rejects.toThrow(message);
  return pane;
};

const TRUST_REFUSAL = `Claude Code has not trusted ${WORKSPACE} yet: run \`claude\` once in this folder and accept, or relaunch with --trust-workspace`;

// --- Folder trust: refused by default ---------------------------------------

test("the folder trust prompt fails fast with an actionable message and no key", async () => {
  const pane = await driveRejected(
    () => trustDialog("exit"),
    startup(),
    TRUST_REFUSAL
  );
  expect(pane.keys).toEqual([]);
  // Fails on the first capture, not after the 20 s readiness window.
  expect(pane.sleeps).toBe(0);
});

test("the older trust heading is refused by default too, even with trust selected", async () => {
  const legacy = [
    " Accessing workspace:",
    "",
    ` ${WORKSPACE}`,
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
  ].join("\n");
  const pane = await driveRejected(() => legacy, startup(), TRUST_REFUSAL);
  expect(pane.keys).toEqual([]);
});

// --- Folder trust: --trust-workspace ------------------------------------------

test("--trust-workspace moves off the exit row and confirms trust for this workspace", async () => {
  const pane = await drive(
    (keys) => {
      if (keys.length === 0) {
        return trustDialog("exit");
      }
      return keys.length === 1 ? trustDialog("trust") : "❯ ";
    },
    startup({ trustWorkspace: true })
  );
  expect(pane.keys).toEqual([["Down"], ["Enter"]]);
});

test("--trust-workspace navigates up when the trust row is above the exit row", async () => {
  const dialog = (selected: "exit" | "trust") =>
    [
      " Do you trust the files in this folder?",
      "",
      ` ${WORKSPACE}`,
      "",
      selected === "trust" ? " ❯ 1. Yes, proceed" : "   1. Yes, proceed",
      selected === "exit" ? " ❯ 2. No, exit" : "   2. No, exit",
    ].join("\n");
  const pane = await drive(
    (keys) => {
      if (keys.length === 0) {
        return dialog("exit");
      }
      return keys.length === 1 ? dialog("trust") : "❯ ";
    },
    startup({ trustWorkspace: true })
  );
  expect(pane.keys).toEqual([["Up"], ["Enter"]]);
});

test("--trust-workspace accepts the workspace under any of its recorded spellings", async () => {
  const pane = await drive(
    (keys) =>
      keys.length === 0 ? trustDialog("trust", "~/dummy-project") : "❯ ",
    startup({
      trustWorkspace: true,
      workspacePaths: [WORKSPACE, "~/dummy-project"],
    })
  );
  expect(pane.keys).toEqual([["Enter"]]);
});

test("--trust-workspace never answers a trust prompt that names another folder", async () => {
  const pane = await driveRejected(
    () => trustDialog("trust", "/Users/dev/somewhere-else"),
    startup({ trustWorkspace: true }),
    "names /Users/dev/somewhere-else, not this workspace"
  );
  expect(pane.keys).toEqual([]);
});

test("--trust-workspace sends no second key when trust never takes", async () => {
  const pane = await driveRejected(
    (keys) => trustDialog(keys.length === 0 ? "exit" : "exit"),
    startup({ trustWorkspace: true }),
    "folder trust confirmation did not reach a verified next state"
  );
  expect(pane.keys).toEqual([["Down"]]);
});

// --- Development channels: only this run's loop bridge ------------------------

test("the development-channels prompt is answered for exactly this run's loop bridge", async () => {
  const pane = await drive(
    (keys) =>
      keys.length === 0 ? devChannelPrompt(`server:${CHANNEL}`) : "❯ ",
    startup()
  );
  expect(pane.keys).toEqual([["Enter"]]);
});

test("a development-channels line hard-wrapped by a narrow pane still matches", async () => {
  const pane = await drive(
    (keys) =>
      keys.length === 0 ? devChannelPrompt(`server:${CHANNEL}`, 24) : "❯ ",
    startup()
  );
  expect(pane.keys).toEqual([["Enter"]]);
});

for (const [name, channels] of [
  ["another server", "server:loop-bridge-other-repo-1"],
  ["a longer run id with this run's prefix", `server:${CHANNEL}0`],
  ["this run's bridge plus another channel", `server:${CHANNEL}, server:evil`],
  ["a plugin channel", `plugin:${CHANNEL}`],
] as const) {
  test(`the development-channels prompt is refused for ${name}`, async () => {
    const pane = await driveRejected(
      () => devChannelPrompt(channels),
      startup(),
      "not this run's loop bridge"
    );
    expect(pane.keys).toEqual([]);
  });
}

test("the development-channels prompt is refused when it lists no readable channel", async () => {
  const pane = await driveRejected(
    () =>
      devChannelPrompt(`server:${CHANNEL}`).replace(
        `  Channels: server:${CHANNEL}`,
        ""
      ),
    startup(),
    "lists no readable channel"
  );
  expect(pane.keys).toEqual([]);
});

test("the development-channels prompt is refused when the launch names no bridge", async () => {
  const pane = await driveRejected(
    () => devChannelPrompt(`server:${CHANNEL}`),
    startup({ channelServer: undefined }),
    "not this run's loop bridge"
  );
  expect(pane.keys).toEqual([]);
});

// --- The live sequence --------------------------------------------------------

test("the live fresh-repo sequence: trust, then this run's channel, then ready", async () => {
  const pane = await drive(
    (keys) => {
      if (keys.length === 0) {
        return trustDialog("exit");
      }
      if (keys.length === 1) {
        return trustDialog("trust");
      }
      return keys.length === 2 ? devChannelPrompt(`server:${CHANNEL}`) : "❯ ";
    },
    startup({ trustWorkspace: true })
  );
  expect(pane.keys).toEqual([["Down"], ["Enter"], ["Enter"]]);
});
