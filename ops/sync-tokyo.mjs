// 同步上游应用源码，部署工作流由本站维护，避免把上游工作流权限带入 CI。
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { run } from './tokyo.mjs';

run('git', ['config', 'user.name', 'github-actions[bot]']);
run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
if (!run('git', ['remote']).split('\n').includes('upstream')) {
  run('git', ['remote', 'add', 'upstream', 'https://github.com/huilang-me/CF-Server-Monitor.git']);
}
run('git', ['fetch', 'upstream', 'main'], { stdio: 'inherit' });
const before = run('git', ['rev-parse', 'HEAD']);
const upstream = run('git', ['rev-parse', 'upstream/main']);
const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', upstream, 'HEAD']);
if (ancestor.status !== 0) {
  const merge = spawnSync('git', ['merge', '--no-commit', '--no-ff', 'upstream/main'], { stdio: 'inherit' });
  const conflicts = run('git', ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  if (conflicts.some(path => !path.startsWith('.github/workflows/'))) {
    run('git', ['merge', '--abort']);
    throw new Error('上游代码合并冲突，已停止同步');
  }
  if (merge.status !== 0 && !conflicts.length) throw new Error('上游合并失败');
  run('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.github/workflows']);
  run('git', ['commit', '-m', `chore: 同步上游 ${upstream.slice(0, 12)}`], { stdio: 'inherit' });
  run('git', ['push', 'origin', 'HEAD:main'], { stdio: 'inherit' });
}
const deployed = JSON.parse(readFileSync('ops/tokyo-state.json', 'utf8')).releases[0].source_sha;
const pending = run('git', ['diff', '--name-only', deployed, 'HEAD', '--', '.', ':(exclude)ops/tokyo-state.json']);
const changed = pending.length > 0;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nupstream_sha=${upstream}\n`);
console.log(`上游提交 ${upstream}，本次同步 ${before !== run('git', ['rev-parse', 'HEAD'])}，待发布 ${changed}`);
