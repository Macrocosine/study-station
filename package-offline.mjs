import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = name => readFile(join(root, 'dist', name), 'utf8');
const [template, css, rawCore, rawSeed, rawApp, svg] = await Promise.all([
  read('index.html'), read('styles.css'), read('core.mjs'),
  read('seed.mjs'), read('app.mjs'), read('icon.svg'),
]);

function removeExports(source) {
  const result = source.replace(/\bexport\s+(?=(?:const|let|var|function|class)\b)/g, '');
  if (/^\s*export\b/m.test(result)) throw new Error('离线打包器遇到了不支持的导出语法。');
  return result;
}

const core = removeExports(rawCore).replace(/\buid\b/g, 'coreUid');
const seed = removeExports(rawSeed);
const app = rawApp.replace(/^import\s+[^;]+;[\t ]*(?:\r?\n|$)/gm, '');
if (/^\s*import\b/m.test(app)) throw new Error('离线打包器遇到了不支持的导入语法。');

const javascript = [core, seed, app].join('\n\n').replace(/<\/script/gi, '<\\/script');
let html = template;
function replaceOnce(pattern, replacement, description) {
  const matches = html.match(new RegExp(pattern.source, 'gi'));
  if (matches?.length !== 1) throw new Error(`需要且仅需要一个${description}，实际找到 ${matches?.length ?? 0} 个。`);
  html = html.replace(pattern, () => replacement);
}

replaceOnce(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*>/i,
  `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`, '样式表链接');
replaceOnce(/<link\b(?=[^>]*\brel=["']icon["'])[^>]*>/i,
  `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}" type="image/svg+xml">`, '图标链接');
replaceOnce(/<script\b(?=[^>]*\bsrc=["']app\.mjs["'])[^>]*>\s*<\/script>/i,
  `<script type="module">\n${javascript}\n</script>`, '应用模块链接');

const destination = join(root, '自习站.html');
await writeFile(destination, html, 'utf8');
console.log(`已生成：${destination}\n大小：${Math.ceil(Buffer.byteLength(html) / 1024)} KB`);
