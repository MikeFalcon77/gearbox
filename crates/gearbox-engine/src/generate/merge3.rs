//! A line-wise three-way merge.
//!
//! **The plan says "3-way merge ... using `similar`", and `similar` has no
//! three-way merge.** It is a diffing library: `TextDiff`, `DiffOp`, unified
//! diff rendering, and nothing that reconciles two descendants of one ancestor.
//! (`diffy` does have one.) So `similar` supplies the two line diffs and the
//! reconciliation is here -- which is the smaller half of the work, and the
//! half whose policy has to be ours anyway.
//!
//! The policy is *conservative in one direction only*. Where the two sides
//! cannot be reconciled the answer is [`Merge::Conflict`], the caller reports
//! `GBX0701` and leaves the operator's file exactly as it was. That is required
//! by `cpt-gearbox-fr-preserve-operator-values`, and it is also why this file
//! never emits conflict markers: a `values.yaml` with `<<<<<<<` in it is a file
//! `helm` can no longer parse, so a merge that "succeeded" by writing markers
//! would have destroyed the artefact it was protecting.
//!
//! Two consequences of choosing safety over cleverness, both deliberate:
//!
//! - Changes on the two sides that merely *touch* -- one ends on the line the
//!   other begins -- are treated as one region. Adjacent edits therefore
//!   conflict where a smarter merge might interleave them. Over-reporting a
//!   conflict costs a manual reconciliation; under-reporting one costs the
//!   operator's edit.
//! - Comparison is by whole lines. A generator and an operator editing
//!   different words of one line conflict.

use std::ops::Range;

use similar::{DiffOp, TextDiff};

/// What reconciling three versions produced.
#[derive(Debug, PartialEq, Eq)]
pub enum Merge {
    /// A single text both sides' changes are present in.
    Merged(String),
    /// The two sides changed the same region differently.
    Conflict,
}

/// Reconcile `ours` and `theirs`, which are both descendants of `base`.
///
/// "Ours" is the operator's file on disk and "theirs" is the freshly generated
/// proposal. The names are the version-control convention rather than a claim
/// about who is right: the merge is symmetric, and only the conflict message
/// the caller writes is not.
pub fn merge(base: &str, ours: &str, theirs: &str) -> Merge {
    if ours == theirs {
        return Merge::Merged(ours.to_owned());
    }
    if base == ours {
        return Merge::Merged(theirs.to_owned());
    }
    if base == theirs {
        return Merge::Merged(ours.to_owned());
    }

    let base_lines = lines(base);
    let our_lines = lines(ours);
    let their_lines = lines(theirs);

    let our_diff = TextDiff::from_slices(&base_lines, &our_lines);
    let their_diff = TextDiff::from_slices(&base_lines, &their_lines);
    let our_ops = our_diff.ops().to_vec();
    let their_ops = their_diff.ops().to_vec();

    let mut regions = changed_regions(&our_ops);
    regions.extend(changed_regions(&their_ops));
    regions.sort_by_key(|r| (r.start, r.end));
    let regions = coalesce(regions);

    let mut out: Vec<&str> = Vec::new();
    let mut cursor = 0usize;
    for region in regions {
        // The untouched run before this region is identical in all three, so it
        // can be taken from the base.
        out.extend_from_slice(&base_lines[cursor..region.start]);

        let ours_slice = project(&our_ops, &our_lines, &region);
        let theirs_slice = project(&their_ops, &their_lines, &region);
        let base_slice = &base_lines[region.clone()];

        if ours_slice == theirs_slice || theirs_slice == base_slice {
            out.extend_from_slice(&ours_slice);
        } else if ours_slice == base_slice {
            out.extend_from_slice(&theirs_slice);
        } else {
            return Merge::Conflict;
        }
        cursor = region.end;
    }
    out.extend_from_slice(&base_lines[cursor..]);

    Merge::Merged(out.concat())
}

/// Split into lines, keeping the terminators.
///
/// Keeping them is what makes `concat()` reproduce the input exactly, including
/// whether the file ended with a newline -- a difference that is invisible in a
/// diff view and very visible to `git diff --exit-code`.
fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// The base-line ranges one side changed.
fn changed_regions(ops: &[DiffOp]) -> Vec<Range<usize>> {
    ops.iter()
        .filter(|op| !matches!(op, DiffOp::Equal { .. }))
        .map(|op| {
            let (start, end) = (op.old_range().start, op.old_range().end);
            start..end
        })
        .collect()
}

/// Merge overlapping or touching ranges.
///
/// Touching counts: a change ending at base line 7 and another beginning at 7
/// are adjacent, and reconciling them independently would let one side's
/// insertion land inside the other side's replacement.
fn coalesce(sorted: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    for range in sorted {
        match out.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => out.push(range),
        }
    }
    out
}

/// The lines one side has where the base has `region`.
fn project<'a>(ops: &[DiffOp], side: &[&'a str], region: &Range<usize>) -> Vec<&'a str> {
    let start = side_index(ops, region.start, Bound::Start);
    let end = side_index(ops, region.end, Bound::End);
    if start > end || end > side.len() {
        // Cannot happen for a monotone alignment, but returning the whole side
        // would be a silent wrong answer, and panicking is not this crate's
        // habit. An empty projection compares unequal to the other two sides
        // and so degrades into a reported conflict.
        return Vec::new();
    }
    side[start..end].to_vec()
}

/// Which end of a region a base index is.
///
/// The distinction exists for one case, and it is the case that matters most:
/// a pure insertion has an *empty* base range, so its base position is
/// simultaneously the end of what precedes it and the start of what follows.
/// An insertion sitting at a region's boundary therefore has to be counted as
/// inside the region when the boundary is its end and outside when it is its
/// start -- otherwise appended lines fall through the gap between two regions
/// and are silently dropped.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Bound {
    Start,
    End,
}

/// Where base line `index` lands on one side.
fn side_index(ops: &[DiffOp], index: usize, bound: Bound) -> usize {
    let mut last_end = 0;
    for op in ops {
        let old = op.old_range();
        let new = op.new_range();

        if old.start == old.end {
            // A pure insertion, anchored between two base lines.
            if old.start == index {
                if bound == Bound::End {
                    last_end = new.end;
                    continue;
                }
                return new.start;
            }
            if old.start > index {
                return last_end;
            }
            last_end = new.end;
            continue;
        }

        if index < old.start {
            return last_end;
        }
        if index < old.end {
            return match (op, bound) {
                (DiffOp::Equal { .. }, _) => new.start + (index - old.start),
                (_, Bound::Start) => new.start,
                (_, Bound::End) => new.end,
            };
        }
        last_end = new.end;
    }
    last_end
}

#[cfg(test)]
mod tests {
    use super::*;

    // Hand-built inputs throughout. The real tree cannot produce these: the
    // only `OperatorOwned` file in the whole design is Helm's `values.yaml`,
    // which M7 introduces and M5 does not generate, so there is nothing in
    // `gears-rust` for this to be exercised against.

    #[test]
    fn a_change_on_one_side_only_is_taken() {
        let base = "a\nb\nc\n";
        let ours = "a\nB\nc\n";
        assert_eq!(merge(base, ours, base), Merge::Merged(ours.to_owned()));
        assert_eq!(merge(base, base, ours), Merge::Merged(ours.to_owned()));
    }

    #[test]
    fn disjoint_changes_are_both_kept() {
        let base = "one\ntwo\nthree\nfour\nfive\n";
        let ours = "one\nTWO\nthree\nfour\nfive\n";
        let theirs = "one\ntwo\nthree\nfour\nFIVE\n";
        assert_eq!(
            merge(base, ours, theirs),
            Merge::Merged("one\nTWO\nthree\nfour\nFIVE\n".to_owned())
        );
    }

    #[test]
    fn the_same_change_on_both_sides_is_not_a_conflict() {
        let base = "a\nb\nc\n";
        let both = "a\nB\nc\n";
        assert_eq!(merge(base, both, both), Merge::Merged(both.to_owned()));
    }

    #[test]
    fn different_changes_to_one_line_conflict() {
        let base = "a\nb\nc\n";
        assert_eq!(
            merge(base, "a\nOURS\nc\n", "a\nTHEIRS\nc\n"),
            Merge::Conflict
        );
    }

    #[test]
    fn an_operator_insertion_survives_a_regenerated_neighbourhood() {
        // The `values.yaml` case this exists for: the operator adds a key at
        // the end, the generator changes something near the top.
        let base = "image: old\nport: 8080\n";
        let ours = "image: old\nport: 8080\nnodeSelector:\n  disk: ssd\n";
        let theirs = "image: new\nport: 8080\n";
        assert_eq!(
            merge(base, ours, theirs),
            Merge::Merged("image: new\nport: 8080\nnodeSelector:\n  disk: ssd\n".to_owned())
        );
    }

    #[test]
    fn a_missing_trailing_newline_is_preserved() {
        let base = "a\nb";
        let theirs = "a\nB";
        assert_eq!(merge(base, base, theirs), Merge::Merged("a\nB".to_owned()));
    }

    #[test]
    fn adjacent_edits_are_reported_rather_than_interleaved() {
        // Documented over-reporting: `coalesce` treats touching regions as one,
        // so this is a conflict even though a smarter merge could interleave.
        // Asserted so the behaviour is a decision rather than a surprise.
        let base = "a\nb\nc\n";
        assert_eq!(merge(base, "a\nB\nc\n", "a\nb\nC\n"), Merge::Conflict);
    }
}
