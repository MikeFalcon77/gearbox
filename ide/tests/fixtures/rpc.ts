// Hold one answer, and let everything else past.
//
// **Two rounds of manual checking ended in "not confirmed" because the states
// were waited for.** A resolve in flight, a failed engine, a dialog dismissed
// while a call is outstanding — each lasts milliseconds in a healthy run, so a
// person watching for one is relying on luck. They can be *caused*.
//
// **What this is, and what it is not.** This intercepts the websocket between
// the browser and the Theia backend, so it drives what the *frontend* does while
// an answer is outstanding. It says nothing about the engine: by the time a
// frame is held here the backend may already have been answered by a perfectly
// healthy `gearbox rpc`. The real timeout, the handle that disposes itself and
// what recovery re-establishes are a different seam, with a real engine that
// hangs.
//
// **Parsed with Theia's own codec rather than by looking for the method name in
// the bytes.** The frames are a channel-multiplexer envelope wrapping a msgpack
// RPC message; a substring scan would find the method and could not find the
// *id*, and without the id there is no way to hold one answer rather than all
// traffic. `MsgPackMessageDecoder` is the encoder's counterpart, from the same
// package the application runs — reading its own protocol rather than guessing
// at it.

import type { BrowserContext } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  MsgPackMessageDecoder,
} = require("@theia/core/lib/common/message-rpc/rpc-message-encoder");
const {
  Uint8ArrayReadBuffer,
} = require("@theia/core/lib/common/message-rpc/uint8-array-message-buffer");
/* eslint-enable @typescript-eslint/no-var-requires */

/** Theia's `MessageTypes`: 1 is a request, 3 the reply to one. */
const REQUEST = 1;
const REPLY = 3;

/** One answer being withheld. */
export interface Stall {
  /** Settles when the request has been seen and its answer is being held. */
  readonly held: Promise<void>;
  /** Let the answer through, and stop intercepting for this method. */
  release: () => void;
}

interface Parsed {
  readonly channel: string;
  readonly type: number;
  readonly id?: number;
  readonly method?: string;
}

/**
 * Read one frame, or `undefined` when it is not one of ours.
 *
 * Binary only: socket.io's own text frames carry no RPC message, and a decode
 * that threw on them would be noise rather than information.
 */
function parse(frame: string | Buffer): Parsed | undefined {
  if (typeof frame === "string") return undefined;
  try {
    const read = new Uint8ArrayReadBuffer(new Uint8Array(frame));
    read.readUint8();
    const channel: string = read.readString();
    if (!channel.includes("gearbox")) return undefined;
    const message = new MsgPackMessageDecoder().parse(read) as {
      type: number;
      id?: number;
      method?: string;
    };
    return { channel, type: message.type, id: message.id, method: message.method };
  } catch {
    // A frame this codec cannot read is a frame for somebody else. Forwarded
    // untouched, which is the default for everything here.
    return undefined;
  }
}

export class RpcControl {
  /** Method name -> the stall waiting for its request to go out. */
  private readonly wanted = new Map<string, { id?: number; announce: () => void }>();
  /** Request id -> the frames of its answer, while they are being withheld. */
  private readonly holding = new Map<number, (string | Buffer)[]>();
  /** Request id -> how to let its answer out. */
  private readonly forward = new Map<number, (frame: string | Buffer) => void>();

  /**
   * Intercept this context's websockets.
   *
   * **On the context, before a page navigates.** A route installed after the
   * socket is open sees nothing: the connection this suite cares about is made
   * during the first load.
   */
  async install(context: BrowserContext): Promise<void> {
    await context.routeWebSocket("**/*", (ws) => {
      const server = ws.connectToServer();

      ws.onMessage((frame) => {
        const message = parse(frame);
        if (message?.type === REQUEST && message.method !== undefined) {
          const stall = this.wanted.get(message.method);
          if (stall !== undefined && stall.id === undefined && message.id !== undefined) {
            stall.id = message.id;
          }
        }
        server.send(frame);
      });

      // **A message is a group of frames, and a group is what gets held.**
      // socket.io announces a binary event in a text frame — `45<n>-<ns>,[…]`,
      // with `n` placeholders — and sends the attachments after it. Holding the
      // attachment alone leaves the client's parser waiting for a payload that
      // never arrives, and every later message reassembles against the wrong
      // announcement. So frames are gathered into groups and a group travels or
      // waits as a unit; the ones that are not held keep their order.
      let group: (string | Buffer)[] = [];
      let expecting = 0;
      const deliver = (frames: (string | Buffer)[]): void => {
        const attachment = frames.find((f) => typeof f !== "string");
        const message = attachment === undefined ? undefined : parse(attachment);
        const id = message?.type === REPLY ? message.id : undefined;
        if (id !== undefined && [...this.wanted.values()].some((s) => s.id === id)) {
          this.holding.set(id, frames);
          this.forward.set(id, (held) => ws.send(held));
          for (const stall of this.wanted.values()) if (stall.id === id) stall.announce();
          return;
        }
        for (const held of frames) ws.send(held);
      };

      server.onMessage((frame) => {
        if (typeof frame === "string") {
          const attachments = /^4[56](\d+)-/.exec(frame);
          if (attachments !== null) {
            group = [frame];
            expecting = Number(attachments[1]);
            return;
          }
          // A text frame of its own: nothing to gather, nothing to hold.
          ws.send(frame);
          return;
        }
        if (expecting > 0) {
          group.push(frame);
          expecting -= 1;
          if (expecting === 0) {
            deliver(group);
            group = [];
          }
          return;
        }
        ws.send(frame);
      });
    });
  }

  /**
   * Withhold the answer to the next call of `method`.
   *
   * The request itself reaches the backend: the point is a frontend waiting on
   * an answer, not a backend that never heard the question.
   */
  stallNext(method: string): Stall {
    let announce = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const entry = { id: undefined as number | undefined, announce };
    this.wanted.set(method, entry);
    return {
      held,
      release: () => {
        this.wanted.delete(method);
        const id = entry.id;
        if (id === undefined) return;
        const send = this.forward.get(id);
        for (const frame of this.holding.get(id) ?? []) send?.(frame);
        this.holding.delete(id);
        this.forward.delete(id);
      },
    };
  }
}
