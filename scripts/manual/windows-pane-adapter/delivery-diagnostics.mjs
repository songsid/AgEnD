/** Observe one scratch native daemon without captures, input contents, extra IO or retrying operations. */
const enumValue = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(value) ? value : null;
const portErrors = new Map([
  ['Pane input withheld: the intended composer or dialog is not verified', 'unverified-input'],
  ['Pane changed after observation; input was not sent', 'changed-after-observation'],
  ['Pane input outcome is unconfirmed; reconnect and inspect before retrying', 'outcome-unconfirmed'],
]);
export function traceNativeDelivery(daemon, name, diagnostics) {
  const events = diagnostics.deliveryTrace ??= [];
  const record = value => { if (events.length < 128) events.push({ name, ...value }); };
  const owner = () => ({ spawn: daemon.spawnGeneration, fence: daemon.launchFenceEpoch,
    stopping: !!daemon.deliveryWritesStopping, current: daemon.nativePaneCurrent() });
  const port = daemon.tmux;
  for (const method of ['pasteBuffer', 'sendSpecialKey']) {
    const original = port[method].bind(port);
    port[method] = (...args) => {
      const before = owner();
      const result = original(...args);
      const done = value => {
        record({ boundary: method, ...(method === 'sendSpecialKey' ? { enter: args[0] === 'Enter' } : {}),
          result: value === true, notSent: port.lastInputWasNotSent?.() === true,
          error: portErrors.get(method === 'pasteBuffer' ? port.getLastPasteError?.() : port.getLastSendSpecialKeyError?.()) ?? null,
          before, after: owner() });
        return value;
      };
      return result && typeof result.then === 'function' ? result.then(done) : done(result);
    };
  }
  for (const method of ['sendDeliveryEnter', 'sendDeliveryEnterAfterAvailability', 'writeMessageToPane', 'failDelivery']) {
    const original = daemon[method].bind(daemon);
    daemon[method] = (...args) => {
      const before = owner(), result = original(...args);
      const done = value => {
        const verdict = method === 'writeMessageToPane' ? args[5] : method === 'failDelivery' ? args[0] : undefined;
        record({ boundary: method, result: typeof value === 'boolean' ? value : enumValue(value),
          phase: enumValue(method.startsWith('sendDeliveryEnter') ? args[0] : verdict?.phase),
          proof: enumValue(verdict?.proof), fenced: verdict?.fenced === true,
          paneWriteStarted: verdict?.paneWriteStarted === true, before, after: owner() });
        return value;
      };
      return result && typeof result.then === 'function' ? result.then(done) : done(result);
    };
  }
  const warnings = new Map([
    ['Delivery input is not a verified composer; Enter withheld', 'enter-withheld'],
    ['Native delivery Enter withheld by its safety check', 'enter-withheld'],
    ['The pane stayed in a tmux mode; Enter withheld', 'pane-mode-held'],
    ['pasteBuffer failed — recovering window and backing off', 'paste-retry'],
    ['pasteBuffer failed — non-retryable tmux error', 'paste-refused'],
  ]);
  for (const level of ['warn', 'error']) {
    const original = daemon.logger[level].bind(daemon.logger);
    daemon.logger[level] = (...args) => {
      const label = warnings.get(args.at(-1));
      if (label) {
        const fields = args[0];
        record({ boundary: label, phase: enumValue(fields?.phase), reason: enumValue(fields?.reason),
          attempt: Number.isSafeInteger(fields?.attempt) ? fields.attempt : null,
          recoverable: typeof fields?.recoverable === 'boolean' ? fields.recoverable : null,
          error: portErrors.get(fields?.tmuxError) ?? null });
      }
      return original(...args);
    };
  }
}
