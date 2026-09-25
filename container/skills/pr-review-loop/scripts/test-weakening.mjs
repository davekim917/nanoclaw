#!/usr/bin/env node
/**
 * Test-weakening review trigger for `codex-review.sh merge-check`.
 *
 * Compares the tests a PR already had (at the merge base) with the same tests
 * at its head, syntax-aware, so formatting and moved-but-unchanged code never
 * count. It says `review` for a removed or changed assertion, a changed or
 * removed setup statement inside a case, a removed case or `.each` row, an
 * added `.skip`/`.todo`/`.fails`/`.skipIf`/`.runIf`, a changed or removed
 * fixture, helper or test-config statement, and for anything it
 * cannot analyse (an unsupported language, a parse error, a failed read). It
 * says `refuse` for any `.only` in a test file the PR touches. It is a review
 * trigger, never a verdict on whether the change is legitimate.
 *
 *   test-weakening.mjs <owner/repo> <head-sha>   comparison JSON on stdin
 *
 * The comparison is GitHub's `compare/<base>...<head>` response: its
 * `merge_base_commit.sha` is the before side and its `files` are the paths to
 * judge. Contents are read with `gh api` at those two commits. Prints
 * {verdict, summary, findings, refusals}; exits non-zero with no verdict.
 *
 * TypeScript/JavaScript tests are parsed with the `typescript` package,
 * resolved from the working directory first, then from this file; without it
 * every such file is incomplete, which is `review`.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const AST_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const OTHER_TEST = /(\.(test|spec)\.[^/.]+|(^|\/)test_[^/]+\.py|_test\.(py|go|rb|sh|exs?)|_spec\.rb)$/;
const SUPPORT_DIR =
  /(^|\/)(__fixtures__|__test-fixtures__|__mocks__|__snapshots__|__tests__|fixtures|[\w.-]+-fixtures|testing|tests?)\//;
const SUPPORT_NAME =
  /(^|\/)(test-[^/]+|testing\.[^/]+|test-?(helpers?|utils?|setup)\.[^/]+|[^/]*[._-](fixtures?|mocks?|test-?helpers?|test-?utils?)[._-][^/]*|conftest\.py|(vitest|jest|playwright)(\.[\w-]+)?\.(config|setup|workspace)\.[cm]?[jt]s|bunfig\.toml|\.mocharc[^/]*)$/;
const AST_SOURCE = /\.[cm]?[jt]sx?$/;

const GROUP_ROOTS = new Set(['describe', 'suite', 'context', 'xdescribe', 'fdescribe']);
const CASE_ROOTS = new Set(['it', 'test', 'bench', 'specify', 'xit', 'xtest', 'fit']);
const WEAKENING_MODS = ['skip', 'todo', 'fails', 'skipIf', 'runIf'];
const ASSERT_ROOTS = new Set(['expect', 'expectTypeOf', 'assert']);

export function classify(file) {
  if (AST_TEST.test(file)) return 'ast-test';
  if (OTHER_TEST.test(file)) return 'other-test';
  if (SUPPORT_DIR.test(file) || SUPPORT_NAME.test(file)) return AST_SOURCE.test(file) ? 'ast-support' : 'data-support';
  return null;
}

export function loadTypeScript() {
  for (const from of [path.join(process.cwd(), 'noop.js'), import.meta.url]) {
    try {
      return createRequire(from)('typescript');
    } catch {
      // next candidate
    }
  }
  return null;
}

const oneLine = (text, max = 120) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function scriptKind(ts, file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
  const errors = sf.parseDiagnostics ?? [];
  if (errors.length > 0) {
    const first = errors[0];
    const { line } = sf.getLineAndCharacterOfPosition(first.start ?? 0);
    const message = typeof first.messageText === 'string' ? first.messageText : first.messageText.messageText;
    throw new Error(`parse error at line ${line + 1}: ${message}`);
  }
  return sf;
}

/** A formatting-free rendering of a node: comments, whitespace, quotes and parentheses do not show. Nodes in `hidden` render as a placeholder. */
function canon(ts, node, hidden = null) {
  const K = ts.SyntaxKind;
  const out = [];
  const visit = (n) => {
    if (hidden?.has(n)) return out.push('<hidden>');
    if (ts.isParenthesizedExpression(n)) return visit(n.expression);
    switch (n.kind) {
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
        out.push(JSON.stringify(n.text));
        return;
      case K.TemplateHead:
      case K.TemplateMiddle:
      case K.TemplateTail:
        out.push(`\`${JSON.stringify(n.text)}`);
        return;
      case K.NumericLiteral:
      case K.BigIntLiteral:
      case K.RegularExpressionLiteral:
      case K.Identifier:
      case K.PrivateIdentifier:
        out.push(n.text);
        return;
      case K.JsxText:
        out.push(JSON.stringify(n.text.replace(/\s+/g, ' ').trim()));
        return;
    }
    out.push(`(${n.kind}`);
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n) || ts.isTypeOperatorNode(n))
      out.push(`op${n.operator}`);
    if (ts.isVariableDeclarationList(n)) out.push(`f${n.flags & 3}`);
    if (ts.isMetaProperty(n)) out.push(`k${n.keywordToken}`);
    if (ts.isHeritageClause(n)) out.push(`t${n.token}`);
    ts.forEachChild(n, visit, (list) => {
      out.push('[');
      list.forEach(visit);
      out.push(']');
    });
    out.push(')');
  };
  visit(node);
  return out.join(' ');
}

const isFunctionLike = (ts, n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n);

function tableRows(ts, arg) {
  if (!arg) return null;
  if (ts.isArrayLiteralExpression(arg)) return arg.elements.map((e) => ({ canon: canon(ts, e), text: e.getText() }));
  if (ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg)) {
    let text = ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : arg.head.text;
    if (ts.isTemplateExpression(arg))
      for (const span of arg.templateSpans) text += `\${${canon(ts, span.expression)}}${span.literal.text}`;
    return text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((line) => ({ canon: line, text: line }));
  }
  return null;
}

/** The test call `call` is, as {kind, root, mods, rows, title, fn}, or null. */
function testCall(ts, call) {
  let callee = call.expression;
  const mods = new Set();
  let rows = null;
  for (;;) {
    if (ts.isPropertyAccessExpression(callee)) {
      mods.add(callee.name.text);
      callee = callee.expression;
    } else if (ts.isCallExpression(callee)) {
      const inner = callee.expression;
      if (ts.isPropertyAccessExpression(inner) && (inner.name.text === 'each' || inner.name.text === 'for'))
        rows = tableRows(ts, callee.arguments[0]) ?? rows;
      callee = inner;
    } else if (ts.isTaggedTemplateExpression(callee)) {
      rows = tableRows(ts, callee.template);
      callee = callee.tag;
    } else break;
  }
  if (!ts.isIdentifier(callee)) return null;
  const root = callee.text;
  const group = GROUP_ROOTS.has(root) || (CASE_ROOTS.has(root) && mods.has('describe'));
  if (!group && !CASE_ROOTS.has(root)) return null;
  if (root.startsWith('x')) mods.add('skip');
  if (root.startsWith('f')) mods.add('only');
  const fn = [...call.arguments].reverse().find((a) => isFunctionLike(ts, a)) ?? null;
  const titleNode = call.arguments[0];
  if (!titleNode || (!fn && !mods.has('todo'))) return null;
  const title =
    ts.isStringLiteral(titleNode) || ts.isNoSubstitutionTemplateLiteral(titleNode)
      ? titleNode.text
      : oneLine(titleNode.getText(), 80);
  return { kind: group ? 'group' : 'case', mods, rows, title, fn };
}

function chainRoot(ts, node) {
  let n = node;
  while (ts.isPropertyAccessExpression(n) || ts.isCallExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
  return ts.isIdentifier(n) ? n.text : null;
}

/** The outermost expect/assert chain of every assertion in `body`, each up to its last call. */
function assertionNodes(ts, body) {
  const tops = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n) && ASSERT_ROOTS.has(chainRoot(ts, n.expression) ?? '')) {
      let top = n;
      for (;;) {
        const p = top.parent;
        if (
          (ts.isPropertyAccessExpression(p) || ts.isCallExpression(p) || ts.isNonNullExpression(p)) &&
          p.expression === top
        )
          top = p;
        else break;
      }
      tops.add(top);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  const nested = (top) => {
    for (let p = top.parent; p && p !== body; p = p.parent) if (tops.has(p)) return true;
    return false;
  };
  return new Set([...tops].filter((top) => !nested(top)));
}

/** A case's assertions, and the rest of its body statement by statement with each assertion as a placeholder. */
function caseBody(ts, fn) {
  const tops = assertionNodes(ts, fn);
  const asserts = [...tops].map((top) => ({ canon: canon(ts, top), text: oneLine(top.getText()) }));
  const statements = ts.isBlock(fn.body) ? fn.body.statements : [fn.body];
  const setup = [];
  for (const st of statements) {
    let e = ts.isExpressionStatement(st) ? st.expression : st;
    if (ts.isAwaitExpression(e)) e = e.expression;
    if (tops.has(e)) continue;
    setup.push({ canon: canon(ts, st, tops), text: oneLine(st.getText()) });
  }
  return { asserts, setup };
}

/** The outermost test calls under `node`. */
function testCalls(ts, node) {
  const found = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n) && testCall(ts, n)) found.add(n);
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function statementName(ts, st) {
  if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) return st.name.text;
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.map((d) => d.name.getText()).join(', ');
  if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
    const call = st.expression;
    const first = call.arguments[0];
    const callee = oneLine(call.expression.getText(), 40);
    return first && ts.isStringLiteral(first) ? `${callee}('${first.text}')` : callee;
  }
  return oneLine(st.getText(), 60);
}

/** The module `init` loads by `await import('…')` or `require('…')`, or null. */
function loadedModule(ts, init) {
  if (init && ts.isAwaitExpression(init)) init = init.expression;
  if (!init || !ts.isCallExpression(init)) return null;
  const loader =
    init.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(init.expression) && init.expression.text === 'require');
  if (!loader) return null;
  const arg = init.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : arg ? canon(ts, arg) : '';
}

function isModuleLoad(ts, st) {
  return (
    ts.isVariableStatement(st) && st.declarationList.declarations.every((d) => loadedModule(ts, d.initializer) !== null)
  );
}

/** Records what each local name of an import or module load is bound to, and each side-effect-only import. */
function recordImports(ts, st, imports) {
  const bind = (name, target) => imports.bindings.set(name, target);
  if (ts.isImportDeclaration(st)) {
    const from = st.moduleSpecifier.text;
    const clause = st.importClause;
    if (!clause) return imports.effects.push({ canon: from, text: from });
    if (clause.isTypeOnly) return;
    if (clause.name) bind(clause.name.text, `${from}#default`);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bind(named.name.text, `${from}#*`);
    if (named && ts.isNamedImports(named))
      for (const e of named.elements)
        if (!e.isTypeOnly) bind(e.name.text, `${from}#${(e.propertyName ?? e.name).text}`);
    return;
  }
  if (ts.isImportEqualsDeclaration(st)) {
    const ref = st.moduleReference;
    const from = ts.isExternalModuleReference(ref) ? canon(ts, ref.expression) : canon(ts, ref);
    return bind(st.name.text, `${from}#*`);
  }
  for (const d of st.declarationList.declarations) {
    const from = loadedModule(ts, d.initializer);
    if (ts.isIdentifier(d.name)) bind(d.name.text, `${from}#*`);
    else if (ts.isObjectBindingPattern(d.name))
      for (const e of d.name.elements)
        if (ts.isIdentifier(e.name))
          bind(e.name.text, `${from}#${e.propertyName ? canon(ts, e.propertyName) : e.name.text}`);
  }
}

/**
 * Non-test statements of one scope: helpers, fixtures, hooks, mocks, and any
 * wrapper around a test (an `if`, a loop), with the tests inside it as
 * placeholders. Imports and module loads go to `imports`; types are left out.
 */
function supportStatements(ts, statements, file, scope, imports) {
  const out = [];
  for (const st of statements) {
    if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st) || isModuleLoad(ts, st)) {
      recordImports(ts, st, imports);
      continue;
    }
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause) continue;
    const tests = testCalls(ts, st);
    if (ts.isExpressionStatement(st) && tests.has(st.expression)) continue;
    const movable = ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isVariableStatement(st);
    out.push({
      file,
      scope,
      movable,
      name: statementName(ts, st),
      canon: canon(ts, st, tests),
      text: oneLine(st.getText()),
    });
  }
  return out;
}

/** A file's import record, with every name it uses outside its imports. */
function newImports(ts, sf) {
  const used = new Set();
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) return;
    if (ts.isIdentifier(n)) used.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { bindings: new Map(), effects: [], used };
}

/** The units (cases and groups) and support statements of one parsed test file. */
function testFile(ts, file, sf) {
  const units = [];
  const imports = newImports(ts, sf);
  const support = supportStatements(ts, sf.statements, file, '', imports);
  const seen = new Map();
  const visit = (n, scope, inherited) => {
    if (ts.isCallExpression(n)) {
      const t = testCall(ts, n);
      if (t) {
        const trail = [...scope, t.title];
        const base = trail.join(' › ');
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        const unit = {
          file,
          kind: t.kind,
          key: count > 1 ? `${base} #${count}` : base,
          title: t.title,
          mods: t.mods,
          effective: new Set([...inherited, ...t.mods]),
          rows: t.rows,
          full: canon(ts, n),
          body: t.fn ? canon(ts, t.fn) : null,
          ...(t.kind === 'case' && t.fn ? caseBody(ts, t.fn) : { asserts: [], setup: [] }),
        };
        units.push(unit);
        if (t.fn) {
          if (t.kind === 'group' && ts.isBlock(t.fn.body))
            support.push(...supportStatements(ts, t.fn.body.statements, file, base, imports));
          ts.forEachChild(t.fn, (c) => visit(c, t.kind === 'group' ? trail : scope, unit.effective));
        }
        return;
      }
    }
    ts.forEachChild(n, (c) => visit(c, scope, inherited));
  };
  visit(sf, [], new Set());
  return { units, support, imports };
}

/** `before` items with no equal in `after`, and `after` items left over, matched one to one. */
function match(before, after) {
  const left = new Map();
  for (const x of after) left.set(x.canon, [...(left.get(x.canon) ?? []), x]);
  const gone = [];
  for (const x of before) {
    const same = left.get(x.canon);
    if (same?.length) same.pop();
    else gone.push(x);
  }
  return { gone, extra: [...left.values()].flat() };
}

const missing = (before, after) => match(before, after).gone;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function compareCases(baseUnits, headUnits, headPathOf, findings) {
  const byKey = new Map(headUnits.map((u) => [`${u.file}\0${u.kind}\0${u.key}`, u]));
  const used = new Set();
  const take = (pred) => {
    const hit = headUnits.find((u) => !used.has(u) && pred(u));
    return hit ?? null;
  };
  for (const b of baseUnits) {
    const headPath = headPathOf(b.file);
    let h = headPath ? byKey.get(`${headPath}\0${b.kind}\0${b.key}`) : null;
    if (h && used.has(h)) h = null;
    h ??= take((u) => u.kind === b.kind && u.full === b.full);
    if (b.kind === 'case') {
      h ??= b.body ? take((u) => u.kind === 'case' && u.body === b.body) : null;
      h ??= take((u) => u.kind === 'case' && u.key === b.key);
    }
    if (h) used.add(h);
    const where = { file: b.file, case: b.key };
    if (!h) {
      if (b.kind === 'case' && !b.mods.has('todo'))
        findings.push({
          ...where,
          kind: 'case-removed',
          change: headPath
            ? 'no case keeps this title or body (removed, or renamed and changed)'
            : 'case removed with its file',
        });
      if (b.kind === 'group' && b.rows?.length)
        findings.push({ ...where, kind: 'row-removed', change: `table of ${plural(b.rows.length, 'row')} removed` });
      continue;
    }
    if (b.kind === 'case') {
      const added = WEAKENING_MODS.filter((m) => h.effective.has(m) && !b.effective.has(m));
      if (added.length)
        findings.push({ ...where, kind: 'modifier-added', change: `now ${added.map((m) => `.${m}`).join(', ')}` });
      const gone = missing(b.asserts, h.asserts);
      if (gone.length)
        findings.push({
          ...where,
          kind: 'assertion-changed',
          change: `${plural(gone.length, 'assertion')} removed or changed, e.g. ${gone[0].text}`,
        });
      const changed = missing(b.setup, h.setup);
      if (changed.length)
        findings.push({
          ...where,
          kind: 'setup-changed',
          change: `${plural(changed.length, 'setup statement')} changed or removed, e.g. ${changed[0].text}`,
        });
    }
    if (b.rows) {
      const gone = h.rows ? missing(b.rows, h.rows) : b.rows;
      if (gone.length)
        findings.push({
          ...where,
          kind: 'row-removed',
          change: h.rows
            ? `${plural(gone.length, '.each row')} removed or changed, e.g. ${oneLine(gone[0].text, 80)}`
            : '.each table is no longer inline, so its rows cannot be compared',
        });
    }
  }
}

function compareSupport(baseSupport, headSupport, headPathOf, findings) {
  const scoped = (list) => {
    const m = new Map();
    for (const s of list) {
      const k = `${s.file}\0${s.scope}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return m;
  };
  const headScoped = scoped(headSupport);
  const paired = new Set();
  const gone = [];
  const elsewhere = [];
  for (const [k, list] of scoped(baseSupport)) {
    const [file, scope] = k.split('\0');
    const headPath = headPathOf(file);
    const headKey = headPath ? `${headPath}\0${scope}` : null;
    if (headKey) paired.add(headKey);
    const m = match(list, (headKey && headScoped.get(headKey)) || []);
    gone.push(...m.gone.map((s) => ({ s, file, scope, headPath })));
    elsewhere.push(...m.extra);
  }
  for (const [k, list] of headScoped) if (!paired.has(k)) elsewhere.push(...list);
  const unmoved = new Set(
    missing(
      gone.map((g) => g.s).filter((s) => s.movable),
      elsewhere,
    ),
  );
  for (const g of gone) if (!g.s.movable) unmoved.add(g.s);
  for (const { s, file, scope, headPath } of gone) {
    if (!unmoved.has(s)) continue;
    findings.push({
      file,
      case: scope ? `${scope} › ${s.name}` : s.name,
      kind: 'support-changed',
      change: headPath ? 'fixture/helper statement changed or removed' : 'file removed',
    });
  }
}

/** An import whose local name now binds something else or nothing while still in use, or a side-effect import that is gone. */
function compareImports(baseImports, headImports, headPathOf, findings) {
  for (const [file, before] of baseImports) {
    const after = headImports.get(headPathOf(file));
    if (!after) continue;
    for (const [name, target] of before.bindings) {
      const now = after.bindings.get(name);
      const was = target.replace('#', ' › ');
      if (now !== undefined && now !== target)
        findings.push({
          file,
          case: `import ${name}`,
          kind: 'support-changed',
          change: `now ${now.replace('#', ' › ')}, was ${was}`,
        });
      else if (now === undefined && after.used.has(name))
        findings.push({
          file,
          case: `import ${name}`,
          kind: 'support-changed',
          change: `no longer imported from ${was} but still used`,
        });
    }
    for (const effect of missing(before.effects, after.effects))
      findings.push({
        file,
        case: `import '${effect.text}'`,
        kind: 'support-changed',
        change: 'side-effect import removed',
      });
  }
}

function lineMultiset(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ canon: l, text: l }));
}

/**
 * The verdict for one comparison. `files` are GitHub comparison entries
 * ({filename, previous_filename?, status}); `read(side, path)` returns the
 * file's text at 'base' or 'head', null when it does not exist there, and
 * throws when it cannot tell.
 */
export async function analyze({ files, read, ts }) {
  const findings = [];
  const refusals = [];
  const renames = new Map();
  const jobs = [];
  for (const f of files) {
    const before = f.status === 'added' || f.status === 'copied' ? null : (f.previous_filename ?? f.filename);
    const after = f.status === 'removed' ? null : f.filename;
    if (before) renames.set(before, after);
    const beforeClass = before ? classify(before) : null;
    const afterClass = after ? classify(after) : null;
    if (beforeClass === 'other-test') {
      if (!(f.status === 'renamed' && f.changes === 0))
        findings.push({
          file: before,
          case: '(whole file)',
          kind: 'unknown',
          change: 'not analysed (unsupported language): review required',
        });
      continue;
    }
    if (beforeClass || afterClass === 'ast-test' || afterClass === 'ast-support')
      jobs.push({ before: beforeClass ? before : null, after, beforeClass, afterClass });
  }
  const headPathOf = (file) => renames.get(file) ?? null;
  const incomplete = (file, reason) =>
    findings.push({
      file,
      case: '(whole file)',
      kind: 'incomplete',
      change: `not analysed (${reason}): review required`,
    });

  const texts = new Map();
  await mapLimit(jobs, 8, async (job) => {
    for (const [side, file] of [
      ['base', job.before],
      ['head', job.after],
    ]) {
      if (!file) continue;
      try {
        texts.set(`${side}\0${file}`, await read(side, file));
      } catch (err) {
        texts.set(`${side}\0${file}`, err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
  const text = (side, file) => (file ? texts.get(`${side}\0${file}`) : null);

  const base = { units: [], support: [], imports: new Map() };
  const head = { units: [], support: [], imports: new Map() };
  const read2 = (side, file) => {
    const t = text(side, file);
    if (t instanceof Error) throw t;
    return t ?? null;
  };
  const extract = (file, cls, t) => {
    if (!ts) throw new Error('the typescript package is not installed where this runs');
    const sf = parse(ts, file, t);
    if (cls === 'ast-test') return testFile(ts, file, sf);
    const imports = newImports(ts, sf);
    return { units: [], support: supportStatements(ts, sf.statements, file, '', imports), imports };
  };

  for (const job of jobs) {
    const file = job.before ?? job.after;
    try {
      const b = job.before ? read2('base', job.before) : null;
      const h = job.after ? read2('head', job.after) : null;
      if (job.before && b === null) throw new Error('missing at the merge base');
      if (job.beforeClass === 'data-support') {
        if (h === null) {
          findings.push({ file, case: '(whole file)', kind: 'support-changed', change: 'fixture/config file removed' });
          continue;
        }
        const gone = missing(lineMultiset(b), lineMultiset(h));
        if (gone.length)
          findings.push({
            file,
            case: '(whole file)',
            kind: 'support-changed',
            change: `${plural(gone.length, 'line')} changed or removed, e.g. ${oneLine(gone[0].text, 80)}`,
          });
        continue;
      }
      const headClass = job.afterClass === 'ast-test' || job.afterClass === 'ast-support' ? job.afterClass : null;
      if (job.after && headClass && h === null) throw new Error('missing at the head');
      const before = job.before ? extract(job.before, job.beforeClass, b) : null;
      const after = job.after && headClass ? extract(job.after, headClass, h) : null;
      for (const [into, got, at] of [
        [base, before, job.before],
        [head, after, job.after],
      ])
        if (got) {
          into.units.push(...got.units);
          into.support.push(...got.support);
          into.imports.set(at, got.imports);
        }
    } catch (err) {
      incomplete(file, err.message);
    }
  }

  for (const u of head.units)
    if (u.mods.has('only'))
      refusals.push({
        file: u.file,
        case: u.key,
        kind: 'only',
        change: '.only runs this case alone and skips the rest',
      });
  compareCases(base.units, head.units, headPathOf, findings);
  compareSupport(base.support, head.support, headPathOf, findings);
  compareImports(base.imports, head.imports, headPathOf, findings);

  const verdict = refusals.length ? 'refuse' : findings.length ? 'review' : 'clean';
  return { verdict, summary: summarize(refusals.length ? refusals : findings), findings, refusals };
}

export function summarize(list, max = 5) {
  const shown = list.slice(0, max).map((f) => `${f.file} › ${f.case}: ${f.change}`);
  if (list.length > max) shown.push(`and ${list.length - max} more`);
  return shown.join('; ');
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function ghContents(repo, sha, file) {
  const route = `repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`;
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', '-H', 'Accept: application/vnd.github.raw+json', route], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      const body = Buffer.concat(out).toString('utf8');
      if (code === 0) return resolve(body);
      try {
        const err = JSON.parse(body);
        if (err.status === '404' && err.message === 'Not Found') return resolve(null);
      } catch {
        // not an error body
      }
      reject(new Error(`could not read ${file} at ${sha}`));
    });
  });
}

async function main(argv) {
  const [repo, headSha] = argv;
  if (!repo || !/^[0-9a-f]{40}$/.test(headSha ?? ''))
    throw new Error('usage: test-weakening.mjs <owner/repo> <head-sha>');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const comparison = JSON.parse(input);
  const baseSha = comparison?.merge_base_commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(baseSha ?? '')) throw new Error('the comparison names no merge base');
  if (!Array.isArray(comparison.files)) throw new Error('the comparison lists no files');
  const result = await analyze({
    files: comparison.files,
    ts: loadTypeScript(),
    read: (side, file) => ghContents(repo, side === 'base' ? baseSha : headSha, file),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`test-weakening: ${err.message}\n`);
    process.exit(1);
  });
}
