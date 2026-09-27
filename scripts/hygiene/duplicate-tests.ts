import ts from 'typescript';

export interface TestCase {
  file: string;
  line: number;
  name: string;
  scope: string;
  statements: string[];
  assertions: boolean[];
}

export interface DuplicateTest {
  kind: 'same-as' | 'subsumed-by';
  test: TestCase;
  keeper: TestCase;
}

export const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

const CASE_CALLEES = new Set(['it', 'test']);
const SUITE_CALLEES = new Set(['describe', 'suite']);
const NOT_RUN = new Set(['skip', 'todo', 'fails', 'skipIf', 'runIf']);
const ASSERTION = /^(?:expect|assert\w*)$/;

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

function asserts(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    let callee: ts.Expression = node.expression;
    while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) callee = callee.expression;
    if (ts.isIdentifier(callee) && ASSERTION.test(callee.text)) return true;
  }
  return ts.forEachChild(node, asserts) ?? false;
}

function innermostScope(node: ts.Node): ts.Node {
  let p = node.parent;
  while (
    !ts.isSourceFile(p) &&
    !ts.isBlock(p) &&
    !ts.isFunctionLike(p) &&
    !ts.isIterationStatement(p, false) &&
    !ts.isCaseOrDefaultClause(p)
  ) {
    p = p.parent;
  }
  return p;
}

class Normalizer {
  private locals = new Map<string, string>();

  constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly root?: ts.Node,
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
    for (let p = node.parent; p && this.root && within(p, this.root); p = p.parent) {
      if (!scopeDeclares(p).has(name)) continue;
      const key = `${name}@${p.pos}`;
      if (!this.locals.has(key)) this.locals.set(key, `$${this.locals.size}`);
      return this.locals.get(key)!;
    }
    return name;
  }

  text(node: ts.Node): string {
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

function isSuiteOrCase(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const callee = calleeOf(statement.expression);
  return !!callee && (SUITE_CALLEES.has(callee.base) || CASE_CALLEES.has(callee.base));
}

function environment(scope: ts.Node, text: (n: ts.Node) => string): string {
  const parts: ts.Node[] = [];
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isCaseOrDefaultClause(scope)) {
    parts.push(...scope.statements.filter((st) => !isSuiteOrCase(st)));
  } else if (ts.isFunctionLike(scope)) {
    parts.push(...scope.parameters);
    if (ts.isCallExpression(scope.parent)) parts.push(scope.parent.expression);
  } else if (ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
    parts.push(scope.initializer, scope.expression);
  } else if (ts.isForStatement(scope)) {
    for (const n of [scope.initializer, scope.condition, scope.incrementor]) if (n) parts.push(n);
  } else if (ts.isWhileStatement(scope) || ts.isDoStatement(scope)) {
    parts.push(scope.expression);
  }
  return `${ts.SyntaxKind[scope.kind]}(${parts.map(text).join(';')})`;
}

export function extractCases(file: string, text: string): TestCase[] {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const outer = new Normalizer(sourceFile);
  const environments = new Map<ts.Node, string>();
  const scopeOf = (node: ts.Node): string => {
    const levels: string[] = [];
    for (let s = innermostScope(node); ; s = innermostScope(s)) {
      if (!environments.has(s))
        environments.set(
          s,
          environment(s, (n) => outer.text(n)),
        );
      levels.push(environments.get(s)!);
      if (ts.isSourceFile(s)) return levels.join('\n');
    }
  };
  const cases: TestCase[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeOf(node);
      const known = callee && (SUITE_CALLEES.has(callee.base) || CASE_CALLEES.has(callee.base));
      if (known && callee.modifiers.some((m) => NOT_RUN.has(m))) return;
      const callback = callee && CASE_CALLEES.has(callee.base) ? callbackOf(node) : undefined;
      if (callee && callback?.body) {
        const normalizer = new Normalizer(sourceFile, callback);
        const body = callback.body;
        const parts: ts.Node[] = ts.isBlock(body) ? [...body.statements] : [body];
        const statements = [
          ...(callee.table ? [`each ${normalizer.text(callee.table)}`] : []),
          ...(callback.parameters.length ? [callback.parameters.map((p) => normalizer.text(p)).join(' , ')] : []),
        ];
        const assertions = statements.map(() => false);
        for (const part of parts) {
          statements.push(normalizer.text(part));
          assertions.push(asserts(part));
        }
        const title = node.arguments[0];
        cases.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          name: title && ts.isStringLiteralLike(title) ? title.text : title ? title.getText(sourceFile) : '',
          scope: `${callee.modifiers.join('.')}\n${scopeOf(node)}`,
          statements,
          assertions,
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return cases;
}

const sameStatements = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);
const isProperPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((s, i) => s === b[i]);
const at = (c: TestCase) => `${c.file}:${c.line}`;
const order = (a: TestCase, b: TestCase) => a.file.localeCompare(b.file) || a.line - b.line;

export function findDuplicateTests(newCases: TestCase[], allCases: TestCase[]): DuplicateTest[] {
  const byScope = new Map<string, TestCase[]>();
  for (const c of allCases) {
    if (!c.assertions.some(Boolean)) continue;
    const key = `${c.file}|${c.scope}`;
    byScope.set(key, [...(byScope.get(key) ?? []), c]);
  }
  const fresh = new Set(newCases.map(at));
  const found: DuplicateTest[] = [];
  for (const test of [...newCases].sort(order)) {
    if (!test.assertions.some(Boolean)) continue;
    const others = (byScope.get(`${test.file}|${test.scope}`) ?? []).filter((c) => at(c) !== at(test));
    const same = others.find(
      (c) => sameStatements(c.statements, test.statements) && (!fresh.has(at(c)) || order(c, test) < 0),
    );
    if (same) {
      found.push({ kind: 'same-as', test, keeper: same });
      continue;
    }
    const wider = others.find(
      (c) => isProperPrefix(test.statements, c.statements) && c.assertions.slice(test.statements.length).some(Boolean),
    );
    if (wider) found.push({ kind: 'subsumed-by', test, keeper: wider });
  }
  return found;
}

const shapeKey = (c: TestCase) => c.statements.join('\n');

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
