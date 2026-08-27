//! The `load()` sandbox.
//!
//! Shared GDL fragments are a legitimate need -- a family of gears in one
//! repository will want one definition of a common SDK reference -- so
//! `enable_load` stays on. What makes that safe is this loader: a `load()` may
//! only reach a path inside the declaring file's source root, and any attempt to
//! climb above it is [`DiagnosticCode::GdlLoadEscape`].
//!
//! Without it, `enable_load: true` would be the one hole in
//! `cpt-gearbox-fr-gdl-sandbox`: a description could read any file the process
//! can, which is exactly the hermeticity the resolver's determinism rests on.
//!
//! Loaded fragments are evaluated with the same locked-down dialect and the
//! same token scan as a top-level file, so a fragment cannot smuggle in a
//! conditional that the file loading it could not have written itself.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use starlark::environment::{FrozenModule, Globals, Module};
use starlark::eval::{Evaluator, FileLoader};
use starlark::syntax::AstModule;
use starlark::values::FrozenHeapName;

use crate::declarative::{dialect, scan_forbidden_tokens};

/// Resolves `load()` paths within one source root.
pub struct GdlLoader<'a> {
    /// The directory a relative `load()` is resolved against.
    base: PathBuf,
    /// The boundary no `load()` may cross.
    root: PathBuf,
    globals: &'a Globals,
    /// Frozen fragments, keyed by canonical path.
    ///
    /// A fragment loaded from two files must be the *same* frozen module, not
    /// two equal ones: re-evaluating would double any diagnostic it produces
    /// and waste the work.
    cache: RefCell<BTreeMap<PathBuf, FrozenModule>>,
}

impl<'a> GdlLoader<'a> {
    /// A loader for a file in `base`, confined to `root`.
    #[must_use]
    pub fn new(base: impl Into<PathBuf>, root: impl Into<PathBuf>, globals: &'a Globals) -> Self {
        Self {
            base: base.into(),
            root: root.into(),
            globals,
            cache: RefCell::new(BTreeMap::new()),
        }
    }

    /// Resolve a `load()` argument to a path inside the root.
    ///
    /// Lexical rather than filesystem resolution: `..` is popped from the
    /// accumulated stack, so a path is rejected for climbing out *before*
    /// anything is opened. Canonicalizing first would follow a symlink out of
    /// the root and then compare the wrong thing.
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

    /// Evaluate one fragment to a frozen module.
    fn evaluate(&self, path: &Path) -> Result<FrozenModule, String> {
        let uri = format!("file://{}", path.display());
        let source = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read `{}`: {e}", path.display()))?;

        // A fragment is held to the same standard as the file loading it.
        let forbidden = scan_forbidden_tokens(&uri, &source);
        if let Some(first) = forbidden.first() {
            return Err(format!(
                "`{}` contains a construct GDL does not permit: {}",
                path.display(),
                first.message
            ));
        }

        let ast = AstModule::parse(&uri, source, &dialect())
            .map_err(|e| format!("cannot parse `{}`: {e}", path.display()))?;

        // Nested loads resolve from the fragment's own directory, against the
        // same root. Declared before the evaluator because `set_loader` borrows
        // it for the evaluator's whole lifetime.
        let nested = GdlLoader::new(
            path.parent().unwrap_or(&self.root).to_path_buf(),
            self.root.clone(),
            self.globals,
        );

        Module::with_temp_heap(|module| {
            {
                let mut eval = Evaluator::new(&module);
                eval.set_loader(&nested);
                eval.eval_module(ast, self.globals)
                    .map_err(|e| format!("cannot evaluate `{}`: {e}", path.display()))?;
            }
            module
                .freeze_named(FrozenHeapName::User(Box::new(uri)))
                .map_err(|e| format!("cannot freeze `{}`: {e:?}", path.display()))
        })
    }
}

impl FileLoader for GdlLoader<'_> {
    fn load(&self, path: &str) -> starlark::Result<FrozenModule> {
        let resolved = self
            .resolve(path)
            .map_err(|e| starlark::Error::new_other(anyhow::anyhow!(e)))?;

        if let Some(cached) = self.cache.borrow().get(&resolved) {
            return Ok(cached.clone());
        }

        let module = self
            .evaluate(&resolved)
            .map_err(|e| starlark::Error::new_other(anyhow::anyhow!(e)))?;

        self.cache.borrow_mut().insert(resolved, module.clone());
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
}
