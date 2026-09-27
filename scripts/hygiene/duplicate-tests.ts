import path from 'node:path';

import ts from 'typescript';

export interface TestCase {
  file: string;
  line: number;
  name: string;
  context: string;
  statements: string[];
  asserts: boolean;
}

export interface DuplicateTest {
  kind: 'same-as' | 'subsumed-by';
  test: TestCase;
  keeper: TestCase;
}

export const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

const CASE_CALLEES = new Set(['it', 'test']);
const SUITE_CALLEES = new Set(['describe', 'suite']);
const HOOKS = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll']);
const NOT_RUN = new Set(['skip', 'todo', 'fails', 'skipIf', 'runIf']);
const ASSERTION = /(?:^|[^\w$])(?:expect|assert\w*)(?:[^\w$]|$)/;

interface Callee {
  base: string;
  modifiers: string[];
  table?: ts.Node;
}

function calleeOf(call: ts.CallExpression): Callee | null {
  const modifiers: string[] = [];
  let expr: ts.Expression = call.expression;
  let table: ts.Node | undefined;
  if (ts.isCallExpression(expr)) {
    table = expr.arguments[0];
    expr = expr.expression;
  } else if (ts.isTaggedTemplateExpression(expr)) {
    table = expr.template;
    expr = expr.tag;
  }
  while (ts.isPropertyAccessExpression(expr)) {
    modifiers.unshift(expr.name.text);
    expr = expr.expression;
  }
  if (!ts.isIdentifier(expr)) return null;
  if (table && !modifiers.some((m) => m === 'each' || m === 'for' || m === 'skipIf' || m === 'runIf')) return null;
  return { base: expr.text, modifiers, table };
}

function callbackOf(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
  return call.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
}

function bindingNames(name: ts.BindingName, into: Set<string>): Set<string> {
  if (ts.isIdentifier(name)) into.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, into);
  return into;
}

function moduleId(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return path.posix.join(path.posix.dirname(file), specifier).replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ts.isLabeledStatement(parent)
  );
}

const declarationCache = new WeakMap<ts.Node, Set<string>>();

function scopeDeclares(node: ts.Node): Set<string> {
  const cached = declarationCache.get(node);
  if (cached) return cached;
  const names = new Set<string>();
  const bindAll = (list: ts.VariableDeclarationList) => {
    for (const d of list.declarations) bindingNames(d.name, names);
  };
  if ((ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) && node.initializer) {
    if (ts.isVariableDeclarationList(node.initializer)) bindAll(node.initializer);
  } else if (ts.isFunctionLike(node)) {
    for (const param of node.parameters) bindingNames(param.name, names);
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) names.add(node.name.text);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    bindingNames(node.variableDeclaration.name, names);
  } else if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    for (const st of node.statements) {
      if (ts.isVariableStatement(st)) bindAll(st.declarationList);
      else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
        names.add(st.name.text);
      }
    }
  }
  declarationCache.set(node, names);
  return names;
}

function within(node: ts.Node, root: ts.Node): boolean {
  for (let p: ts.Node | undefined = node; p; p = p.parent) if (p === root) return true;
  return false;
}

class Normalizer {
  private locals = new Map<string, string>();
  private root: ts.Node | undefined;

  constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly imports: Map<string, string>,
    private readonly scopes: { id: string; names: Set<string> }[],
    private readonly stop: ts.Node,
  ) {}

  private identifier(node: ts.Identifier): string {
    const name = node.text;
    if (isPropertyName(node)) return name;
    const parent = node.parent;
    if (ts.isShorthandPropertyAssignment(parent) || (ts.isBindingElement(parent) && !parent.propertyName)) {
      return `${name}:${this.resolve(node)}`;
    }
    return this.resolve(node);
  }

  private resolve(node: ts.Identifier): string {
    const name = node.text;
    for (let p = node.parent; p && p !== this.stop; p = p.parent) {
      if (!scopeDeclares(p).has(name)) continue;
      if (this.root && within(p, this.root)) {
        const key = `${name}@${p.pos}`;
        if (!this.locals.has(key)) this.locals.set(key, `$${this.locals.size}`);
        return this.locals.get(key)!;
      }
      if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.expression) {
        return `${new Normalizer(this.sourceFile, this.imports, this.scopes, this.stop).text(p.expression)}::${name}`;
      }
      const named = (p as { name?: ts.Node }).name;
      return `${ts.SyntaxKind[p.kind]}${named && ts.isIdentifier(named) ? `:${named.text}` : ''}::${name}`;
    }
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].names.has(name)) return `${this.scopes[i].id}::${name}`;
    }
    return this.imports.get(name) ?? name;
  }

  text(node: ts.Node, localRoot: ts.Node = node): string {
    this.root = localRoot;
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) out.push(this.identifier(n));
      else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(JSON.stringify(n.text));
      else if (n.kind === ts.SyntaxKind.SemicolonToken) return;
      else if (n.getChildCount(this.sourceFile) === 0) out.push(n.getText(this.sourceFile));
      else for (const child of n.getChildren(this.sourceFile)) visit(child);
    };
    visit(node);
    return out.join(' ');
  }
}

export function extractCases(file: string, text: string): TestCase[] {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const imports = new Map<string, string>();
  const fileNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const id = moduleId(file, statement.moduleSpecifier.text);
      const clause = statement.importClause;
      if (clause?.name) imports.set(clause.name.text, `${id}#default`);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, `${id}#*`);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) imports.set(el.name.text, `${id}#${(el.propertyName ?? el.name).text}`);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) bindingNames(decl.name, fileNames);
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      fileNames.add(statement.name.text);
    }
  }

  const cases: TestCase[] = [];
  const scopes = [{ id: '', names: fileNames }];
  let suites = 0;
  const contexts: string[] = [];

  const normalize = (node: ts.Node, stop: ts.Node) => new Normalizer(sourceFile, imports, scopes, stop).text(node);

  const isSuiteOrCase = (statement: ts.Statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const callee = calleeOf(statement.expression);
    return !!callee && (SUITE_CALLEES.has(callee.base) || CASE_CALLEES.has(callee.base));
  };

  const blockContext = (statements: ts.NodeArray<ts.Statement>, fileLevel: boolean, stop: ts.Node) =>
    statements
      .filter((s) => {
        if (!ts.isExpressionStatement(s) || isSuiteOrCase(s)) return false;
        if (fileLevel) return true;
        const call = s.expression;
        return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && HOOKS.has(call.expression.text);
      })
      .map((s) => normalize(s, stop))
      .join('\n');

  const visitBlock = (statements: ts.NodeArray<ts.Statement>, fileLevel: boolean, stop: ts.Node) => {
    contexts.push(blockContext(statements, fileLevel, stop));
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = calleeOf(node);
        const callback = callee && callbackOf(node);
        const known = callee && (SUITE_CALLEES.has(callee.base) || CASE_CALLEES.has(callee.base));
        if (known && callee.modifiers.some((m) => NOT_RUN.has(m))) return;
        if (callee && callback) {
          if (SUITE_CALLEES.has(callee.base) && callback.body && ts.isBlock(callback.body)) {
            const names = new Set<string>();
            for (const s of callback.body.statements) {
              if (ts.isVariableStatement(s))
                for (const d of s.declarationList.declarations) bindingNames(d.name, names);
              else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) names.add(s.name.text);
            }
            for (const p of callback.parameters) bindingNames(p.name, names);
            scopes.push({ id: `@s${++suites}`, names });
            visitBlock(callback.body.statements, false, callback.body);
            scopes.pop();
            return;
          }
          if (CASE_CALLEES.has(callee.base) && callback.body) {
            const normalizer = new Normalizer(sourceFile, imports, scopes, stop);
            const body = callback.body;
            const statements = [
              ...(callee.table ? [`each ${normalize(callee.table, stop)}`] : []),
              ...(callback.parameters.length
                ? [callback.parameters.map((p) => normalizer.text(p, callback)).join(' , ')]
                : []),
              ...(ts.isBlock(body)
                ? body.statements.map((s) => normalizer.text(s, callback))
                : [normalizer.text(body, callback)]),
            ];
            const title = node.arguments[0];
            cases.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              name: title && ts.isStringLiteralLike(title) ? title.text : title ? title.getText(sourceFile) : '',
              context: contexts.join('\n--\n'),
              statements,
              asserts: statements.some((s) => ASSERTION.test(s)),
            });
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of statements) visit(statement);
    contexts.pop();
  };

  visitBlock(sourceFile.statements, true, sourceFile);
  return cases;
}

const sameStatements = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);
const isProperPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((s, i) => s === b[i]);
const at = (c: TestCase) => `${c.file}:${c.line}`;
const order = (a: TestCase, b: TestCase) => a.file.localeCompare(b.file) || a.line - b.line;

export function findDuplicateTests(newCases: TestCase[], allCases: TestCase[]): DuplicateTest[] {
  const byContext = new Map<string, TestCase[]>();
  for (const c of allCases) {
    if (!c.asserts) continue;
    const group = byContext.get(c.context) ?? [];
    group.push(c);
    byContext.set(c.context, group);
  }
  const fresh = new Set(newCases.map(at));
  const found: DuplicateTest[] = [];
  for (const test of [...newCases].sort(order)) {
    if (!test.asserts) continue;
    const others = (byContext.get(test.context) ?? []).filter((c) => c.file === test.file && at(c) !== at(test));
    const same = others.find(
      (c) => sameStatements(c.statements, test.statements) && (!fresh.has(at(c)) || order(c, test) < 0),
    );
    if (same) {
      found.push({ kind: 'same-as', test, keeper: same });
      continue;
    }
    const wider = others.find(
      (c) =>
        isProperPrefix(test.statements, c.statements) &&
        c.statements.slice(test.statements.length).some((s) => ASSERTION.test(s)),
    );
    if (wider) found.push({ kind: 'subsumed-by', test, keeper: wider });
  }
  return found;
}

const SUITE_SCOPE = /@s\d+::/g;
const shapeKey = (c: TestCase) => `${c.context}\n==\n${c.statements.join('\n')}`.replace(SUITE_SCOPE, '@s::');

export function addedCases(base: TestCase[], head: TestCase[]): TestCase[] {
  const named = new Map<string, number>();
  const shaped = new Map<string, number>();
  const take = (counts: Map<string, number>, key: string) => {
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    return left > 0;
  };
  for (const c of base) {
    named.set(`${c.name}\n${shapeKey(c)}`, (named.get(`${c.name}\n${shapeKey(c)}`) ?? 0) + 1);
    shaped.set(shapeKey(c), (shaped.get(shapeKey(c)) ?? 0) + 1);
  }
  const kept = new Set<TestCase>();
  for (const c of head) if (take(named, `${c.name}\n${shapeKey(c)}`) && take(shaped, shapeKey(c))) kept.add(c);
  return [...head].sort(order).filter((c) => !kept.has(c) && !take(shaped, shapeKey(c)));
}
