const http = require('http'), fs = require('fs'), path = require('path');
// /        -> Electron 版渲染层
// /t/...   -> Tauri 版渲染层
const roots = {
  electron: path.join(__dirname, '..', 'src', 'renderer'),
  tauri: path.join(__dirname, '..', 'tauri', 'ui'),
};
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  let root = roots.electron;
  if (urlPath.startsWith('/t/')) { root = roots.tauri; urlPath = urlPath.slice(2); }
  const f = path.join(root, urlPath);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(5178, () => console.log('preview on http://localhost:5178'));
