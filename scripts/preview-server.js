// 单独调爆炸动画用的静态服务器：不用起客户端，浏览器里就能逐帧看。
// 打开 http://localhost:5178/_preview.html
const http = require('http'), fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..', 'tauri', 'ui');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(root, urlPath);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(5178, () => console.log('预览地址 http://localhost:5178/_preview.html'));
