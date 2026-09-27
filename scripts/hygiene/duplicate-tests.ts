import ts from 'typescript';

export interface TestCase {
  file: string;
  line: number;
  name: string;
  suite: string;
  scope: string;
  judged: boolean;
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
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'onTestFinished', 'onTestFailed']);
const READS_TEST_NAME = /\b(?:currentTestName|getState)\b/;
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
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
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
    const hoisted = (n: ts.Node): void => {
      if (ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.BlockScoped)) bindAll(n);
      if (!ts.isFunctionLike(n)) ts.forEachChild(n, hoisted);
    };
    const fnBody = (node as { body?: ts.Node }).body;
    if (fnBody) ts.forEachChild(fnBody, hoisted);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    bindingNames(node.variableDeclaration.name, names);
  } else if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    for (const st of node.statements) {
      if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.BlockScoped)
        bindAll(st.declarationList);
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

function plainSuite(fn: ts.Node): ts.CallExpression | undefined {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || call.arguments.length !== 2 || call.arguments[1] !== fn) return undefined;
  const callee = calleeOf(call);
  return callee && SUITE_CALLEES.has(callee.base) && callee.modifiers.length === 0 ? call : undefined;
}

function suiteLevels(call: ts.CallExpression): ts.Node[] | undefined {
  const levels: ts.Node[] = [];
  for (let node: ts.Node = call; ; ) {
    const container = ts.isExpressionStatement(node.parent) ? node.parent.parent : node.parent;
    if (ts.isSourceFile(container)) return [...levels, container];
    const fn = ts.isBlock(container) ? container.parent : container;
    const suite = ts.isFunctionLike(fn) ? plainSuite(fn) : undefined;
    if (!suite) return undefined;
    levels.push(container);
    node = suite;
  }
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
      if (!this.locals.has(key)) this.locals.set(key, `%${this.locals.size}`);
      return this.locals.get(key)!;
    }
    return name;
  }

  text(node: ts.Node): string {
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) out.push(this.identifier(n));
      else if (ts.isStringLiteral(n)) out.push(JSON.stringify(n.text));
      else if (n.kind === ts.SyntaxKind.SemicolonToken && !ts.isForStatement(n.parent)) return;
      else if (n.getChildCount(this.sourceFile) === 0) out.push(n.getText(this.sourceFile));
      else for (const child of n.getChildren(this.sourceFile)) visit(child);
      if (inStatementList(n)) out.push(';');
    };
    visit(node);
    return out.join(' ');
  }
}

function statementList(node: ts.Node): ts.NodeArray<ts.Statement> | undefined {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseOrDefaultClause(node) || ts.isModuleBlock(node)
    ? node.statements
    : undefined;
}

function inStatementList(node: ts.Node): boolean {
  return !!node.parent && !!statementList(node.parent)?.includes(node as ts.Statement);
}

const passesContext = new WeakMap<ts.Node, boolean>();

function underContextHook(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    const list = statementList(p);
    if (!list) continue;
    if (!passesContext.has(p)) {
      passesContext.set(
        p,
        list.some(
          (st) =>
            ts.isExpressionStatement(st) &&
            ts.isCallExpression(st.expression) &&
            !isSuiteOrCase(st) &&
            st.expression.arguments.some((arg) => ts.isFunctionLike(arg) && arg.parameters.length > 0),
        ),
      );
    }
    if (passesContext.get(p)) return true;
  }
  return false;
}

function isSuiteOrCase(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const callee = calleeOf(statement.expression);
  return !!callee && (SUITE_CALLEES.has(callee.base) || CASE_CALLEES.has(callee.base));
}

function hooksOpaque(sourceFile: ts.SourceFile): boolean {
  const opaque = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOKS.has(node.expression.text)) {
      const callback = node.arguments[0];
      const statement = node.parent;
      const list = ts.isExpressionStatement(statement) ? statement.parent : undefined;
      const owner = list && ts.isBlock(list) ? list.parent : list;
      if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return true;
      if (!owner || !(ts.isSourceFile(owner) || (ts.isFunctionLike(owner) && plainSuite(owner)))) return true;
    }
    return ts.forEachChild(node, opaque) ?? false;
  };
  return READS_TEST_NAME.test(sourceFile.text) || opaque(sourceFile);
}

export function extractCases(file: string, text: string): TestCase[] {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const fileJudged = !hooksOpaque(sourceFile);
  const outer = new Normalizer(sourceFile);
  const setup = (level: ts.Node) =>
    (ts.isBlock(level) || ts.isSourceFile(level) ? [...level.statements] : [])
      .filter((st) => !isSuiteOrCase(st))
      .map((st) => outer.text(st))
      .join('\n');
  const scopeOf = (node: ts.CallExpression): string => {
    const levels = suiteLevels(node);
    if (levels) return levels.map(setup).join('\n--\n');
    const container = ts.isExpressionStatement(node.parent) ? node.parent.parent : node.parent;
    const shared = ts.isBlock(container) || ts.isSourceFile(container) || ts.isCaseOrDefaultClause(container);
    return `@${shared ? container.pos : node.pos}`;
  };
  const suiteOf = (node: ts.Node): string => {
    const titles: string[] = [];
    for (let p = node.parent; p; p = p.parent) {
      if (!ts.isCallExpression(p)) continue;
      const callee = calleeOf(p);
      const title = p.arguments[0];
      if (callee && SUITE_CALLEES.has(callee.base)) titles.unshift(title ? title.getText(sourceFile) : '');
    }
    return titles.join(' > ');
  };
  const cases: TestCase[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeOf(node);
      const known = callee && (SUITE_CALLEES.has(callee.base) || CASE_CALLEES.has(callee.base));
      if (known && callee.modifiers.some((m) => NOT_RUN.has(m))) return;
      const callback = callee && CASE_CALLEES.has(callee.base) ? callbackOf(node) : undefined;
      if (callee && callback?.body) {
        const options = node.arguments.slice(1).filter((arg) => arg !== callback && !ts.isNumericLiteral(arg));
        const takesContext = callee.table
          ? callee.modifiers.includes('for') && callback.parameters.length > 1
          : callback.parameters.length > 0;
        const judged = fileJudged && !options.length && !takesContext && !underContextHook(node);
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
          suite: suiteOf(node),
          scope: `${[callee.base, ...callee.modifiers].join('.')}\n${scopeOf(node)}`,
          statements,
          assertions,
          judged,
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
    if (!c.judged || !c.assertions.some(Boolean)) continue;
    const key = `${c.file}|${c.scope}`;
    byScope.set(key, [...(byScope.get(key) ?? []), c]);
  }
  const fresh = new Set(newCases.map(at));
  const found: DuplicateTest[] = [];
  for (const test of [...newCases].sort(order)) {
    if (!test.judged || !test.assertions.some(Boolean)) continue;
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
  const count = (keys: string[]) => {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const take = (counts: Map<string, number>, key: string) => {
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    return left > 0;
  };
  const titleKey = (c: TestCase) => `${c.suite}\n${c.name}`;
  const headTitles = count(head.map(titleKey));
  const unmatched = base.filter((c) => !take(headTitles, titleKey(c)));
  const titled = count(base.map(titleKey));
  const shaped = count(unmatched.map(shapeKey));
  return [...head].sort(order).filter((c) => !take(titled, titleKey(c)) && !take(shaped, shapeKey(c)));
}
