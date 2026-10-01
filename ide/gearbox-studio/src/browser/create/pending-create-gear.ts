// Carry New Gear wizard state across the command boundary — same pattern as
// product create (Start / Product widget → SessionCommands → CreateGearView).

import { injectable } from "@theia/core/shared/inversify";

import type { CreateGearState } from "./create-gear-widget";

@injectable()
export class PendingCreateGear {
  state: CreateGearState | undefined;
}
