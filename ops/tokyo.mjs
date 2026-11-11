// 东京监控发布工具。凭据只通过环境变量读取，数据库备份先加密再上传。
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createCipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const configPath = 'wrangler.tokyo.jsonc';
const statePath = 'ops/tokyo-state.json';
const runtimePath = '.tokyo-runtime';
const baseUrl = 'https://status.jie02.ccwu.cc';
const accountId = 'fa65a1d7446f86a39ddf078c15f70f9d';
const workerName = 'cfsm-tokyo';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`命令执行失败 ${command}，退出码 ${result.status}`);
  }
  return result.stdout?.trim() || '';
}

function wrangler(...args) {
  return run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', configPath], { stdio: 'inherit' });
}

export async function checkHealth({ fetcher = fetch, serverId = process.env.TOKYO_SERVER_ID, now = Date.now() } = {}) {
  if (!serverId) throw new Error('缺少东京节点 ID');
  async function request(path, options = {}) {
    return fetcher(baseUrl + path, {
      ...options,
      headers: { 'User-Agent': 'Mozilla/5.0 CFSM-Tokyo-Health', ...options.headers },
      signal: AbortSignal.timeout(30000),
    });
  }
  const page = await request('/');
  if (!page.ok) throw new Error(`首页 HTTP ${page.status}`);
  const html = await page.text();
  const script = html.match(/src=["'](\/(?:static|assets)\/[^"']+\.js)["']/)?.[1];
  if (!script) throw new Error('首页缺少前端脚本');
  const asset = await request(script);
  if (!asset.ok || !(await asset.text()).length) throw new Error('静态资源检查失败');
  const configResponse = await request('/api/config');
  if (!configResponse.ok) throw new Error('站点配置接口检查失败');
  const config = await configResponse.json();
  if (!config.is_public || !config.version) throw new Error('公开站点配置异常');
  const serverResponse = await request('/api/servers');
  if (!serverResponse.ok) throw new Error('节点列表接口检查失败');
  const data = await serverResponse.json();
  const tokyo = data.servers?.find(server => server.id === serverId);
  const age = now - Number(tokyo?.last_updated);
  if (!tokyo || !Number.isFinite(age) || age < -60000 || age > 180000) {
    throw new Error('东京节点上报过期或节点缺失');
  }
  if (!(Number(tokyo.ram_total) > 0) || !(Number(tokyo.disk_total) > 0)) {
    throw new Error('东京资源指标异常');
  }
  const historyResponse = await request(`/api/history/all?id=${encodeURIComponent(serverId)}&hours=0.167`);
  if (!historyResponse.ok) throw new Error('历史接口检查失败');
  const history = await historyResponse.json();
  if (!Array.isArray(history) || !history.length) throw new Error('历史数据为空');
  const admin = await request('/admin/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_settings' }),
  });
  if (admin.status !== 401) throw new Error('匿名管理接口未正确拒绝');
  return { checked_at: new Date(now).toISOString(), version: config.version, last_updated: tokyo.last_updated,
    history_points: history.length, agent_version: tokyo.agent_version };
}

async function cloudflare(path, body) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('缺少 Cloudflare 部署令牌');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Cloudflare ${path} 返回 HTTP ${response.status}`);
  const result = await response.json();
  if (!result.success) throw new Error(`Cloudflare ${path} 未成功`);
  return result.result;
}

async function currentVersion() {
  const result = await cloudflare(`/workers/scripts/${workerName}/deployments`);
  const deployment = result.deployments?.[0];
  if (deployment?.versions?.length !== 1 || deployment.versions[0].percentage !== 100) {
    throw new Error('当前部署并非单一完整版本，停止自动发布');
  }
  return deployment.versions[0].version_id;
}

export async function releaseWithRollback({ checkBefore, snapshot, backup, deploy, checkAfter, rollback, save }) {
  await checkBefore();
  const previous = await snapshot();
  await backup();
  // deploy 可能在上传成功、触发器更新失败时抛错，此时也必须检查并恢复版本。
  try {
    await deploy();
    const health = await checkAfter();
    await save(previous, health);
    return health;
  } catch (error) {
    await rollback(previous);
    throw error;
  }
}

async function backupDatabase() {
  const key = Buffer.from(process.env.TOKYO_BACKUP_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('备份密钥必须是 32 字节');
  await mkdir(runtimePath, { recursive: true });
  const plain = `${runtimePath}/database.sql`;
  try {
    wrangler('d1', 'export', 'cfsm-tokyo-db', '--remote', '--output', plain, '--skip-confirmation');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(await readFile(plain)), cipher.final()]);
    await writeFile(`${runtimePath}/database.enc.json`, JSON.stringify({
      algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }));
  } finally {
    await unlink(plain).catch(() => {});
  }
}

async function guardCompatibility() {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const previous = state.releases[0]?.source_sha;
  if (!previous) throw new Error('缺少已验收版本基线');
  const changed = run('git', ['diff', '--name-only', previous, 'HEAD', '--', 'src/database', 'src/durable', 'wrangler.toml']);
  if (changed) throw new Error(`数据库或 Durable Object 需要兼容复核，暂停上线。涉及 ${changed.split('\n').join('、')}`);
}

async function retryHealth() {
  let failure;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await checkHealth(); } catch (error) { failure = error; }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 20000));
  }
  throw failure;
}

async function release() {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const sourceSha = run('git', ['rev-parse', 'HEAD']);
  await mkdir(runtimePath, { recursive: true });
  await releaseWithRollback({
    checkBefore: async () => {
      await guardCompatibility();
      await checkHealth();
      const remote = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
      if (remote !== sourceSha) throw new Error('仓库已被并发更新，停止发布');
    },
    snapshot: currentVersion,
    backup: backupDatabase,
    deploy: async () => wrangler('deploy', '--message', `Tokyo ${sourceSha.slice(0, 12)}`),
    checkAfter: async () => {
      if (process.env.TOKYO_SIMULATION === 'health_failure') throw new Error('验收演练：部署后健康检查失败');
      return retryHealth();
    },
    rollback: async previous => {
      const active = await currentVersion();
      if (active !== previous) {
        await cloudflare(`/workers/scripts/${workerName}/deployments`, {
          strategy: 'percentage', versions: [{ version_id: previous, percentage: 100 }],
          annotations: { 'workers/message': 'Tokyo 自动回退到上一次部署' },
        });
      }
      const health = await retryHealth();
      await writeFile(`${runtimePath}/rollback.json`, JSON.stringify({ version_id: previous, health }, null, 2));
      console.log(`已确认回退版本 ${previous}`);
    },
    save: async (previous, health) => {
      const record = { source_sha: sourceSha, version_id: await currentVersion(), previous_version_id: previous,
        deployed_at: new Date().toISOString(), backup_run_id: process.env.GITHUB_RUN_ID || 'local', health };
      await writeFile(`${runtimePath}/release.json`, JSON.stringify(record, null, 2));
      state.releases = [record, ...state.releases].slice(0, 2);
      await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
    },
  });
}

async function notify() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('缺少 Telegram 告警凭据');
  const simulation = process.env.TOKYO_SIMULATION;
  const title = simulation && simulation !== 'none'
    ? `【验收演练】东京监控已主动触发 ${simulation}，正在核对拦截或回退结果。`
    : '东京监控自动更新未完成，请查看运行记录。';
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat,
      text: `${title}\nhttps://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error('Telegram 更新通知发送失败');
}

async function pruneBackups() {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const keep = new Set(state.releases.map(item => `cfsm-tokyo-${item.backup_run_id}`));
  const api = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts`;
  const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };
  const artifacts = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${api}?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error('读取备份制品失败');
    const result = await response.json();
    artifacts.push(...result.artifacts);
    if (result.artifacts.length < 100) break;
  }
  for (const artifact of artifacts) {
    if (!artifact.name.startsWith('cfsm-tokyo-') || keep.has(artifact.name)) continue;
    const response = await fetch(`${api}/${artifact.id}`, { method: 'DELETE', headers });
    if (!response.ok) throw new Error('清理旧备份失败');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const commands = { check: async () => console.log(JSON.stringify(await checkHealth())),
    guard: guardCompatibility, release, notify, prune: pruneBackups };
  try {
    const command = commands[process.argv[2]];
    if (!command) throw new Error('未知的东京运维命令');
    await command();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
