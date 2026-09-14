import test from 'node:test';
import assert from 'node:assert/strict';
import { createFoundryBrowserBridge } from './browser-bridge.mjs';

const image = { mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
function fixture(prompt) {
  let closed = false;
  const toolset = [{ name: 'screenshot', description: 'Read screenshot', inputSchema: { type: 'object' }, async execute() { return { status: 'success', data: { captured: true }, images: [image] }; } }];
  toolset.close = async () => { closed = true; };
  return { bridge: createFoundryBrowserBridge({ model: { name: 'protocol-unit-stub', setSystemPrompt() {}, prompt }, toolset }), closed: () => closed };
}

test('PNG becomes a native image after committed tool results, never JSON tool data', async () => {
  const seen = [];
  const { bridge, closed } = fixture(async (request, _notify, signal) => { seen.push({ request, signal }); return { messages: [], tokens_in: 0, tokens_out: 0 }; });
  const controller = new AbortController();
  const result = await bridge.tools[0].do({}, undefined, undefined, controller.signal);
  assert.deepEqual(result, { status: 'success', data: { captured: true } });
  assert.ok(!JSON.stringify(result).includes(image.base64));
  const original = [{ sender: 'agent', text: '', tool_calls: [{ id: 'call-1', tool_name: 'screenshot', input_args: {} }] }, { sender: 'user', text: '', tool_results: [{ call_id: 'call-1', tool_name: 'screenshot', result }] }];
  await bridge.model.prompt({ messages: original }, () => {}, controller.signal);
  assert.equal(original.length, 2);
  assert.equal(seen[0].request.messages.length, 3);
  assert.equal(seen[0].request.messages[1], original[1]);
  assert.deepEqual(seen[0].request.messages[2].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.base64 } });
  assert.equal(seen[0].signal, controller.signal);
  await bridge.model.prompt({ messages: original }, () => {});
  assert.equal(seen[1].request.messages.length, 2, 'Consumed image must not grow every subsequent model request');
  await bridge.close(); assert.equal(closed(), true);
});

test('a failed provider attempt preserves the observation for retry', async () => {
  let attempts = 0;
  const { bridge } = fixture(async request => {
    assert.equal(request.messages.at(-1).content[1].source.data, image.base64);
    if (++attempts === 1) throw new Error('Unit fixture provider failure');
    return { messages: [], tokens_in: 0, tokens_out: 0 };
  });
  await bridge.tools[0].do({});
  await assert.rejects(bridge.model.prompt({ messages: [] }, () => {}), /Configured model request failed/);
  await bridge.model.prompt({ messages: [] }, () => {});
  assert.equal(attempts, 2);
  await bridge.close();
});

test('provider errors expose only a bounded HTTP status, never raw credentials or request data', async () => {
  const events = [];
  const bridge = createFoundryBrowserBridge({
    toolset: [], onEvent: event => events.push(event),
    model: { name: 'unit', setSystemPrompt() {}, async prompt() { throw Object.assign(new Error('private credential and request body'), { status: 401, headers: { authorization: 'private token' } }); } },
  });
  await assert.rejects(bridge.model.prompt({ messages: [] }, () => {}), error => error.message === 'Configured model request failed.' && error.cause === undefined);
  assert.deepEqual(events.at(-1), { type: 'model_error', httpStatus: 401 });
  assert.ok(!JSON.stringify(events).includes('private'));
});
