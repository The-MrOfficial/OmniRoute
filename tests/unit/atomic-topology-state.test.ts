import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesProvider, normalizeTopology } from '../../src/app/(dashboard)/home/atomic/state.js';

test('atomic topology matches aliases case-insensitively', () => {
  assert.equal(matchesProvider({ provider: 'arc-embed', aliases: ['node-123'] }, 'NODE-123'), true);
  assert.equal(matchesProvider({ provider: 'arc-embed' }, undefined), false);
});

test('active requests take precedence over an error base state', () => {
  const [node] = normalizeTopology({
    providers: [{ provider: 'ollama', status: 'error' }],
    activeRequests: [{ id: 'real-id', provider: 'OLLAMA', model: 'actual-model' }],
  });
  assert.equal(node.live, true);
  assert.equal(node.failed, false);
  assert.equal(node.jobs[0].id, 'real-id');
  assert.equal(node.jobs[0].model, 'actual-model');
});

test('empty live snapshots do not create requests', () => {
  const [node] = normalizeTopology({ providers: [{ provider: 'vllm', status: 'active' }] });
  assert.equal(node.live, false);
  assert.equal(node.jobs.length, 0);
  assert.equal(node.status, 'active');
});

test('normalization preserves navigation ids without mutating caller data', () => {
  const provider = { provider: 'Arc-Embed', aliases: ['node-123'], routeId: 'node-123', name: 'Arc embeddings' };
  const [node] = normalizeTopology({ providers: [provider], activeRequests: [{ provider: 'node-123', model: 'embed' }] });
  assert.equal(provider.provider, 'Arc-Embed');
  assert.equal(node.routeId, 'node-123');
  assert.equal(node.jobs.length, 1);
});
