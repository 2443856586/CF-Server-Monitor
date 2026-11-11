// 覆盖发布中途失败、上报过期和认证失效，防止自动更新把故障版本留在线上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, releaseWithRollback } from './tokyo.mjs';

function mockSite({ stale = false, adminStatus = 401, history = [{}] } = {}) {
  return async url => {
    const path = new URL(url).pathname;
    if (path === '/') return new Response('<script src="/static/index.js"></script>');
    if (path === '/static/index.js') return new Response('console.log("loaded")');
    if (path === '/api/config') return Response.json({ is_public: true, version: 'test' });
    if (path === '/api/servers') return Response.json({ servers: [{
      id: 'tokyo', last_updated: 1000000 - (stale ? 200000 : 1000), ram_total: 24, disk_total: 200,
    }] });
    if (path === '/api/history/all') return Response.json(history);
    if (path === '/admin/api') return new Response('', { status: adminStatus });
    throw new Error('未预期的请求');
  };
}

test('健康检查覆盖页面、资源、配置、东京上报、历史和管理鉴权', async () => {
  const result = await checkHealth({ fetcher: mockSite(), serverId: 'tokyo', now: 1000000 });
  assert.equal(result.history_points, 1);
});

for (const [name, options] of [
  ['上报过期', { stale: true }], ['匿名管理接口暴露', { adminStatus: 200 }], ['历史为空', { history: [] }],
]) {
  test(`健康检查拒绝${name}`, async () => {
    await assert.rejects(checkHealth({ fetcher: mockSite(options), serverId: 'tokyo', now: 1000000 }));
  });
}

function releaseHarness(failingStage) {
  const calls = [];
  const actions = {};
  for (const stage of ['checkBefore', 'snapshot', 'backup', 'deploy', 'checkAfter', 'rollback', 'save']) {
    actions[stage] = async () => {
      calls.push(stage);
      if (failingStage === stage) throw new Error(stage);
      return stage === 'snapshot' ? 'previous-version' : {};
    };
  }
  return { calls, actions };
}

test('前置检查失败时禁止备份和部署', async () => {
  const { calls, actions } = releaseHarness('checkBefore');
  await assert.rejects(releaseWithRollback(actions));
  assert.deepEqual(calls, ['checkBefore']);
});

test('备份失败时禁止部署', async () => {
  const { calls, actions } = releaseHarness('backup');
  await assert.rejects(releaseWithRollback(actions));
  assert.deepEqual(calls, ['checkBefore', 'snapshot', 'backup']);
});

for (const stage of ['deploy', 'checkAfter']) {
  test(`${stage} 失败时回退且不保存成功记录`, async () => {
    const { calls, actions } = releaseHarness(stage);
    await assert.rejects(releaseWithRollback(actions));
    assert.equal(calls.at(-1), 'rollback');
    assert.ok(!calls.includes('save'));
  });
}

test('发布成功后保存记录且不回退', async () => {
  const { calls, actions } = releaseHarness();
  await releaseWithRollback(actions);
  assert.deepEqual(calls, ['checkBefore', 'snapshot', 'backup', 'deploy', 'checkAfter', 'save']);
});
