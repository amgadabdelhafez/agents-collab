import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { connectWs } from "../../src/loop/ws-client";

const OPEN_SERVERS = new Set<Server>();
const OPEN_SOCKETS = new Set<Socket>();

afterEach(async () => {
  for (const socket of OPEN_SOCKETS) {
    socket.destroy();
  }
  OPEN_SOCKETS.clear();
  await Promise.all(
    [...OPEN_SERVERS].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        })
    )
  );
  OPEN_SERVERS.clear();
});

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs = 2000
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("test timed out")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const frame = (opcode: number, payloadText: string, fin = true): Uint8Array => {
  const payload = new TextEncoder().encode(payloadText);
  const first = (fin ? 0x80 : 0) + opcode;
  if (payload.length < 126) {
    return Uint8Array.from([first, payload.length, ...payload]);
  }
  if (payload.length < 65_536) {
    return Uint8Array.from([
      first,
      126,
      Math.floor(payload.length / 256),
      payload.length % 256,
      ...payload,
    ]);
  }
  throw new Error("test frame is too large");
};

const handshake =
  "HTTP/1.1 101 Switching Protocols\r\n" +
  "Upgrade: websocket\r\n" +
  "Connection: Upgrade\r\n" +
  "\r\n";

const startRawServer = async (
  onHandshake: (socket: Socket) => void,
  onConnection: (socket: Socket) => void = () => undefined,
  allowHalfOpen = false
): Promise<{ port: number; server: Server }> => {
  const server = createServer({ allowHalfOpen }, (socket) => {
    OPEN_SOCKETS.add(socket);
    socket.once("close", () => OPEN_SOCKETS.delete(socket));
    onConnection(socket);
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8");
      if (!request.includes("\r\n\r\n")) {
        return;
      }
      socket.removeAllListeners("data");
      onHandshake(socket);
    });
  });
  OPEN_SERVERS.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!(address && typeof address === "object")) {
    throw new Error("raw WebSocket test server has no address");
  }
  return { port: address.port, server };
};

test("ws client reassembles fragmented text with an interleaved ping", async () => {
  const { port } = await startRawServer((socket) => {
    socket.write(handshake);
    socket.write(frame(0x01, "hello ", false));
    socket.write(frame(0x09, "probe"));
    socket.write(frame(0x00, "from ", false));
    socket.write(frame(0x00, "fragments"));
  });
  const client = await connectWs(`ws://127.0.0.1:${port}/`);
  expect(client.nativeSocketFd).toBeGreaterThanOrEqual(0);
  expect(client.acceptedByPid(process.pid)).toBe(true);
  expect(client.acceptedByPid(99_999)).toBe(false);
  const message = await withTimeout(
    new Promise<string>((resolve) => {
      client.onmessage = resolve;
    })
  );
  expect(message).toBe("hello from fragments");
  client.close();
});

test("ws client preserves a first frame coalesced with the HTTP upgrade", async () => {
  const payload = JSON.stringify({ detail: "x".repeat(150), type: "first" });
  const { port } = await startRawServer((socket) => {
    socket.write(
      Buffer.concat([
        Buffer.from(handshake, "ascii"),
        Buffer.from(frame(1, payload)),
      ])
    );
  });
  const client = await connectWs(`ws://127.0.0.1:${port}/`);
  const message = await withTimeout(
    new Promise<string>((resolve) => {
      client.onmessage = resolve;
    })
  );
  expect(message).toBe(payload);
  client.close();
});

test("ws client terminates the exact socket after a rejected upgrade", async () => {
  let acceptedSocket: Socket | undefined;
  let markClosed = () => undefined;
  const socketClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const { port } = await startRawServer((socket) => {
    acceptedSocket = socket;
    socket.once("close", markClosed);
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n"
    );
  });

  await expect(connectWs(`ws://127.0.0.1:${port}/`)).rejects.toThrow(
    "WebSocket upgrade failed"
  );
  await withTimeout(socketClosed);
  expect(acceptedSocket?.destroyed).toBe(true);
});

test("ws client bounds a silent upgrade and terminates its exact socket", async () => {
  let acceptedSocket: Socket | undefined;
  let markClosed = () => undefined;
  const socketClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const { port } = await startRawServer((socket) => {
    acceptedSocket = socket;
    socket.once("close", markClosed);
  });

  await expect(
    connectWs(`ws://127.0.0.1:${port}/`, { handshakeTimeoutMs: 20 })
  ).rejects.toThrow("WebSocket upgrade timed out");
  await withTimeout(socketClosed);
  expect(acceptedSocket?.destroyed).toBe(true);
});

test("ws client rejects a close before the upgrade completes", async () => {
  const { port } = await startRawServer((socket) => {
    socket.destroy();
  });

  await expect(connectWs(`ws://127.0.0.1:${port}/`)).rejects.toThrow(
    "closed before handshake"
  );
});

test("ws client cancellation terminates a silent pending upgrade", async () => {
  const controller = new AbortController();
  let acceptedSocket: Socket | undefined;
  let markUpgradeRequested = () => undefined;
  let markClosed = () => undefined;
  const upgradeRequested = new Promise<void>((resolve) => {
    markUpgradeRequested = resolve;
  });
  const socketClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const { port } = await startRawServer((socket) => {
    acceptedSocket = socket;
    socket.once("close", markClosed);
    markUpgradeRequested();
  });
  const connecting = connectWs(`ws://127.0.0.1:${port}/`, {
    signal: controller.signal,
  });
  await upgradeRequested;

  controller.abort();

  await expect(connecting).rejects.toThrow("WebSocket upgrade cancelled");
  await withTimeout(socketClosed);
  expect(acceptedSocket?.destroyed).toBe(true);
});

test("ws client terminates a raw socket acquired after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let acceptedSocket: Socket | undefined;
  let markAccepted = () => undefined;
  let markClosed = () => undefined;
  const socketAccepted = new Promise<void>((resolve) => {
    markAccepted = resolve;
  });
  const socketClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const { port } = await startRawServer(
    () => undefined,
    (socket) => {
      acceptedSocket = socket;
      socket.once("close", markClosed);
      markAccepted();
    }
  );

  await expect(
    connectWs(`ws://127.0.0.1:${port}/`, { signal: controller.signal })
  ).rejects.toThrow("WebSocket upgrade cancelled");
  await withTimeout(socketAccepted);
  await withTimeout(socketClosed);
  expect(acceptedSocket?.destroyed).toBe(true);
});

test("ws client forcibly disposes an upgraded socket after graceful close", async () => {
  let acceptedSocket: Socket | undefined;
  let markEnded = () => undefined;
  const socketEnded = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  const { port } = await startRawServer(
    (socket) => {
      acceptedSocket = socket;
      socket.once("end", markEnded);
      socket.write(handshake);
    },
    () => undefined,
    true
  );
  const client = await connectWs(`ws://127.0.0.1:${port}/`);

  client.close();

  await withTimeout(socketEnded);
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(acceptedSocket?.readableEnded).toBe(true);
  expect(client.acceptedByPid(process.pid)).toBe(false);
});

test("ws client exposes exact forced disposal for an upgraded socket", async () => {
  let acceptedSocket: Socket | undefined;
  let markEnded = () => undefined;
  const socketEnded = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  const { port } = await startRawServer(
    (socket) => {
      acceptedSocket = socket;
      socket.once("end", markEnded);
      socket.write(handshake);
    },
    () => undefined,
    true
  );
  const client = await connectWs(`ws://127.0.0.1:${port}/`);

  client.terminate();

  await withTimeout(socketEnded);
  expect(acceptedSocket?.readableEnded).toBe(true);
  expect(client.acceptedByPid(process.pid)).toBe(false);
});
