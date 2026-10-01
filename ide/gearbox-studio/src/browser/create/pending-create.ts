import { injectable } from "@theia/core/shared/inversify";

import type { CreateProductState } from "./create-product-widget";

/** One-shot wizard state from Start screen Clone before the command runs. */
@injectable()
export class PendingCreate {
  state: CreateProductState | undefined;
}
