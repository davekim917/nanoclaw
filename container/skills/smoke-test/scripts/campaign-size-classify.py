#!/usr/bin/env python3
"""Mechanical campaign-size classifier for smoke-pr-gate.sh.

Reads a JSON array of repo-relative changed-file paths from stdin and an
install-supplied sizing-rules file path as argv[1]. Prints one JSON object
`{"campaignSize": "...", "sizeReason": "..."}` and exits 0.

Deliberately NOT fnmatch: fnmatch's `*` already matches `/`, so it cannot
express "`*` stays within one path segment, `**` crosses segments" — the
distinction the rules format depends on. Glob translation here is
purpose-built for that distinction plus `{a,b}` alternation.

This script never decides "full" for an undeterminable file list (fetch
failure, truncated listing) — that fail-closed call is made by the caller
(smoke-pr-gate.sh) BEFORE this script is invoked, using facts (fetchOk,
truncation) this script has no access to. This script only classifies a
complete, known file list against the rules.
"""
import ast
import json
import os
import re
import sys


def expand_braces(pattern):
    """Expand one or more `{a,b,c}` alternation groups into concrete globs.

    Only handles non-nested groups (rules format does not need nesting) --
    finds the first `{...}`, splits its comma list, and recurses so multiple
    groups in one pattern (or the copies produced by an earlier group) all
    get expanded.
    """
    start = pattern.find("{")
    if start == -1:
        return [pattern]
    end = pattern.find("}", start)
    if end == -1:
        return [pattern]
    prefix = pattern[:start]
    suffix = pattern[end + 1:]
    options = pattern[start + 1:end].split(",")
    out = []
    for opt in options:
        out.extend(expand_braces(prefix + opt + suffix))
    return out


def _segment_to_regex(segment):
    """Translate one `/`-free glob segment (already brace-expanded, no `**`)
    into a regex fragment. `*` matches within the segment only, since the
    caller never hands this a `/`."""
    out = []
    for ch in segment:
        if ch == "*":
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(ch))
    return "".join(out)


def _glob_to_regex_no_braces(glob):
    """Translate a single brace-free glob (repo-relative, no leading `/`)
    into an anchored regex. `**` crosses directories; `*` does not."""
    segs = glob.split("/")
    n = len(segs)
    result = ""
    for i, seg in enumerate(segs):
        if seg == "**":
            if n == 1:
                # whole pattern is exactly '**' -- matches anything
                result += ".*"
            elif i == 0:
                # '**/rest' -- zero or more leading directories
                result += "(?:.*/)?"
            elif i == n - 1:
                # 'prefix/**' -- this directory and everything under it
                result += "/.*"
            else:
                # 'a/**/b' -- zero or more full directories between a and b
                result += "/(?:.*/)?"
            continue
        seg_regex = _segment_to_regex(seg)
        prev = segs[i - 1] if i > 0 else None
        if i == 0:
            result += seg_regex
        elif prev == "**":
            # the '**' piece already accounted for the separating slash
            result += seg_regex
        else:
            result += "/" + seg_regex
    return "^" + result + "$"


def compile_glob(glob):
    """Return a list of compiled regexes for one glob (>1 only when it
    contains `{a,b}` alternation)."""
    return [re.compile(_glob_to_regex_no_braces(g)) for g in expand_braces(glob)]


def compile_rule_list(globs):
    """[(original_glob_string, [compiled_regex, ...]), ...]"""
    return [(g, compile_glob(g)) for g in globs]


def match_first(path, compiled_rules):
    """Return the original glob string of the first rule matching `path`,
    or None."""
    for original, regexes in compiled_rules:
        for rx in regexes:
            if rx.match(path):
                return original
    return None


# `match` captures bind through plain string fields, not an `ast.Name`
# target. These node types exist only on Python 3.10+, which is also the
# first version where `match` parses at all, so they are looked up
# defensively -- on an older interpreter the statement cannot exist.
_MATCH_NAME_NODES = tuple(
    n
    for n in (getattr(ast, attr, None) for attr in ("MatchAs", "MatchStar"))
    if n is not None
)
_MATCH_REST_NODES = tuple(n for n in (getattr(ast, "MatchMapping", None),) if n is not None)
_MATCH_STATEMENT = getattr(ast, "Match", None)

# Builtins that reach into the module namespace, or the import system, BY
# STRING -- so no name-level analysis can see what they rebind. A file that
# is a policy-constants source has no need for any of them at top level.
_NAMESPACE_BUILTINS = frozenset(
    ("globals", "vars", "setattr", "exec", "eval", "__import__")
)


def _module_level_nodes(node):
    """Walk `node`, but never into a function, lambda or class body: that
    code runs only when something calls it, so it is not top-level code."""
    stack = [node]
    while stack:
        cur = stack.pop()
        yield cur
        for child in ast.iter_child_nodes(cur):
            if isinstance(
                child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
            ):
                continue
            stack.append(child)


def _namespace_escape(node):
    """Name of the namespace-reaching builtin used by top-level statement
    `node`, or None -- `globals()[...] = ...`, `vars()`, `setattr`, `exec`,
    `eval`, `__import__`, `sys.modules[...]`. Each can rebind any name by
    string, which every check below (all of which read names) would miss.
    Function and class BODIES are not scanned: they are not top-level code,
    and a helper that happens to call `setattr` is an ordinary thing for a
    real policy file to contain."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return None
    for sub in _module_level_nodes(node):
        if isinstance(sub, ast.Name) and sub.id in _NAMESPACE_BUILTINS:
            return sub.id
        if (
            isinstance(sub, ast.Attribute)
            and sub.attr == "modules"
            and isinstance(sub.value, ast.Name)
            and sub.value.id == "sys"
        ):
            return "sys.modules"
    return None


def _roots_at_name(node, name):
    """True if `node` is an attribute/subscript chain rooted at `name`
    (`name.x`, `name[0].y`) -- a use that reaches INTO the name's value."""
    cur = node
    while isinstance(cur, (ast.Attribute, ast.Subscript)):
        cur = cur.value
    return isinstance(cur, ast.Name) and cur.id == name


# Callees that cannot mutate what they are handed, so passing the constant
# to one of them is a READ. Anything else -- a module-level helper, an
# imported function, `list.append(NAME, ...)` -- receives the list BY
# REFERENCE and can mutate it in place while the file is being imported,
# which leaves the literal this classifier reads a stale, partial policy
# (round-2 review of #736).
_PURE_CALLEES = frozenset(("len", "sorted", "tuple", "list", "set", "any", "all"))
_PURE_SCALAR_CALLEES = frozenset(("len", "any", "all"))
_PURE_SHALLOW_COPY_CALLEES = frozenset(("sorted", "tuple", "list", "set"))

# Result-reference lattice for a binding RHS.  `_REF_NONE` is a proof that
# the expression's RESULT cannot retain the policy list; the other two states
# are unsafe for a new binding.  Keeping direct and possible/nested reference
# separate makes the two safe list-copy forms below explicit without trying
# to interpret arbitrary Python expressions.
_REF_NONE = 0
_REF_DIRECT = 1
_REF_MAY_RETAIN = 2


def _module_bound_names(tree):
    """Every name that module-level code BINDS, whatever the binder.

    `def`, `class`, `import`/`from ... import` (with or without `as`), a
    plain or annotated assignment, `+=`, `for ... in`, `with ... as`,
    `except ... as`, `del`, a walrus, `global`, and `match` captures all bind
    a module name, and every one of them can bind a name this file would
    otherwise take for a builtin (round-3 review of #736). The rule is
    "bound at module level", not a list of the forms -- a list of forms is a
    list to be wrong about.

    A binding inside a top-level `if`, `try`, `with` or `for` counts: that
    code runs at import too. A function, lambda or class BODY does not --
    its names are local -- so the walk records the definition's own name and
    walks only the parts evaluated at import: decorators, base classes,
    default arguments and annotations, any of which can carry a walrus.

    Deliberately over-inclusive where it is cheap: a comprehension target is
    function-scoped in Python 3 and does not really bind here, but an extra
    name only ever costs a `full`, and the exceptions are another list to be
    wrong about. A star import binds names that cannot be enumerated at all,
    so it is recorded as `"*"` -- not a legal identifier, so only a check
    that asks about it deliberately can read it.
    """
    names = set()
    stack = list(tree.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            if not isinstance(node, ast.Lambda):
                names.add(node.name)
            for field, value in ast.iter_fields(node):
                if field == "body":
                    continue
                for child in value if isinstance(value, list) else [value]:
                    if isinstance(child, ast.AST):
                        stack.append(child)
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for imported in node.names:
                if imported.name == "*":
                    names.add("*")
                else:
                    names.add(imported.asname or imported.name.split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
        elif _MATCH_NAME_NODES and isinstance(node, _MATCH_NAME_NODES) and node.name:
            names.add(node.name)
        elif _MATCH_REST_NODES and isinstance(node, _MATCH_REST_NODES) and node.rest:
            names.add(node.rest)
        stack.extend(ast.iter_child_nodes(node))
    return names


def _call_is_pure(func, bound):
    """True for a callee that cannot mutate its arguments: one of the
    `_PURE_CALLEES` builtins, or `str.join` on a literal separator -- the
    `"|".join(NAME)` a real policy file actually writes.

    `bound` is every name module-level code binds (`_module_bound_names`).
    `_PURE_CALLEES` is a list of BUILTIN names, and a policy file is free to
    bind any of those names itself -- `def len(globs): globs.append(...)`,
    `class len`, `from x import len`, `len = _widen`, `for len in ...`. Read
    by spelling alone, such a call scores a pure read and the classifier
    trusts a literal the real import widens: #723's class through this
    guard's own door (round-3 review of #736). A name the file binds is not
    the builtin it spells, so it is not pure -- whatever the binding form,
    and wherever in the file it sits: which of the two a given call reaches
    depends on execution order, and refusing is the fail-closed answer.

    `"...".join` needs no such check -- the receiver is a string CONSTANT, so
    the method resolves on `str` itself and no module-level name is
    consulted."""
    if isinstance(func, ast.Name):
        # A star import binds names that cannot be enumerated, so no name is
        # provably the builtin. Any top-level star import already refuses the
        # whole file at `_rebinding_use`'s ImportFrom branch below, so this is
        # the same answer reached twice, kept so the rule reads as "provably
        # the builtin" rather than "absent from one list".
        if "*" in bound:
            return False
        return func.id in _PURE_CALLEES and func.id not in bound
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "join"
        and isinstance(func.value, ast.Constant)
        and isinstance(func.value.value, str)
    )


def _passes_name(call, name):
    """True if `call` hands `name` ITSELF to its callee -- positionally, by
    keyword, or unpacked (`f(*NAME)`, `f(**NAME)`). A nested call needs no
    special case: `f(g(NAME))` is two Call nodes, and the walk that uses this
    checks each one, so an impure `g` is caught at `g`."""
    handed = [arg.value if isinstance(arg, ast.Starred) else arg for arg in call.args]
    # `f(x=NAME)` carries the name on the keyword's value, and so does
    # `f(**NAME)` (a keyword whose `arg` is None).
    handed.extend(kw.value for kw in call.keywords)
    return any(isinstance(a, ast.Name) and a.id == name for a in handed)


def _module_function_defs(tree):
    """Module-level `def`s by name -- every callee a top-level call can
    reach without going through an import."""
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _called_function_escape(node, defs):
    """`(function, escape)` for a namespace escape inside a function that
    this top-level statement CALLS, or None.

    `_namespace_escape` deliberately does not scan function bodies -- they
    are not import-time code. But a body that is *called* at top level does
    run at import time, and `setattr(sys.modules[__name__], "NAME", [])` in
    there rebinds the constant with nothing at top level naming either the
    builtin or the constant (round-2 review of #736). Calls are followed
    transitively, so a helper that delegates to another helper is covered.

    Deliberately NOT "refuse every top-level call to a module-level
    function": a real policy file calls its own helpers freely (the live one
    does so 46 times at module level), and refusing those is round 1's
    regression again. Only a reachable namespace escape refuses."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return None
    pending = [
        sub.func.id
        for sub in _module_level_nodes(node)
        if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name) and sub.func.id in defs
    ]
    seen = set()
    while pending:
        fname = pending.pop()
        if fname in seen:
            continue
        seen.add(fname)
        for sub in ast.walk(defs[fname]):
            if isinstance(sub, ast.Name) and sub.id in _NAMESPACE_BUILTINS:
                return fname, sub.id
            if (
                isinstance(sub, ast.Attribute)
                and sub.attr == "modules"
                and isinstance(sub.value, ast.Name)
                and sub.value.id == "sys"
            ):
                return fname, "sys.modules"
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name) and sub.func.id in defs:
                pending.append(sub.func.id)
    return None


def _binding_result_reference(value, name, bound):
    """Conservatively classify whether a binding RHS retains `name`'s list.

    This is a bounded reference proof, not a Python interpreter.  Unknown
    NAME-containing shapes are `_REF_MAY_RETAIN` by default.  `_REF_NONE` is
    reserved for the ordinary policy forms whose result is known not to hold
    the mutable list: a scalar pure call, a direct shallow copy of the trusted
    flat string list, literal-string `join`, eager comprehensions over its
    strings, and direct list concatenation in either order where the other
    operand contains no reference to NAME. The whole RHS is considered,
    including a call's callee, so a closure or a second list operand cannot
    hide a retained reference.
    """
    if isinstance(value, ast.Name) and value.id == name:
        return _REF_DIRECT

    # A list/set/dict comprehension eagerly creates a new container. When its
    # output expression does not retain NAME, iterating the trusted flat list
    # contributes only immutable strings; the result cannot alias NAME itself.
    # Do not apply this to GeneratorExp: a lazy generator keeps its source
    # iterator alive and can therefore retain the original list.
    if isinstance(value, (ast.ListComp, ast.SetComp, ast.DictComp)):
        result_values = (value.key, value.value) if isinstance(value, ast.DictComp) else (value.elt,)
        iterable_is_safe = all(
            _binding_result_reference(generator.iter, name, bound) != _REF_MAY_RETAIN
            for generator in value.generators
        )
        result_is_safe = all(
            _binding_result_reference(result, name, bound) == _REF_NONE for result in result_values
        )
        if iterable_is_safe and result_is_safe:
            return _REF_NONE

    # `[*NAME]` and `NAME[:]` create a new outer list. The trusted policy is
    # validated as a flat list of strings, so neither form can retain its list
    # object (unlike `[NAME]`, which deliberately falls through below).
    if isinstance(value, ast.List):
        has_direct_spread = any(
            isinstance(item, ast.Starred) and _binding_result_reference(item.value, name, bound) == _REF_DIRECT
            for item in value.elts
        )
        items_are_safe = all(
            (
                _binding_result_reference(item.value, name, bound) != _REF_MAY_RETAIN
                if isinstance(item, ast.Starred)
                else _binding_result_reference(item, name, bound) == _REF_NONE
            )
            for item in value.elts
        )
        if has_direct_spread and items_are_safe:
            return _REF_NONE
    if (
        isinstance(value, ast.Subscript)
        and isinstance(value.value, ast.Name)
        and value.value.id == name
        and isinstance(value.slice, ast.Slice)
    ):
        return _REF_NONE

    children = list(ast.iter_child_nodes(value))
    child_refs = [_binding_result_reference(child, name, bound) for child in children]
    if all(ref == _REF_NONE for ref in child_refs):
        return _REF_NONE

    if isinstance(value, ast.Call) and _call_is_pure(value.func, bound):
        if isinstance(value.func, ast.Attribute):
            # `_call_is_pure` admits only a literal-string `.join`; its
            # result is a string even when its iterable reads NAME.
            return _REF_NONE
        if value.func.id in _PURE_SCALAR_CALLEES:
            return _REF_NONE
        if value.func.id in _PURE_SHALLOW_COPY_CALLEES:
            # The trusted assignment is validated as a flat list of strings,
            # so copying NAME directly copies only immutable string elements.
            if (
                len(value.args) == 1
                and not value.keywords
                and isinstance(value.args[0], ast.Name)
                and value.args[0].id == name
            ):
                return _REF_NONE

    if isinstance(value, ast.BinOp) and isinstance(value.op, ast.Add):
        left_ref = _binding_result_reference(value.left, name, bound)
        right_ref = _binding_result_reference(value.right, name, bound)
        if not (
            (left_ref == _REF_DIRECT and right_ref == _REF_NONE)
            or (right_ref == _REF_DIRECT and left_ref == _REF_NONE)
        ):
            return _REF_MAY_RETAIN
        # `NAME` is the trusted flat list, so list concatenation creates a new
        # outer list and contributes only immutable strings from NAME.  The
        # other operand must independently prove it retains no NAME reference;
        # concatenation is symmetric for these new list results.
        return _REF_NONE

    return _REF_MAY_RETAIN


def _binding_value_aliases_name(value, name, bound):
    return _binding_result_reference(value, name, bound) != _REF_NONE


def _match_pattern_binds(pattern):
    """True when a match pattern captures any value under a new name."""
    for sub in ast.walk(pattern):
        if _MATCH_NAME_NODES and isinstance(sub, _MATCH_NAME_NODES) and sub.name:
            return True
        if _MATCH_REST_NODES and isinstance(sub, _MATCH_REST_NODES) and sub.rest:
            return True
    return False


def _rebinding_use(node, name, bound):
    """How top-level statement `node` binds or mutates `name`, as a phrase,
    or None if it does neither. `bound` is every name module-level code binds
    (`_module_bound_names`), which is what tells a genuine pure builtin from
    this file's own binding of the same spelling.

    Only BINDING and MUTATING uses count. A plain read leaves the assigned
    literal exactly as written and must pass: `ALL = NAME + OTHER`,
    `len(NAME)`, `re.compile("|".join(NAME))`. Refusing reads refuses the
    ordinary shape of a real policy file -- one constant, plus everything
    derived from it in the same module -- which is how the first cut of this
    guard turned every PR on a live install `full` (round-1 review of #736).

    Checked at any depth inside the statement: a rebinding inside a top-level
    `if`, `try` or `with` block rebinds the module name just the same."""
    for sub in ast.walk(node):
        # `NAME = ...` (a second binding), `NAME += ...`, `for NAME in ...`,
        # `with ... as NAME`, `del NAME`, `(NAME := ...)`: every one of these
        # parses as an ast.Name in a Store or Del context.
        if (
            isinstance(sub, ast.Name)
            and sub.id == name
            and isinstance(sub.ctx, (ast.Store, ast.Del))
        ):
            return "rebinds or deletes"
        # `NAME[0] = ...`, `NAME.attr = ...`, `del NAME[0]` -- the name still
        # points at the same object, whose contents just changed.
        if (
            isinstance(sub, (ast.Subscript, ast.Attribute))
            and isinstance(sub.ctx, (ast.Store, ast.Del))
            and _roots_at_name(sub, name)
        ):
            return "stores into"
        # `NAME.append(...)`, `.extend(...)`, `.insert(...)`, `.pop()`,
        # `.clear()`, `.remove()`, `.sort()`, `.reverse()`, `.update()`. Any
        # method call is refused rather than a named list of mutators: an
        # allowlist of "safe" methods is a list to be wrong about
        # (`__setitem__`), and a constants file has no reason to call a
        # method on its constant at top level at all.
        if (
            isinstance(sub, ast.Call)
            and isinstance(sub.func, ast.Attribute)
            and _roots_at_name(sub.func, name)
        ):
            return "calls a method on"
        # The constant HANDED to a call that could mutate it in place:
        # `_widen(NAME)`, where the helper does `globs.append(...)`, or
        # `list.append(NAME, "...")`. Both read like a plain use at the call
        # site -- nothing else in this function would see them -- and both
        # leave the literal above a partial policy once the module is
        # imported for real. Only a callee that provably cannot mutate its
        # argument is allowed through (round-2 review of #736), and a name
        # this file binds at module level is not the builtin it spells
        # (round-3 review of #736).
        if isinstance(sub, ast.Call) and not _call_is_pure(sub.func, bound) and _passes_name(sub, name):
            return "hands it to a call that could mutate"
        if isinstance(sub, (ast.Global, ast.Nonlocal)) and name in sub.names:
            return "declares a global/nonlocal binding for"
        # Assignment is not the only way a new module name can retain this
        # list.  A loop target receives values from its iterable.  Iterating
        # NAME itself (or a proven flat copy) yields only the trusted immutable
        # strings, but an iterable that MAY retain NAME can yield the list
        # object itself, including through nested destructuring.
        if (
            isinstance(sub, (ast.For, ast.AsyncFor))
            and _binding_result_reference(sub.iter, name, bound) == _REF_MAY_RETAIN
        ):
            return "aliases through an iterable binding"
        # Augmented assignment may retain its RHS through the target's
        # in-place operator.  Its target can be any user-defined object, so a
        # reference-bearing RHS is refused rather than interpreting `__iadd__`
        # (or the other augmented operators) as a particular builtin type.
        if (
            isinstance(sub, ast.AugAssign)
            and _binding_value_aliases_name(sub.value, name, bound)
        ):
            return "aliases through augmented assignment"
        # `with EXPR as TARGET` and its async form also bind a value derived
        # from EXPR.  If EXPR retains NAME, the context-manager protocol does
        # not prove that the bound value is independent of it.
        if isinstance(sub, (ast.With, ast.AsyncWith)):
            for item in sub.items:
                if (
                    item.optional_vars is not None
                    and _binding_value_aliases_name(item.context_expr, name, bound)
                ):
                    return "aliases through a context-manager binding"
        # A capture pattern can bind the whole subject or a nested value from
        # it.  Reference-bearing subjects are therefore unsafe when any arm
        # captures, without trying to execute Python's pattern semantics.
        if _MATCH_STATEMENT and isinstance(sub, _MATCH_STATEMENT) and _binding_value_aliases_name(sub.subject, name, bound):
            if any(_match_pattern_binds(case.pattern) for case in sub.cases):
                return "aliases through a match capture"
        # `X = NAME`, destructuring a tuple that contains NAME, or binding a
        # conditional that can select NAME all preserve the one list object.
        # A mutation through the other binding then leaves the literal above
        # looking complete while the imported policy has widened.
        if (
            isinstance(sub, (ast.Assign, ast.AnnAssign, ast.NamedExpr))
            and sub.value is not None
            and _binding_value_aliases_name(sub.value, name, bound)
        ):
            return "aliases"
        # Rebinding through a STRING field, which no ast.Name check above can
        # see: `from x import NAME`, `import x as NAME`, `import NAME`, and a
        # star import, which binds names this classifier cannot enumerate.
        if isinstance(sub, (ast.Import, ast.ImportFrom)):
            for imported in sub.names:
                if imported.name == "*":
                    return "may rebind (a star import binds names this classifier cannot see)"
                if (imported.asname or imported.name.split(".")[0]) == name:
                    return "imports over"
        if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name == name:
            return "defines a function over"
        if isinstance(sub, ast.ClassDef) and sub.name == name:
            return "defines a class over"
        if isinstance(sub, ast.ExceptHandler) and sub.name == name:
            return "binds a caught exception to"
        if _MATCH_NAME_NODES and isinstance(sub, _MATCH_NAME_NODES) and sub.name == name:
            return "captures a match subject into"
        if _MATCH_REST_NODES and isinstance(sub, _MATCH_REST_NODES) and sub.rest == name:
            return "captures a match mapping rest into"
    return None


def _find_top_level_assignment(tree, name):
    """Return `(value_node, None)` for the sole top-level `name = ...` (or
    `name: T = ...`) assignment in `tree.body` -- the one shape this format
    trusts -- or `(None, reason)` if `name` is never assigned at top level,
    or if ANY other top-level statement BINDS or MUTATES `name`: a second
    assignment, `+=`, `.extend(...)`/`.append(...)`, `del name`, item or
    attribute assignment, `global name`, an alias (`X = name`, which shares
    the one list object), or a rebinding through a string field --
    `from x import name`, `import x as name`, a star import, `def name`,
    `class name`, `except ... as name`, a `match` capture.

    A plain READ is not any of those and passes: `ALL = name + OTHER`,
    `len(name)`, `re.compile("|".join(name))`. That distinction is the whole
    point -- a real policy file is one constant plus everything derived from
    it, and refusing the derived lines refuses every PR on that install
    (round-1 review of #736).

    Deliberately does not try to evaluate what a refused statement does --
    refusing is the safe, simple behaviour for every shape but the single
    literal assignment this format trusts; a partial policy silently read as
    complete is exactly the failure mode this guards against. The trusted
    assignment must be at top level: a value assigned conditionally or built
    inside a function is not a fixed policy constant this format can trust."""
    found = None
    defs = _module_function_defs(tree)
    bound = _module_bound_names(tree)
    for node in tree.body:
        escape = _namespace_escape(node)
        if escape is not None:
            return None, "a top-level {} statement uses {}, which can rebind any name by string".format(
                type(node).__name__, escape
            )
        called = _called_function_escape(node, defs)
        if called is not None:
            return None, "a top-level {} statement calls {}(), whose body uses {}, which can rebind any name by string".format(
                type(node).__name__, called[0], called[1]
            )
        # A bare annotation (`name: list[str]`) declares a type for the
        # assignment below it. It binds nothing and carries no value, so it
        # is neither the trusted assignment nor a reason to refuse one.
        if (
            isinstance(node, ast.AnnAssign)
            and node.value is None
            and isinstance(node.target, ast.Name)
            and node.target.id == name
        ):
            continue
        is_plain_assign = False
        if isinstance(node, ast.Assign):
            # A chained/multi-target assignment binds every target to the
            # same RHS object.  Trust only one bare target: other targets
            # would be aliases of this policy list even when the RHS itself
            # is a literal.
            is_plain_assign = (
                len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == name
            )
        elif isinstance(node, ast.AnnAssign):
            is_plain_assign = (
                isinstance(node.target, ast.Name)
                and node.target.id == name
                and node.value is not None
            )
        if is_plain_assign:
            if found is not None:
                return None, "reassigned at top level (a second assignment makes the value untrustworthy)"
            found = node.value
            continue
        phrase = _rebinding_use(node, name, bound)
        if phrase is not None:
            return None, "another top-level {} statement {} it".format(
                type(node).__name__, phrase
            )
    if found is None:
        return None, "not found at top level"
    return found, None


def load_full_globs_from(spec):
    """Load `fullGlobsFrom: {"path": <python file>, "name": <variable>}`.

    Returns (globs, None) on success or (None, reason) on any failure. The
    install's release policy already owns its sensitive-path list; this lets
    smoke read it directly instead of keeping a second, driftable copy.

    Deliberately reads the named constant with `ast` + `literal_eval` rather
    than importing the file as a module: running another team's program just
    to get one literal means any future non-stdlib import or import-time side
    effect in that file (a `yaml` import, an env read) would either silently
    turn every PR `full` or execute code this classifier never meant to run.
    A literal has no such surface -- `literal_eval` only ever produces plain
    data, never runs arbitrary statements.

    Every failure mode here is a caller instruction to fail closed to `full`
    — an unreadable file, a file that doesn't parse, a name never assigned at
    top level, a name bound or mutated by any top-level statement besides
    the one trusted assignment (`+=`, `.extend`/`.append`, `del`, a second
    assignment, an alias, an import that rebinds it), a top-level statement
    that reaches the namespace by string (`globals`, `setattr`, `exec`), a
    value that isn't a literal, and a value of the wrong type are all
    indistinguishable from "this rules file's full-glob policy could not be
    read," which must never silently fall through to a lighter campaign.
    """
    if not isinstance(spec, dict):
        return None, "fullGlobsFrom must be an object with path and name"
    path = spec.get("path")
    name = spec.get("name")
    if not isinstance(path, str) or not path:
        return None, "fullGlobsFrom.path is missing or not a string"
    if not isinstance(name, str) or not name:
        return None, "fullGlobsFrom.name is missing or not a string"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        return None, "fullGlobsFrom.path {} could not be read: {}".format(path, exc)
    try:
        tree = ast.parse(source, filename=path)
    except (SyntaxError, ValueError) as exc:
        return None, "fullGlobsFrom.path {} could not be parsed: {}".format(path, exc)
    value_node, reason = _find_top_level_assignment(tree, name)
    if value_node is None:
        if reason == "not found at top level":
            return None, "fullGlobsFrom.name {} not found at top level in {}".format(name, path)
        return None, "fullGlobsFrom.name {} in {} is untrustworthy: {}".format(name, path, reason)
    try:
        value = ast.literal_eval(value_node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError) as exc:
        return None, "fullGlobsFrom.name {} in {} is not a literal: {}".format(name, path, exc)
    if not isinstance(value, (list, tuple)) or not all(isinstance(v, str) for v in value):
        return None, "fullGlobsFrom.name {} in {} is not a list of strings".format(name, path)
    return list(value), None


def validate_rules_shape(rules):
    """Reason the rules object is malformed, or None.

    `list(rules.get(key) or [])` below accepts anything iterable, so a rule
    list written as a bare string -- `"full": "backend/**"` -- becomes one
    glob per CHARACTER, none of which matches any path: a sensitive PR then
    sizes `light`. That is the same "configured but broken read as fine"
    class the rest of this script fails closed on, so every rule list is
    checked before any of it is compiled.

    An explicit `null` is malformed, not absent: a key written out with no
    value is a half-finished edit, never a deliberate "no rules here".
    Unknown keys are left alone -- the format has always carried `_comment`.
    """
    for key in ("full", "lightAllowed", "lightDeny"):
        if key not in rules:
            continue
        value = rules[key]
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            return "{} must be absent or a list of strings".format(key)
    if "fullGlobsFrom" in rules and not isinstance(rules["fullGlobsFrom"], dict):
        return "fullGlobsFrom must be absent or an object"
    return None


def classify(files, rules):
    full_globs = list(rules.get("full", []) or [])
    full_globs_from = rules.get("fullGlobsFrom")
    if full_globs_from is not None:
        imported_globs, error = load_full_globs_from(full_globs_from)
        if error is not None or imported_globs is None:
            return "full", "full: {}".format(error)
        # Union with any local `full` globs, order preserved, no duplicates.
        for g in imported_globs:
            if g not in full_globs:
                full_globs.append(g)

    full_rules = compile_rule_list(full_globs)
    allowed_rules = compile_rule_list(rules.get("lightAllowed", []) or [])
    deny_rules = compile_rule_list(rules.get("lightDeny", []) or [])

    for f in files:
        m = match_first(f, full_rules)
        if m:
            return "full", "full: {} matched {}".format(f, m)

    if not files:
        return "standard", "standard: no changed files"

    for f in files:
        m = match_first(f, deny_rules)
        if m:
            return "standard", "standard: {} matched {}".format(f, m)

    for f in files:
        if match_first(f, allowed_rules) is None:
            return "standard", "standard: {} not matched by lightAllowed".format(f)

    return "light", "light: all {} changed file(s) matched lightAllowed".format(len(files))


def main():
    rules_path = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        files = json.load(sys.stdin)
    except (ValueError, TypeError):
        files = []
    if not isinstance(files, list):
        files = []
    files = [f for f in files if isinstance(f, str)]

    if not rules_path:
        print(json.dumps({"campaignSize": "standard", "sizeReason": "no sizing rules"}))
        return

    # An ABSENT file is "never configured" -- backward compatible, standard.
    # A file that IS present but unreadable or malformed must not collapse
    # into that same case: smoke-pr-gate.sh:1221-1226 treats a non-zero exit
    # here (or a stdout reply that isn't {campaignSize: str, sizeReason: str})
    # as "the classifier failed" and forces campaignSize=full, so those are
    # the two ways to signal "not configured" and "configured but broken" to
    # the caller -- exit 0 with the standard reply for the former, a non-zero
    # exit (nothing meaningful on stdout) for the latter.
    try:
        with open(rules_path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except FileNotFoundError:
        # A dangling symlink raises FileNotFoundError too, but the path IS
        # present -- os.path.lexists() answers for the link itself, not its
        # target. That is a configured-and-broken install, not one that never
        # configured sizing rules, so it takes the same non-zero exit as
        # every other present-but-unusable file rather than the backward
        # compatible "no sizing rules" reply.
        if os.path.lexists(rules_path):
            print(
                "sizing rules file {} is present but its symlink target is missing".format(
                    rules_path
                ),
                file=sys.stderr,
            )
            sys.exit(1)
        print(json.dumps({"campaignSize": "standard", "sizeReason": "no sizing rules"}))
        return
    except (OSError, UnicodeDecodeError) as exc:
        print(
            "sizing rules file {} is present but could not be read: {}".format(rules_path, exc),
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        rules = json.loads(source)
    except ValueError as exc:
        print(
            "sizing rules file {} is present but could not be parsed as JSON: {}".format(rules_path, exc),
            file=sys.stderr,
        )
        sys.exit(1)

    if not isinstance(rules, dict):
        print(
            "sizing rules file {} is present but is not a JSON object".format(rules_path),
            file=sys.stderr,
        )
        sys.exit(1)

    shape_error = validate_rules_shape(rules)
    if shape_error is not None:
        print(
            "sizing rules file {} is present but malformed: {}".format(rules_path, shape_error),
            file=sys.stderr,
        )
        sys.exit(1)

    size, reason = classify(files, rules)
    print(json.dumps({"campaignSize": size, "sizeReason": reason}))


if __name__ == "__main__":
    main()
