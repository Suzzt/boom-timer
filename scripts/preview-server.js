// 单独调爆炸动画用的静态服务器：不用起客户端，浏览器里就能逐帧看。
// 打开 http://localhost:5178/_preview.html
const http = require('http'), fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..', 'ui');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // POST /save?name=xxx —— 预览页把合成好的帧存成图片，用于 README 配图
  if (req.method === 'POST' && urlPath === '/save') {
    const name = (new URL(req.url, 'http://x').searchParams.get('name') || 'frame')
      .replace(/[^\w.-]/g, '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(body);
      if (!m) { res.writeHead(400); return res.end('bad'); }
      const dir = path.join(__dirname, '..', 'assets');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}.${m[1] === 'jpeg' ? 'jpg' : 'png'}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      console.log('已保存', file, (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  const f = path.join(root, urlPath);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(5178, () => console.log('预览地址 http://localhost:5178/_preview.html'));
