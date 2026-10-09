// tools/sync-live.mjs — 把根目录的共享代码同步到 deploy-live（公网副本）
// 用法：node tools/sync-live.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const dest = join(root, 'deploy-live');
const FILES = [
  'net-server.mjs',
  'config.mjs',
  'game/game.mjs',
  'game/game6.mjs',
  'public-net/index.html',
  'public-net/app.js',
  'public-net/style.css',
  '红心对决-核心玩法规则V8.md',
  '红心对决-六人两副牌玩法规则V9.md',
];

if (!existsSync(dest)) { console.error('找不到 deploy-live 目录，请在项目根目录执行'); process.exit(1); }
let changed = 0;
for (const rel of FILES) {
  const src = join(root, rel);
  const out = join(dest, rel);
  if (!existsSync(src)) { console.log('跳过（源不存在）: ' + rel); continue; }
  const a = readFileSync(src);
  const b = existsSync(out) ? readFileSync(out) : null;
  mkdirSync(dirname(out), { recursive: true });
  if (b && a.equals(b)) { console.log('已是最新: ' + rel); continue; }
  writeFileSync(out, a);
  changed++;
  console.log('已同步: ' + rel);
}
console.log('\n同步完成，共更新 ' + changed + ' 个文件。重启 deploy-live 服务后生效。');