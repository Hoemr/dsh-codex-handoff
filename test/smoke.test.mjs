import test from 'node:test';
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';

test('plugin exports the expected manifest surface', () => {
  assert.equal(plugin.name, 'codex-handoff');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply registers the three Codex tools', () => {
  const registered = new Map();
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => {};
      },
    },
    on() {},
  };

  plugin.apply(ctx, {});

  assert.deepEqual([...registered.keys()].sort(), ['codex_send', 'codex_task', 'codex_threads']);
  for (const [name, definition] of registered) {
    assert.equal(definition.parameters?.type, 'object', `${name} parameters`);
    assert.equal(typeof definition.execute, 'function', `${name} execute`);
    const schema = definition.output?.schema;
    assert.equal(schema?.type, 'object', `${name} output schema`);
    // DSH's enforced JSON Schema subset: `required` is an array on objects,
    // never a boolean on properties.
    for (const property of Object.values(schema.properties)) {
      assert.equal(property.required, undefined, `${name} property required flag`);
    }
  }
});

test('codex_threads parses the local session index without network', async () => {
  const registered = new Map();
  plugin.apply(
    { tools: { register: (d) => (registered.set(d.name, d), () => {}) }, on() {} },
    {},
  );
  const result = await registered.get('codex_threads').execute(
    { limit: 3 },
    { signal: undefined, agent: { session: { id: 'test-session' } } },
  );
  assert.equal(typeof result.count, 'number');
  assert.ok(Array.isArray(result.threads));
  assert.ok(result.threads.length <= 3);
  for (const thread of result.threads) {
    assert.equal(typeof thread.id, 'string');
    assert.equal(typeof thread.title, 'string');
    assert.equal(typeof thread.updated_at, 'string');
  }
});
