import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { grokSwitchVerdict } from '../src/backend/grok-model-switch.js';
const pane = (name: string) => readFileSync(join(import.meta.dirname,'fixtures/grok-1.0.88-audit/panes',name+'.pane.txt'),'utf8');

describe('Grok1.0.88 captured inline switch notices', () => {
  it('confirms the requested model and effort from its fresh notice', () => {
    expect(grokSwitchVerdict({model:'grok-4',effort:'high'},pane('61-mcp'),pane('62-model'))).toMatchObject({outcome:'switched',confirmed:true});
  });
  it('changes effort without losing the model', () => {
    expect(grokSwitchVerdict({model:null,effort:'low'},pane('62-model'),pane('63-effort'))).toMatchObject({outcome:'switched',confirmed:true});
  });
  it('treats an unknown model as a refusal', () => {
    expect(grokSwitchVerdict({model:'definitely-unknown',effort:null},pane('63-effort'),pane('64-unknown-model'))).toMatchObject({outcome:'mismatch',answered:true});
  });
  it('never reuses an old success as a fresh confirmation', () => {
    expect(grokSwitchVerdict({model:'grok-4',effort:'high'},pane('62-model'),pane('62-model'))).toBeNull();
  });
});
