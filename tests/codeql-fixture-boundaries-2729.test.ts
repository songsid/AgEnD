import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

// Extract only the changed browser callbacks, never import/start a smoke harness or fleet.
function callback(file: string, marker: string, globals: Record<string, unknown>) {
  const source = readFileSync(resolve('scripts/manual/smoke', file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ts.ArrowFunction[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'evaluate'
      && node.arguments.length === 2 && ts.isArrowFunction(node.arguments[0]) && node.arguments[0].getText(ast).includes(marker)) found.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(ast); expect(found).toHaveLength(1);
  const js = transformSync(`(${found[0].getText(ast)})`, { loader: 'ts', target: 'es2022', keepNames: true }).code;
  expect(js).not.toContain('__name'); // tsx helpers do not exist inside the browser's evaluation context.
  return runInNewContext(js, globals, { timeout: 1000 }) as (data: unknown) => any;
}

describe('smoke callback data boundaries without a browser or service', () => {
  it('marks the last usage row and clears old marks, with a literal selector argument', () => {
    const selector = `literal selector '"\\; globalThis.unexpected = true`;
    const marks: string[] = [];
    const globals = { document: {
      querySelectorAll(value: string) {
        if (value === selector) return [{ querySelectorAll: () => [{ setAttribute: (name: string, value: string) => marks.push(`${name}=${value}`) }] }];
        expect(value).toBe('[data-smoke-last]'); return [{ removeAttribute: (name: string) => marks.push(`removed ${name}`) }];
      },
    } };
    callback('smoke-usage-compact.mts', 'setAttribute', globals)(selector);
    expect(marks).toEqual(['removed data-smoke-last', 'data-smoke-last=1']);
    expect(globals).not.toHaveProperty('unexpected');
  });
  it('preserves the focus bar and all three rounded-corner geometry checks', () => {
    const group = { getBoundingClientRect: () => ({ left: 0, bottom: 100 }) };
    const row = { closest: () => group, getBoundingClientRect: () => ({ left: 3, bottom: 100, top: 80 }), matches: () => true };
    const globals = {
      document: { activeElement: row, querySelector: (selector: string) => { expect(selector).toBe('owned last row'); return row; } },
      getComputedStyle: (element: unknown, pseudo?: string) => pseudo ? { left: '0', bottom: '0', top: '0', content: '""', width: '3px' }
        : element === group ? { borderBottomLeftRadius: '4px' } : { boxShadow: 'none' },
    };
    const measure = callback('smoke-usage-compact.mts', 'corners', globals);
    expect(measure('owned last row')).toEqual({ focused: true, bar: true, radius: 4, corners: [false, true, true], shadow: 'none', lastInGroup: true });
    globals.document.querySelector = () => null as any;
    expect(measure('missing row')).toBeNull();
  });
  it('clips and resets the composer elements using argument data', () => {
    const selector = `literal composer '"\\`;
    const target = { style: { textOverflow: 'ellipsis' } }, input = { style: { textOverflow: 'clip' } };
    const globals = { document: { querySelector: (value: string) => value === selector ? target : value === '#msgIn' ? input : null } };
    callback('smoke-2478-composer.mts', '= "clip"', globals)(selector);
    expect(target.style.textOverflow).toBe('clip');
    callback('smoke-2478-composer.mts', 'for (const s', globals)([selector, '#msgIn']);
    expect([target.style.textOverflow, input.style.textOverflow]).toEqual(['', '']);
  });
});

// Exercise the real CI checker against private workflow copies. All probe baseline args remain empty,
// so the copied data runner fails before any package/store import or data directory creation.
describe('downgrade CI guard keeps exact baseline and pipeline failure checks', () => {
  it.each(['valid', 'wrong-baseline', 'missing-pipefail'] as const)('%s', mode => {
    const scratch = mkdtempSync(join(tmpdir(), 'agend-codeql-ci-'));
    try {
      mkdirSync(join(scratch, 'scripts')); mkdirSync(join(scratch, '.github/workflows'), { recursive: true });
      symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'dir');
      for (const file of ['check-data-downgrade-workflow.mjs', 'check-data-downgrade.mjs']) writeFileSync(join(scratch, 'scripts', file), readFileSync(resolve('scripts', file)));
      const config: any = yaml.load(readFileSync(resolve('.github/workflows/data-downgrade.yml'), 'utf8'));
      const first = config.jobs['data-downgrade'].steps.find((step: any) => step.id === 'roundtrip');
      if (mode === 'wrong-baseline') first.run = first.run.replaceAll('2.1.12', '2.2.6');
      if (mode === 'missing-pipefail') delete first.shell;
      writeFileSync(join(scratch, '.github/workflows/data-downgrade.yml'), yaml.dump(config));
      const result = spawnSync(process.execPath, [join(scratch, 'scripts/check-data-downgrade-workflow.mjs')], {
        cwd: scratch, encoding: 'utf8', timeout: 15000,
        env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: scratch, AGEND_HOME: join(scratch, 'agend') },
      });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      if (mode === 'valid') {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split('\n').map(line => JSON.parse(line).pipelineExitCode)).toEqual([1, 1]);
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(mode === 'wrong-baseline' ? 'roundtrip must pass its baseline' : 'A failed probe must fail the workflow step even when tee succeeds');
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
