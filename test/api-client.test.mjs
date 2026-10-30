import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ApiClient } from '../src/api-client.mjs';

function workers(replyOn) {
  const children = [];
  return {
    children,
    forkImpl() {
      const child = new EventEmitter();
      child.connected = true;
      child.killed = false;
      child.disconnect = () => {
        child.connected = false;
      };
      child.kill = () => {
        child.killed = true;
      };
      child.send = (message, callback) => {
        callback?.();
        if (children.length === replyOn)
          setImmediate(() =>
            child.emit('message', { id: message.id, ok: true, body: { code: 200 } })
          );
      };
      children.push(child);
      return child;
    },
  };
}

test('a hung read-only request discards its worker and retries once with a new worker', async () => {
  const rig = workers(2),
    client = new ApiClient({ timeoutMs: 20, forkImpl: rig.forkImpl });
  try {
    assert.equal((await client.call('login_status')).body.code, 200);
    assert.equal(rig.children.length, 2);
    assert.equal(rig.children[0].killed, true);
  } finally {
    client.close();
  }
});

test('repeated timeout remains an error after exactly two attempts', async () => {
  const rig = workers(99),
    client = new ApiClient({ timeoutMs: 20, forkImpl: rig.forkImpl });
  try {
    await assert.rejects(client.call('login_status'), (error) => error.code === 'API_TIMEOUT');
    assert.equal(rig.children.length, 2);
    assert.ok(rig.children.every((child) => child.killed));
  } finally {
    client.close();
  }
});

test('closing during a request cannot spawn a retry or accept future requests', async () => {
  const rig = workers(99),
    client = new ApiClient({ timeoutMs: 100, forkImpl: rig.forkImpl });
  const pending = assert.rejects(client.call('login_status'));
  client.close();
  await pending;
  await assert.rejects(client.call('login_status'), (error) => error.code === 'CANCELLED');
  assert.equal(rig.children.length, 1);
});
