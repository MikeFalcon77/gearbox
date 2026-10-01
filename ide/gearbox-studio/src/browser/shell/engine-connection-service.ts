// Whether the Gearbox engine is usable right now.
//
// Theia can be online while the engine process is dead, and the engine can be
// mid-initialize while the catalogue still looks empty. Commands that need the
// engine (New Product, Resolve, Generate) must read this rather than hoping a
// toast appears after the click.

import { Emitter, Event } from "@theia/core/lib/common/event";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class EngineConnectionService {
  protected readonly onDidChangeEmitter = new Emitter<boolean>();
  readonly onDidChange: Event<boolean> = this.onDidChangeEmitter.event;

  protected connected = false;
  /** Last reason the engine was marked down, for the banner. */
  protected reason = "the engine is not connected";

  get isConnected(): boolean {
    return this.connected;
  }

  get disconnectReason(): string {
    return this.reason;
  }

  markConnected(): void {
    if (this.connected) return;
    this.connected = true;
    this.reason = "";
    this.onDidChangeEmitter.fire(true);
  }

  markDisconnected(why: string): void {
    const changed = this.connected || this.reason !== why;
    this.connected = false;
    this.reason = why;
    if (changed) {
      this.onDidChangeEmitter.fire(false);
    }
  }
}
