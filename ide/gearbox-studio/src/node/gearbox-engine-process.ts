// Supervises one engine process per workspace root.
//
// The engine speaks JSON-RPC over its stdio with LSP framing, so the same
// `vscode-jsonrpc` reader/writer Theia uses elsewhere works with no adapter.
// `child.stderr` is piped to the backend log: the engine puts everything that is
// not JSON-RPC there, by design, and dropping it would turn a crash into a hang.

import { ILogger } from "@theia/core/lib/common/logger";
import { spawn, ChildProcess } from "child_process";
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

export interface EngineHandle {
  readonly connection: MessageConnection;
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
  child.on("exit", (code, signal) => {
    void logger.warn(`[gearbox engine] exited code=${code} signal=${signal}`);
  });

  if (!child.stdout || !child.stdin) {
    throw new Error("engine process has no stdio");
  }

  // `@types/node`'s `Readable` and vscode-jsonrpc's `ReadableStream` disagree on
  // the async-iterator signature only; the runtime shapes match, which the smoke
  // test exercises against the same reader.
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout as unknown as NodeJS.ReadableStream),
    new StreamMessageWriter(child.stdin as unknown as NodeJS.WritableStream),
  );
  connection.listen();

  return {
    connection,
    dispose(): void {
      try {
        connection.dispose();
      } finally {
        child.kill();
      }
    },
  };
}
