// Read-only lexical inventory; mentions/call-shaped text are not a dynamic call graph.
import { execFileSync } from 'node:child_process';
const base = process.argv[2] ?? '1cebc9b06d042bff3f0160131de9b09341320e50';
function files(pattern) {
  try {
    return execFileSync('git', ['grep', '-l', '-E', pattern, base, '--', 'tests'], { encoding: 'utf8' })
      .trim().split('\n').map(row => row.slice(base.length + 1)).filter(row => row.endsWith('.test.ts')).sort();
  } catch (error) { if (error.status === 1) return []; throw error; }
}
const saveReferences = files('saveFleetConfig');
const saveCallSyntax = files('[.]saveFleetConfig[[:space:]]*[(]');
const workerMocks = files('vi[.]mock[(]"node:worker_threads"');
console.log(JSON.stringify({ base, scope: 'Lexical references and call-shaped text, including fixtures and refused saves; not all are successful live calls.',
  saveReferences, saveCallSyntax, saveCallsWithoutWorkerMock: saveCallSyntax.filter(path => !workerMocks.includes(path)),
  boundedProbeReferences: files('probeBackendBounded'), workerMocks,
}, null, 2));
