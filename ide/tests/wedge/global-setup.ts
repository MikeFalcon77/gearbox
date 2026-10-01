// The suite's own setup, plus a seam with nothing held.
//
// The conformance setup is reused whole rather than reimplemented: the engine
// binary, the frontend bundle and the state of `products/` are facts about this
// checkout, and a second server does not make them different facts. What is
// added is the two files this seam owns -- so a run that died holding an answer
// cannot make the next run's *first* resolve the withheld one.

import conformanceSetup from "../global-setup";
import { resetSeam } from "./seam";

export default function wedgeSetup(): void {
  conformanceSetup();
  resetSeam();
}
