// Supervises one engine process per workspace root.
//
// The engine speaks JSON-RPC over its stdio with LSP framing, so the same
// `vscode-jsonrpc` reader/writer Theia uses elsewhere works with no adapter.
// `child.stderr` is piped to the backend log: the engine puts everything that is
// not JSON-RPC there, by design, and dropping it would turn a crash into a hang.
//
// Supervision is the substance of this file. `vscode-jsonrpc` rejects in-flight
// requests when the *connection* is disposed, not when the stream closes, so a
// child that dies after `listen()` leaves every pending `sendRequest` hanging
// forever. And `spawn` reports ENOENT by emitting `'error'`, which with no
// listener is an uncaught exception that takes the whole Theia backend down.
// Both are handled here rather than at each call site.

import { ILogger } from "@theia/core/lib/common/logger";
import { spawn, ChildProcess } from "child_process";
import { PassThrough } from "stream";
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

/** How long a killed engine gets to exit before SIGKILL. */
const SIGTERM_GRACE_MS = 2_000;

export interface EngineHandle {
  readonly connection: MessageConnection;
  /** Resolves with why the engine died; never rejects. */
  readonly exited: Promise<string>;
  /** Whether the child is gone or the connection has been disposed. */
  readonly dead: boolean;
  /**
   * Send a request that always settles.
   *
   * The reason this is not `connection.sendRequest` at the call site:
   * `vscode-jsonrpc` registers a request in its pending map only *after* the
   * write resolves, and `dispose()` rejects what is in that map. An engine that
   * dies in the window between the two -- which is every engine that fails to
   * start, because the spawn error is a `nextTick` and the write completes on a
   * microtask after it -- leaves a request nobody will ever settle. Racing the
   * answer against the child's death closes that window; the timeout closes the
   * one where the child is alive and simply never answers.
   *
   * @throws when the engine dies first, or does not answer within `timeoutMs`.
   */
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T>;
  dispose(): void;
}

/** Spawn `gearbox rpc --stdio --root <root>` and wrap its stdio. */
export function spawnEngine(
  enginePath: string,
  roots: readonly string[],
  logger: ILogger,
): EngineHandle {
  const args = ["rpc", "--stdio", ...roots.flatMap((r) => ["--root", r])];
  const child: ChildProcess = spawn(enginePath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n").filter((l) => l.trim())) {
      void logger.info(`[gearbox engine] ${line}`);
    }
  });

  let settle: (reason: string) => void = () => undefined;
  const exited = new Promise<string>((resolve) => {
    settle = resolve;
  });

  let dead = false;
  let connection: MessageConnection | undefined;
  const die = (reason: string): void => {
    if (dead) {
      return;
    }
    dead = true;
    void logger.warn(`[gearbox engine] ${reason}`);
    // Disposing is what rejects the in-flight requests. Without it the client
    // waits on a process that no longer exists.
    connection?.dispose();
    settle(reason);
  };

  // ENOENT, EACCES, and every other spawn failure arrive here. With no listener
  // Node re-throws them on the event loop, which is an IDE-wide crash for a
  // missing `target/debug/gearbox`.
  child.on("error", (error: Error) => {
    die(`could not be started (${enginePath}): ${error.message}`);
  });
  // Same rule one level down: an unlistened `'error'` on a stream is also an
  // uncaught exception.
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on("error", (error: Error) => {
      die(`stdio failed: ${error.message}`);
    });
  }
  child.on("exit", (code, signal) => {
    die(`exited code=${code} signal=${signal}`);
  });

  if (!child.stdout || !child.stdin) {
    child.kill();
    throw new Error("engine process has no stdio");
  }

  // The writer writes into a buffer of ours, which is piped to the child --
  // rather than into the child's stdin directly.
  //
  // Not indirection for its own sake. A write into the stdin of a child that
  // has already died rejects inside `vscode-jsonrpc`'s writer, and that
  // rejection is not one anybody awaits: under Node's default
  // `--unhandled-rejections=throw` it surfaces as an uncaught exception and
  // takes the Theia backend with it. That is exactly the case that matters
  // most -- a missing `target/debug/gearbox`, where `initialize` writes
  // microseconds after the spawn fails. A write into a `PassThrough` cannot
  // fail; the pipe to the dead child reports the failure as an `'error'` event,
  // which is handled, and the waiting request is rejected by `die()` disposing
  // the connection.
  const outbound = new PassThrough();
  outbound.on("error", (error: Error) => die(`stdin failed: ${error.message}`));

  // `@types/node`'s `Readable` and vscode-jsonrpc's `ReadableStream` disagree on
  // the async-iterator signature only; the runtime shapes match, which the smoke
  // test exercises against the same reader.
  connection = createMessageConnection(
    new StreamMessageReader(child.stdout as unknown as NodeJS.ReadableStream),
    new StreamMessageWriter(outbound as unknown as NodeJS.WritableStream),
  );
  connection.onClose(() => {
    die("connection closed");
  });
  // Without this an error on the reader (a truncated frame, a closed pipe mid
  // message) is silent, and the symptom is again a request that never settles.
  connection.onError(([error]) => {
    die(`transport error: ${error.message}`);
  });
  connection.listen();

  // Piped only now. Attaching to an already-destroyed stdin -- the missing
  // binary again -- emits `'error'` synchronously, and `die()` running before
  // `connection` exists would dispose nothing, leaving the first request
  // pending on a connection nobody will ever close.
  outbound.pipe(child.stdin);

  const live = connection;
  const handle: EngineHandle = {
    connection,
    exited,
    get dead(): boolean {
      return dead;
    },
    async request<T>(requestMethod: string, params: unknown, timeoutMs: number): Promise<T> {
      if (dead) {
        throw new Error(`the engine is not running (${await exited})`);
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the engine did not answer \`${requestMethod}\` in ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      const died = exited.then((reason): never => {
        throw new Error(`the engine ${reason} while answering \`${requestMethod}\``);
      });
      try {
        return await Promise.race([
          live.sendRequest<T>(requestMethod, params),
          died,
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    dispose(): void {
      try {
        die("disposed");
      } finally {
        child.kill("SIGTERM");
        // A wedged engine -- an infinite walk, a hung NFS read -- ignores
        // SIGTERM. Leaving it running holds the source root open and the file
        // handles with it.
        const timer = setTimeout(() => child.kill("SIGKILL"), SIGTERM_GRACE_MS);
        timer.unref?.();
        child.once("exit", () => clearTimeout(timer));
      }
    },
  };
  return handle;
}
