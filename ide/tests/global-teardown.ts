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

import { join } from "node:path";

import { productsDiff, productsStatus, restoreProducts } from "./fixtures/products-tree";
import { corpusDiff, corpusStatus, restoreCorpus } from "./fixtures/corpus-files";
import {
  flushWriteTraces,
  formatWriteTraces,
  readWriteTraces,
  resetWriteTraces,
} from "./fixtures/write-traces";

export default async function globalTeardown(): Promise<void> {
  const repo = join(__dirname, "../..");
  await flushWriteTraces();
  // The corpus first, because its remedy is narrower and its message is
  // unambiguous: nothing in a normal run should have touched it after the last
  // test's own `finally`.
  const dirtyCorpus = corpusStatus(repo);
  if (dirtyCorpus !== "") {
    const corpusChanges = corpusDiff(repo);
    restoreCorpus(repo);
    throw new Error(
      `The run left a gear description changed after the last test finished:\n` +
        `${dirtyCorpus}\n\n${corpusChanges}\n\n` +
        `The named files have been restored. Two claims rewrite a \`gear.gdl\` on purpose ` +
        `and put it back; a write that lands after the final hook is a defect.`,
    );
  }

  const dirty = productsStatus(repo);
  const traces = readWriteTraces();
  const traceBlock = formatWriteTraces(traces);
  resetWriteTraces();

  if (dirty === "" && traces.length === 0) return;

  if (dirty === "") {
    // Tree is clean: leftover traces are a race or an intentional write that
    // restored the file — not a changed description.
    throw new Error(
      `The run left Gearbox write traces with a clean products/ tree:\n\n` +
        traceBlock +
        `products/ was not modified. A late append after a clean reset used to ` +
        `look like a dirty tree; if this still fires after flushWriteTraces, the ` +
        `trace file outlived the run without a matching description change.`,
    );
  }

  const diff = productsDiff(repo, dirty);
  restoreProducts(repo);
  throw new Error(
    `The run left the product descriptions changed after the last test finished:\n` +
      `${dirty}\n\n${diff}\n\n` +
      traceBlock +
      `The tree has been restored. No test was blamed because none was still running: ` +
      `the write landed in teardown or after the final hook, which is why the per-test ` +
      `guard did not see it. Two claims edit a description on purpose and put it back; ` +
      `anything else writing there is a defect.`,
  );
}
