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
    const canary=expected+'_'+suffix.toUpperCase().replaceAll('-','_');
    const accepted = await fleet.deliverToInstance(row.name, {
      type: 'fleet_inbound',
      content: suffix === 'idle'
        ? `Idle acceptance: first use the AgEnD reply tool once with exactly ${canary}. After that tool returns, continue working by writing a 600-word story in the terminal only. Do not send the story to chat or use the reply tool for it. Do not run commands or edit files.`
        : `Acceptance ${suffix}: use the AgEnD reply tool once with exactly ${canary}. Do not run commands or edit files. Then finish.`,
      meta: { source: 'user', adapter_id: 'private-acceptance', chat_id: 'private-chat', thread_id: row.name,
        message_id: randomUUID(), user: 'private-person', runtime: 'native-proof' },
    });
    assert(accepted);
  };
  await deliver(resumed ? 'just-resumed' : 'idle');
  if (!resumed) {
    // The idle request must be acknowledged before a second user input can be coalesced into its turn.
    // Its terminal-only continuation supplies genuine ongoing work for the busy-delivery probe.
    await until(() => replies.slice(before).some(reply => reply.name === row.name && reply.text === expected + '_IDLE'), 'idle reply before busy probe ' + row.agent.cli, 180000);
    await until(async () => {
      try {
        const pane = await daemon.tmux.capturePane();
        return daemon.backend.getBusyPattern?.()?.test(pane) === true;
      } catch { return false; } // Native repaint refuses a capture; it is not positive busy evidence. Poll within the same bound.
    }, 'real busy screen ' + row.agent.cli, 45000);
    await deliver('while-busy');
  }
  const expectedReplies=(resumed?['JUST_RESUMED']:['IDLE','WHILE_BUSY']).map(state=>expected+'_'+state);
  await until(() => expectedReplies.every(text=>replies.filter(reply=>reply.name===row.name).slice(before).some(reply=>reply.text===text)), 'scoped MCP reply states ' + row.agent.cli, 180000);
  assert.equal(count(),before+(resumed?1:2),'Each state replies exactly once');
  await until(() => daemon.nativePauseReady(), 'settled composer ' + row.agent.cli, 45000);
}
