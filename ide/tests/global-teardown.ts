// The last word on whether the run left the descriptions alone.
//
// `global-setup` refuses to *start* against a modified description, and a hook in
// the fixture fails whichever test dirties one. Both were in place and a stray
// `use_gear("types-registry", ...)` still reached `products/payments-demo/product.gdl`
// -- and the run before it reported no failures.
//
// That is the evidence for where the gap is: a per-test hook checks after a test
// **ends**, so a write that lands during teardown, or after the last test's hook
// has run, is invisible to it and turns up as a refusal at the start of the *next*
// run. Which is a day later and in a different file.
//
// So this checks once more when everything is over. It cannot say which test did
// it -- that is what the per-test hook is for -- but it says the run did it, in the
// run that did it, and it leaves the tree as it found it.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default function globalTeardown(): void {
  const repo = join(__dirname, "../..");
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "products"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  if (dirty === "") return;

  const diff = execFileSync("git", ["diff", "--", "products"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["checkout", "--", "products"], { cwd: repo });
  throw new Error(
    `The run left a product description changed after the last test finished:\n${dirty}\n\n` +
      `${diff}\n` +
      `The tree has been restored. No test was blamed because none was still running: ` +
      `the write landed in teardown or after the final hook, which is why the per-test ` +
      `guard did not see it. Two claims edit a description on purpose and put it back; ` +
      `anything else writing there is a defect.`,
  );
}
