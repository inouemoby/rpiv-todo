import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const chunksDir = join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'chunks');
const chunk = readdirSync(chunksDir).find((name) => name.endsWith('.js') &&
  readFileSync(join(chunksDir, name), 'utf8').includes('async _runAgentPrompt(messages){'));
assert.ok(chunk);
const { discoverAndLoadExtensions, AgentSession, SessionManager, ExtensionRunner, convertToLlm } =
  await import(pathToFileURL(join(chunksDir, chunk)).href);
const wm = join(here, '..', 'pi-workspace-manager', 'index.ts');
const loaded = await discoverAndLoadExtensions([wm, join(here, 'index.ts')], here, here);
assert.deepEqual(loaded.errors, []);
const [workspace, todo] = loaded.extensions;
assert.ok(workspace && todo);

function sessionHarness() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Complete the task' }], timestamp: 1 });
  manager.appendCustomMessageEntry('pi-workspace-manager:empty-enter-recovery', [], false);
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Work in progress' }], stopReason: 'stop', timestamp: 2 });
  let pending = false;
  const ctx = { sessionManager: manager, hasPendingMessages: () => pending };
  return { manager, ctx, setPending: (value) => { pending = value; } };
}

async function startTask(ctx) {
  const tool = todo.tools.get('todo').definition;
  await tool.execute('create', { action: 'create', subject: 'Finish integration tests' }, undefined, undefined, ctx);
  await tool.execute('update', { action: 'update', id: 1, status: 'in_progress', activeForm: 'testing integration' }, undefined, undefined, ctx);
}

function boundaryEvent(entries = []) {
  return {
    type: 'agent_before_settle', outcome: 'completed', continue: false, entries,
    context: { pendingMessages: [], canContinue: false, contextEntries: [], contextMessages: [], llmMessages: [] },
  };
}

test('the todo reminder is atomically appended and not asynchronously queued', async () => {
  const { manager, ctx } = sessionHarness();
  await startTask(ctx);
  const queued = [];
  loaded.runtime.sendUserMessage = (...args) => queued.push(args);
  const previous = { type: 'custom', customType: 'earlier-boundary-entry', data: { unrelated: true } };
  const draft = await todo.handlers.get('agent_before_settle')[0](boundaryEvent([previous]), ctx);
  assert.equal(draft.continue, true);
  assert.deepEqual(draft.entries[0], previous);
  assert.equal(draft.entries[1].type, 'custom_message');
  assert.equal(draft.entries[1].display, false);
  assert.match(draft.entries[1].content, /Finish integration tests/);
  assert.match(draft.entries[1].content, /testing integration/);
  assert.deepEqual(queued, []);
  manager.appendCustomMessageEntry(draft.entries[1].customType, draft.entries[1].content, draft.entries[1].display);
  const runner = new ExtensionRunner(loaded.extensions, {}, process.cwd(), manager, {});
  const llmContext = await runner.emitContext(manager.buildSessionProjection().messages);
  assert.equal(llmContext.at(-1).customType, 'rpiv-todo:in-progress-reminder');
  assert.match(llmContext.at(-1).content, /Finish integration tests/);
  assert.equal(llmContext.some((item) => item.customType === 'pi-workspace-manager:empty-enter-recovery'), false);
  const providerMessages = convertToLlm(llmContext);
  assert.equal(providerMessages.at(-1).role, 'user');
  assert.match(providerMessages.at(-1).content[0].text, /Finish integration tests/);
});

test('Pi settlement boundary itself continues with no follow-up queue', async () => {
  const { manager, ctx } = sessionHarness();
  await startTask(ctx);
  const session = Object.create(AgentSession.prototype);
  session.sessionManager = manager;
  session.agent = {
    state: { messages: manager.buildSessionProjection().messages },
    hasQueuedMessages: () => false,
    peekQueuedMessages: () => [],
  };
  session._lastActivityOutcome = 'completed';
  session._agentRunAbortRequested = false;
  session._pendingCustomMessages = [];
  session._entryIdsByMessage = new WeakMap();
  session._emit = () => {};
  session._flushPendingCustomMessages = () => {};
  session._extensionRunner = {
    hasHandlers: (name) => name === 'agent_before_settle',
    emitBoundary: async (event, preview) => {
      const context = preview([]);
      assert.equal(context.canContinue, false);
      const result = await todo.handlers.get('agent_before_settle')[0]({ ...event, entries: [], continue: false, context }, ctx);
      assert.equal(preview(result.entries).canContinue, true);
      return result;
    },
  };
  assert.equal(await session._runBeforeSettleBoundary(), true);
  assert.equal(manager.getBranch().at(-1).type, 'custom_message');
  assert.equal(session.agent.hasQueuedMessages(), false);
});

test('pending user messages and aborted runs remain untouched', async () => {
  const { ctx, setPending } = sessionHarness();
  await startTask(ctx);
  const handler = todo.handlers.get('agent_before_settle')[0];
  setPending(true);
  assert.equal(await handler(boundaryEvent(), ctx), undefined);
  setPending(false);
  assert.equal(await handler({ ...boundaryEvent(), outcome: 'aborted' }, ctx), undefined);
  assert.equal(await handler({ ...boundaryEvent(), context: { pendingMessages: [{ role: 'user' }] } }, ctx), undefined);
});
