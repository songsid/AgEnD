/** Signed-in scratch acceptance only. All provider output remains in memory; receipts contain metadata/booleans. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function prepareUnwrittenClaude({ fleet, store, row, coordinator, evidence, deriveNeedsYou }) {
  const first = store.get(row.agent.id).threadId;
  assert(first);
  await fleet.stopInstance(row.name);
  await fleet.startInstance(row.name, row.config, true);
  const replacement = store.get(row.agent.id).threadId;
  assert(replacement && replacement !== first, 'Runner-positive absence must create one fresh session');
  const intent = JSON.parse(await readFile(join(coordinator, 'native-panes', row.agent.id, 'active.json'), 'utf8'));
  assert.equal(intent.fresh.previous.sessionId, first);
  assert.equal(intent.fresh.automatic, true);
  assert.equal(intent.launch.sessionId, undefined);
  evidence.originalPin = first;
  evidence.automaticPin = replacement;
  await fleet.stopInstance(row.name);
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(fleet.startInstance(row.name, row.config, true), error => error.name === 'NativePaneRecoveryError');
    assert.equal(store.get(row.agent.id).threadId, replacement, 'Never create an automatic chain');
    assert.equal(store.get(row.agent.id).activeId, undefined);
  }
  const held = store.get(row.agent.id).paneRecovery;
  assert.equal(held?.kind, 'session-unconfirmed');
  const needs = deriveNeedsYou({ prompts: [], deliveries: [], instances: fleet.needsYouInstances(), ownerOf: () => undefined });
  assert(needs.some(item => item.instance === row.name && item.reason === 'native_pane_hold'));
  await assert.rejects(fleet.startFreshNativePane(row.name, randomUUID(), replacement, () => true));
  await fleet.startFreshNativePane(row.name, held.launchId, replacement, () => true);
  const explicit = store.get(row.agent.id).threadId;
  assert(explicit && explicit !== first && explicit !== replacement);
  evidence.explicitPin = explicit;
  evidence.needsYou = true;
  evidence.noAutomaticChain = true;
  evidence.staleDecisionRefused = true;
}

export async function deliverStates({ fleet, row, replies, until, resumed = false }) {
  const expected = 'NATIVE_' + (row.agent.cli === 'codex' ? 'CODEX' : 'CLAUDE') + '_FLEET_OK';
  const count = () => replies.filter(reply => reply.name === row.name).length;
  const before = count(), daemon = fleet.daemons.get(row.name);
  await until(() => daemon.nativePauseReady(), 'idle composer ' + row.agent.cli, 45000);
  const deliver = async suffix => {
    const accepted = await fleet.deliverToInstance(row.name, {
      type: 'fleet_inbound',
      content: `Acceptance ${suffix}: use the AgEnD reply tool once with exactly ${expected}. Do not run commands or edit files. Then finish.`,
      meta: { source: 'user', adapter_id: 'private-acceptance', chat_id: 'private-chat', thread_id: row.name,
        message_id: randomUUID(), user: 'private-person', runtime: 'native-proof' },
    });
    assert(accepted);
  };
  await deliver(resumed ? 'just-resumed' : 'idle');
  if (!resumed) {
    await until(async () => {
      const pane = await daemon.tmux.capturePane();
      return daemon.backend.getBusyPattern?.()?.test(pane) === true;
    }, 'real busy screen ' + row.agent.cli, 45000);
    await deliver('while-busy');
  }
  await until(() => count() === before + (resumed ? 1 : 2), 'scoped MCP reply states ' + row.agent.cli, 180000);
  await until(() => daemon.nativePauseReady(), 'settled composer ' + row.agent.cli, 45000);
}
