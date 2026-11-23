import { defineConfig } from 'vitest/config';
import { unitTestConfig } from '../../vitest.config.js';
const base = unitTestConfig('');
export default defineConfig({ ...base, plugins: [...(base.plugins || []), {
  name: 'm3538-parent-cold-import-mechanism-control', enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('/src/fleet-manager.ts')) return { code: code + '\nawait new Promise(resolve => setTimeout(resolve, 11_000));\n', map: null };
  },
}], test: { ...base.test, include: ['src/delivery-outbox.test.ts'], maxWorkers: 1, fileParallelism: false } });
