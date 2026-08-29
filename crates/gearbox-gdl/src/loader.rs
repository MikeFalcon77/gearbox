//! The `load()` sandbox.
//!
//! Shared GDL fragments are a legitimate need -- a family of gears in one
//! repository will want one definition of a common SDK reference -- so
//! `enable_load` stays on. What makes that safe is this loader: a `load()` may
//! only reach a path inside the declaring file's source root, and any attempt to
//! climb above it is [`DiagnosticCode::GdlLoadEscape`].
//!
//! The check is in two halves, and both are needed. The lexical half pops `..`
//! from the requested path and refuses one that climbs out, *before* anything is
//! opened. The filesystem half canonicalizes what the lexical half produced and
//! refuses it if the real path leaves the real root -- which is the only way to
//! catch a symlink planted inside the root and pointed anywhere the process can
//! read. Lexical alone would be a sandbox in name only.
//!
//! Without it, `enable_load: true` would be the one hole in
//! `cpt-gearbox-fr-gdl-sandbox`: a description could read any file the process
//! can, which is exactly the hermeticity the resolver's determinism rests on.
//!
//! Loaded fragments are evaluated with the same locked-down dialect and the
//! same token scan as a top-level file, so a fragment cannot smuggle in a
//! conditional that the file loading it could not have written itself.
//!
//! [`DiagnosticCode::GdlLoadEscape`]: gearbox_ir::DiagnosticCode::GdlLoadEscape

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;

use starlark::environment::{FrozenModule, Globals, Module};
use starlark::eval::{Evaluator, FileLoader};
use starlark::syntax::AstModule;
use starlark::values::FrozenHeapName;

use crate::declarative::{dialect, scan_forbidden_tokens};

/// What every loader in one evaluation shares.
///
/// One `RefCell` for both halves rather than two, because they are always
/// updated together and a cycle check split across two locks is a cycle check
/// with a window in it.
#[derive(Default)]
struct LoadState {
    /// Frozen fragments, keyed by canonical path.
    ///
    /// A fragment loaded from two files must be the *same* frozen module, not
    /// two equal ones: re-evaluating would double any diagnostic it produces
    /// and waste the work.
    cache: BTreeMap<PathBuf, FrozenModule>,
    /// Fragments whose evaluation has started and not finished.
    ///
    /// This is what makes a cycle a diagnostic instead of a stack overflow: a
    /// fragment is only inserted into `cache` *after* it evaluates, so the cache
    /// alone cannot see that `a.gdl` is already on the stack when `b.gdl` loads
    /// it back.
    in_flight: BTreeSet<PathBuf>,
}

/// Resolves `load()` paths within one source root.
pub struct GdlLoader<'a> {
    /// The directory a relative `load()` is resolved against.
    base: PathBuf,
    /// The boundary no `load()` may cross.
    root: PathBuf,
    globals: &'a Globals,
    /// Shared with every nested loader this one creates.
    state: Rc<RefCell<LoadState>>,
}

/// The message a symlink escape carries, matched by [`is_load_escape`].
const OUTSIDE_ROOT: &str = "resolves outside the source root";

/// The message a cyclic `load()` carries.
const CYCLE: &str = "is already being loaded";

fn other(message: String) -> starlark::Error {
    starlark::Error::new_other(anyhow::anyhow!(message))
}

impl<'a> GdlLoader<'a> {
    /// A loader for a file in `base`, confined to `root`.
    #[must_use]
    pub fn new(base: impl Into<PathBuf>, root: impl Into<PathBuf>, globals: &'a Globals) -> Self {
        Self {
            base: base.into(),
            root: root.into(),
            globals,
            state: Rc::new(RefCell::new(LoadState::default())),
        }
    }

    /// A loader for a fragment's own directory, sharing this one's state.
    fn nested(&self, base: PathBuf) -> Self {
        Self {
            base,
            root: self.root.clone(),
            globals: self.globals,
            state: Rc::clone(&self.state),
        }
    }

    /// Resolve a `load()` argument to a path inside the root.
    ///
    /// Lexical rather than filesystem resolution: `..` is popped from the
    /// accumulated stack, so a path is rejected for climbing out *before*
    /// anything is opened. Canonicalizing first would follow a symlink out of
    /// the root and then compare the wrong thing; canonicalizing *afterwards*,
    /// in [`Self::confirm_inside_root`], is what catches the symlink itself.
    fn resolve(&self, request: &str) -> Result<PathBuf, String> {
        if request.is_empty() {
            return Err("empty load() path".to_owned());
        }

        // Bazel-style `//` means "from the source root"; anything else is
        // relative to the loading file's own directory.
        //
        // The `//` check must come before the absolute-path check: on Unix
        // `//shared.gdl` genuinely IS absolute by `Path::is_absolute`, so
        // testing that first rejects the root-relative form we mean to support.
        let (mut stack, rest) = if let Some(rest) = request.strip_prefix("//") {
            (Vec::new(), rest)
        } else {
            if Path::new(request).is_absolute() {
                return Err(format!(
                    "`{request}` is absolute; load() takes a path relative to the loading file"
                ));
            }
            let mut base = Vec::new();
            if let Ok(relative) = self.base.strip_prefix(&self.root) {
                for component in relative.components() {
                    if let Component::Normal(part) = component {
                        base.push(part.to_owned());
                    }
                }
            }
            (base, request)
        };

        for component in Path::new(rest).components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    if stack.pop().is_none() {
                        return Err(format!(
                            "`{request}` climbs above the source root `{}`",
                            self.root.display()
                        ));
                    }
                }
                Component::Normal(part) => stack.push(part.to_owned()),
                Component::RootDir | Component::Prefix(_) => {
                    return Err(format!("`{request}` is not a relative path"));
                }
            }
        }

        let mut resolved = self.root.clone();
        resolved.extend(stack);
        Ok(resolved)
    }

    /// The real path of `resolved`, refused if it leaves the real root.
    ///
    /// Both sides are canonicalized, so a symlink anywhere along the way -- in
    /// the fragment itself or in a directory above it -- is followed here and
    /// then compared, rather than being followed later by `read_to_string` with
    /// nothing comparing anything.
    fn confirm_inside_root(&self, request: &str, resolved: &Path) -> Result<PathBuf, String> {
        let real_root = self.root.canonicalize().map_err(|e| {
            format!(
                "cannot resolve the source root `{}`: {e}",
                self.root.display()
            )
        })?;
        let real = resolved
            .canonicalize()
            .map_err(|e| format!("cannot read `{}`: {e}", resolved.display()))?;

        if real.starts_with(&real_root) {
            Ok(real)
        } else {
            Err(format!(
                "`{request}` {OUTSIDE_ROOT} `{}`: it resolves to `{}`, which a symlink or mount \
                 puts outside it",
                real_root.display(),
                real.display()
            ))
        }
    }

    /// Evaluate one fragment to a frozen module.
    ///
    /// Starlark's own errors are passed through rather than stringified: they
    /// carry the fragment's span, and a fragment failure with no location is
    /// exactly as unhelpful as a top-level one would be.
    fn evaluate(&self, path: &Path) -> starlark::Result<FrozenModule> {
        let uri = gearbox_ir::file_uri(path);
        let source = std::fs::read_to_string(path)
            .map_err(|e| other(format!("cannot read `{}`: {e}", path.display())))?;

        // A fragment is held to the same standard as the file loading it.
        let forbidden = scan_forbidden_tokens(&uri, &source);
        if let Some(first) = forbidden.first() {
            return Err(other(format!(
                "`{}` contains a construct GDL does not permit: {}",
                path.display(),
                first.message
            )));
        }

        let ast = AstModule::parse(&uri, source, &dialect())?;

        // Nested loads resolve from the fragment's own directory, against the
        // same root and the same cache. Declared before the evaluator because
        // `set_loader` borrows it for the evaluator's whole lifetime.
        let nested = self.nested(path.parent().unwrap_or(&self.root).to_path_buf());

        Module::with_temp_heap(|module| {
            {
                let mut eval = Evaluator::new(&module);
                eval.set_loader(&nested);
                eval.eval_module(ast, self.globals)?;
            }
            module
                .freeze_named(FrozenHeapName::User(Box::new(uri)))
                .map_err(|e| other(format!("cannot freeze `{}`: {e:?}", path.display())))
        })
    }
}

impl FileLoader for GdlLoader<'_> {
    fn load(&self, path: &str) -> starlark::Result<FrozenModule> {
        let resolved = self.resolve(path).map_err(other)?;
        let real = self.confirm_inside_root(path, &resolved).map_err(other)?;

        {
            let mut state = self.state.borrow_mut();
            if let Some(cached) = state.cache.get(&real) {
                return Ok(cached.clone());
            }
            if !state.in_flight.insert(real.clone()) {
                return Err(other(format!(
                    "`{path}` {CYCLE}: `{}` is part of a load() cycle, and GDL fragments may \
                     not be mutually recursive",
                    real.display()
                )));
            }
        }

        // Outside the borrow: `evaluate` re-enters `load` for nested fragments.
        let evaluated = self.evaluate(&real);

        let mut state = self.state.borrow_mut();
        state.in_flight.remove(&real);
        let module = evaluated?;
        state.cache.insert(real, module.clone());
        Ok(module)
    }
}

/// Whether a load failure was an escape attempt rather than a missing or
/// malformed fragment.
///
/// Distinguishing them matters: an escape is a sandbox violation with its own
/// code and its own remedy, whereas a typo in a path is an ordinary mistake.
#[must_use]
pub fn is_load_escape(error: &starlark::Error) -> bool {
    let message = error.to_string();
    message.contains("climbs above the source root")
        || message.contains("is absolute; load() takes a path")
        || message.contains("is not a relative path")
        || message.contains(OUTSIDE_ROOT)
}
