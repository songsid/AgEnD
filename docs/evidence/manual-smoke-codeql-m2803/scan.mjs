#!/usr/bin/env node
/**
 * M-2803 bounded, read-only audit. Run from this checkout:
 *   node docs/evidence/manual-smoke-codeql-m2803/scan.mjs > .artifacts/manual-evaluate-scan.json
 * Reads only rg-selected scripts/manual files and writes JSON only to stdout.
 * This is a targeted syntax inventory, not a CodeQL replacement or exploit test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(process.argv[2] ?? process.cwd());
const glob = '*.{mts,ts,js,mjs,cts,cjs}';
const pattern = '\\.(evaluate|evaluateHandle|addInitScript)\\s*\\(';
const rg = (...args) => execFileSync('rg', args, { cwd: root, encoding: 'utf8' }).trimEnd();
const selected = rg('-l', '--glob', glob, pattern, 'scripts/manual').split('\n').filter(Boolean).sort();
const matchedLines = rg('-n', '--glob', glob, pattern, 'scripts/manual').split('\n').filter(Boolean);
const originalAlertFiles = new Set([
  'scripts/manual/smoke/smoke-2556-memory-header.mts',
  'scripts/manual/smoke/smoke-settings-quota-card-main.mts',
  'scripts/manual/smoke/smoke-web-update-2738.mts',
]);
const methods = new Set(['evaluate', 'evaluateHandle', 'addInitScript']);
const direct = [], unresolved = [], nestedEval = [], forwardingWrappers = [];
const counts = { totalCalls: 0, constantStringCalls: 0, functionCalls: 0, objectCalls: 0, unresolvedCalls: 0 };

for (const file of selected) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const definitions = new Map();
  const line = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const short = (node, max = 240) => node.getText(sf).replace(/\s+/g, ' ').slice(0, max);
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
    return node;
  };
  const isFunction = node => node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node));
  const isBuilt = node => node && (ts.isTemplateExpression(node)
    || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
  function index(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) definitions.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name) definitions.set(node.name.text, node);
    ts.forEachChild(node, index);
  }
  index(sf);
  function resolve(node, seen = new Set(), trace = []) {
    node = unwrap(node);
    if (!node) return { kind: 'unknown', node, trace };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: 'constant-string', node, trace };
    if (isBuilt(node)) return { kind: 'built-string', node, trace };
    if (ts.isIdentifier(node) && definitions.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text);
      const target = definitions.get(node.text);
      return resolve(target, seen, [...trace, { name: node.text, line: line(target) }]);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const property = node.properties.find(item => item.name?.getText(sf) === 'content');
      if (property && ts.isPropertyAssignment(property)) return resolve(property.initializer, seen, trace);
      return { kind: 'object', node, trace };
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && definitions.has(node.expression.text)) {
      const fn = unwrap(definitions.get(node.expression.text));
      if (isFunction(fn)) {
        const nextTrace = [...trace, { name: node.expression.text + '()', line: line(fn) }];
        if (!ts.isBlock(fn.body)) return resolve(fn.body, seen, nextTrace);
        const returns = fn.body.statements.filter(ts.isReturnStatement);
        if (returns.length === 1) return resolve(returns[0].expression, seen, nextTrace);
      }
    }
    return { kind: isFunction(node) ? 'function' : 'unknown', node, trace };
  }
  function construction(node) {
    const expressions = ts.isTemplateExpression(node) ? node.templateSpans.map(span => span.expression) : [node];
    const substitutions = expressions.map(expression => {
      const resolved = resolve(expression);
      return {
        line: line(expression), expression: expression.getText(sf),
        kind: resolved.kind === 'constant-string' ? 'constant-code-fragment' : 'runtime-data',
        definitionTrace: resolved.trace,
      };
    });
    return {
      constructionLine: line(node), sourcePreview: short(node), substitutions,
      constructionKind: substitutions.every(item => item.kind === 'constant-code-fragment')
        ? 'constant-code-fragment-composition' : 'runtime-data-interpolation',
    };
  }
  function hasEval(node) {
    let found = false;
    function visit(child) {
      if (ts.isIdentifier(child) && child.text === 'eval') found = true;
      ts.forEachChild(child, visit);
    }
    visit(node);
    return found;
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && methods.has(node.expression.name.text)) {
      counts.totalCalls++;
      const resolved = resolve(node.arguments[0]);
      const base = { path: file, sinkLine: line(node), method: node.expression.name.text, argumentPreview: short(node.arguments[0]), definitionTrace: resolved.trace };
      if (resolved.kind === 'built-string') direct.push({ ...base, ...construction(resolved.node), originalAlertFile: originalAlertFiles.has(file) });
      else if (resolved.kind === 'constant-string') counts.constantStringCalls++;
      else if (resolved.kind === 'function') {
        counts.functionCalls++;
        if (hasEval(resolved.node) && node.arguments[1]) {
          const source = resolve(node.arguments[1]);
          nestedEval.push({ ...base, evalFunctionLine: line(resolved.node), sourceArgumentIndex: 1,
            sourceKind: source.kind, ...(source.kind === 'built-string' ? construction(source.node) : {}) });
        }
      } else if (resolved.kind === 'object') counts.objectCalls++;
      else { counts.unresolvedCalls++; unresolved.push(base); }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  // The two unresolved expr parameters in this checkout are inspected separately.
  // Resolve their known ev()/nav() callers and the ev(expr) loop's source array.
  if (file === 'scripts/manual/preview-matrix-1306.mts') {
    const helpers = ['ev', 'nav'].map(name => ({ name, argumentIndex: name === 'nav' ? 1 : 0, callers: [], loopSourceExpressions: [] }));
    function wrappers(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const helper = helpers.find(item => item.name === node.expression.text);
        if (helper && node.arguments[helper.argumentIndex]) {
          const argument = node.arguments[helper.argumentIndex];
          const resolved = resolve(argument);
          helper.callers.push({ line: line(node), argumentKind: resolved.kind, argumentPreview: short(argument),
            ...(resolved.kind === 'built-string' ? construction(resolved.node) : {}) });
        }
      }
      if (ts.isForOfStatement(node)) {
        const initializer = unwrap(node.expression);
        if (ts.isArrayLiteralExpression(initializer) && node.initializer.getText(sf).includes('expr')) {
          for (const row of initializer.elements) {
            if (ts.isArrayLiteralExpression(row) && row.elements[1]) {
              const resolved = resolve(row.elements[1]);
              helpers[0].loopSourceExpressions.push({ line: line(row.elements[1]), argumentKind: resolved.kind,
                ...(resolved.kind === 'built-string' ? construction(resolved.node) : {}) });
            }
          }
        }
      }
      ts.forEachChild(node, wrappers);
    }
    wrappers(sf);
    for (const helper of helpers) {
      const sink = unresolved.find(item => item.path === file && (helper.name === 'ev' ? item.sinkLine === 80 : item.sinkLine === 127));
      if (!sink) throw new Error('Reviewed wrapper moved; inspect the source before updating this audit: ' + helper.name);
      const builtSources = [...helper.callers, ...helper.loopSourceExpressions].filter(item => item.argumentKind === 'built-string');
      forwardingWrappers.push({ path: file, name: helper.name, sinkLine: sink.sinkLine,
        codeArgumentIndex: helper.argumentIndex, classification: builtSources.length ? 'runtime-data-interpolation' : 'constant-expressions-only',
        builtSourceCount: builtSources.length, ...helper,
        notes: helper.name === 'ev'
          ? 'lit() at line 82 serializes data using JSON.stringify plus character escaping. Direct caller 94 and eight loop expressions 101–108 all reach evaluate(expr) at 80.'
          : 'All eight nav() callers supply constant expressions. Forwarding a code string alone is not evidence of dynamic code construction.' });
    }
  }
}

const additional = direct.filter(item => !item.originalAlertFile);
const sort = (a, b) => a.path.localeCompare(b.path) || a.sinkLine - b.sinkLine;
additional.sort(sort);
nestedEval.sort(sort);
const inventory = {
  schemaVersion: 1,
  task: 'M-2803',
  scope: 'Main checkout scripts/manual only; follow-up inventory alongside fixes for CodeQL js/bad-code-sanitization alerts #105–107.',
  createdBy: 'Read-only TypeScript AST scan plus targeted wrapper review; no browser rigs or production edits.',
  command: 'node docs/evidence/manual-smoke-codeql-m2803/scan.mjs > .artifacts/manual-evaluate-scan.json',
  commands: [
    { command: `rg -l --glob '${glob}' '${pattern}' scripts/manual | wc -l`, count: selected.length, unit: 'files' },
    { command: `rg -n --glob '${glob}' '${pattern}' scripts/manual | wc -l`, count: matchedLines.length, unit: 'matching source lines' },
    { command: "rg -n --glob '*.{mts,ts,js,mjs,cts,cjs}' '\\beval\\b|\\bFunction\\b' scripts/manual", purpose: 'Find nested eval wrappers, including indirect (0, eval).' },
    { command: "rg -n --glob '*.{mts,ts,js,mjs,cts,cjs}' '(\\bevaluate\\b|\\baddInitScript\\b)' scripts/manual | rg -v '\\.(evaluate|evaluateHandle|addInitScript)\\s*\\('", purpose: 'Check non-call mentions for method aliases; review found type declarations/comments only.' },
  ],
  counts: {
    selectedFiles: selected.length, matchingSourceLines: matchedLines.length, ...counts,
    directConstructedCallSites: direct.length,
    additionalDirectConstructedCallSites: additional.length,
    additionalDirectFiles: new Set(additional.map(item => item.path)).size,
    additionalDirectRuntimeDataCallSites: additional.filter(item => item.constructionKind === 'runtime-data-interpolation').length,
    additionalDirectConstantFragmentCallSites: additional.filter(item => item.constructionKind === 'constant-code-fragment-composition').length,
    forwardingSinksWithConstructedSources: forwardingWrappers.filter(item => item.builtSourceCount > 0).length,
    forwardedConstructedSourceExpressions: forwardingWrappers.reduce((sum, item) => sum + item.builtSourceCount, 0),
    forwardingSinksWithConstantExpressionsOnly: forwardingWrappers.filter(item => item.builtSourceCount === 0).length,
    nestedEvalConstructedSourceCallSites: nestedEval.filter(item => item.sourceKind === 'built-string').length,
    nestedEvalConstantFragmentCallSites: nestedEval.filter(item => item.constructionKind === 'constant-code-fragment-composition').length,
  },
  definitions: {
    'runtime-data-interpolation': 'Host-side values are embedded into executable browser source. Values may be fixed fixture inputs or numbers; this does not mean attacker controlled or exploitable.',
    'constant-code-fragment-composition': 'Only previously defined literal source fragments are substituted. This still constructs source, but does not interpolate runtime input data.',
    'constant-expressions-only': 'String code is forwarded unchanged; inspected callers supply literal expressions with no substitutions.',
  },
  findings: additional,
  forwardingWrappers,
  nestedEval,
  originalAlertFiles: [...originalAlertFiles],
  originalAlertFilesWithRemainingConstructedCalls: direct.filter(item => item.originalAlertFile),
  exclusions: [
    'Constant evaluate/addInitScript strings and literal string aliases with no substitutions.',
    'Function callbacks with Playwright serialized data arguments, including the three corrected alert sites.',
    'Template URLs passed to navigation/network APIs outside executable code strings.',
    'HTML fixture strings not passed as executable code to evaluate/addInitScript.',
    'Runtime JSON.stringify performed inside a constant browser expression, without host-side source interpolation.',
  ],
  limitations: [
    'Targeted syntax scan, not whole-program data flow, sanitization validation, or a CodeQL rerun.',
    'Identifier lookup is file-local and keyed by name; it follows initializers and one-return helpers, not mutation/control flow.',
    'All unresolved first arguments in this snapshot are the two explicitly reviewed preview-matrix expr wrappers.',
    'Counts distinguish execution call sites from source expressions: one wrapper sink accepts nine built expressions, and three IME call sites share one builder.',
    'Numeric data and static source fragments have different risk from untrusted strings; occurrences are follow-up candidates, not vulnerability assertions.',
  ],
  historicalSnapshot: {
    phase: 'Before the root agent converted the three open alert sites; captured during the initial read-only scan.',
    selectedFiles: 144, totalCalls: 621, constantStringCalls: 413, directConstructedCallSites: 53, unresolvedCalls: 2,
    note: 'The initial prose report identified eight loop builders at preview-matrix lines 101–108; caller 94 adds a ninth built expression, included in this reproducible inventory.',
  },
};
process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
