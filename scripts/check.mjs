// 静态页面自检：不依赖浏览器、不联网，只查「能不能正常打开」这一层。
//
//   node scripts/check.mjs
//
// 检查三件事：
//   1. data/*.json 与 manifest 都是合法 JSON（写坏一个字符，页面就整块空白）
//   2. index.html 里引用的本地资源（css/js/图标）都真的存在
//   3. manifest 里声明的图标文件存在
import { readFileSync, existsSync } from 'node:fs';

const jsonFiles = [
  'data/config.json',
  'data/items.json',
  'data/plan.json',
  'data/schedule.json',
  'manifest.webmanifest',
];

const problems = [];

for (const file of jsonFiles) {
  if (!existsSync(file)) {
    problems.push(`缺少文件：${file}`);
    continue;
  }
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`JSON 格式错误：${file} —— ${err.message}`);
  }
}

const html = readFileSync('index.html', 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)]
  .map((m) => m[1])
  .filter((u) => u && !/^(https?:|data:|mailto:|#)/.test(u));

for (const ref of new Set(refs)) {
  if (!existsSync(ref)) problems.push(`index.html 引用了不存在的资源：${ref}`);
}

const manifest = JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));
for (const icon of manifest.icons || []) {
  const src = String(icon.src || '').replace(/^\.\//, '');
  if (src && !existsSync(src)) problems.push(`manifest 声明的图标不存在：${src}`);
}

if (problems.length) {
  console.error(`✗ 发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `✓ ${jsonFiles.length} 个 JSON 合法，${new Set(refs).size} 个本地引用存在，manifest 图标齐全`
);
