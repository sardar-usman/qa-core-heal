import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT ?? 4191);

http.createServer((req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];
  const file = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const full = path.join(root, file);
  if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(full));
}).listen(port, '127.0.0.1');
