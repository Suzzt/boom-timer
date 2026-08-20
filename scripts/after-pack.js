'use strict';

/* 打包后裁掉用不到的 Chromium 语言包 —— 220 个语种我们一个也用不上 */

const fs = require('fs');
const path = require('path');

const KEEP = new Set(['en-US', 'en', 'zh-CN', 'zh_CN', 'zh-TW', 'zh_TW']);

function purge(dir, suffix) {
  if (!fs.existsSync(dir)) return 0;
  let freed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue;
    if (KEEP.has(name.slice(0, -suffix.length))) continue;
    const p = path.join(dir, name);
    freed += du(p);
    fs.rmSync(p, { recursive: true, force: true });
  }
  return freed;
}

function du(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, c) => n + du(path.join(p, c)), 0);
}

exports.default = async function afterPack(context) {
  const out = context.appOutDir;
  const app = context.packager.appInfo.productFilename;
  const freed = context.electronPlatformName === 'darwin'
    ? purge(path.join(out, `${app}.app`, 'Contents', 'Frameworks',
        'Electron Framework.framework', 'Versions', 'A', 'Resources'), '.lproj')
    : purge(path.join(out, 'locales'), '.pak');
  console.log(`  • 裁掉多余语言包       freed=${(freed / 1048576).toFixed(1)} MB`);
};
