import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT ?? 4188);

const handler = (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];
  // Login endpoint: correct credentials grant the session cookie.
  if (urlPath === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (body.includes('admin') && body.includes('secret')) {
        res.writeHead(200, {
          'set-cookie': 'session=valid-token; Path=/',
          'content-type': 'application/json',
        });
        res.end('{"ok":true}');
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"ok":false}');
      }
    });
    return;
  }
  // Auth-gated area: /app 302-redirects to /login unless the session
  // cookie is present (the authenticated-probing scenarios).
  if (urlPath === '/app') {
    if (!/session=valid-token/.test(req.headers.cookie ?? '')) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(root, 'app.html')));
    return;
  }
  if (urlPath === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(root, 'login.html')));
    return;
  }
  const file = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const full = path.join(root, file);
  if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(full));
};

http.createServer(handler).listen(port, '127.0.0.1');
// Second origin (different port) for the third-party iframe widget, like a
// Vercel Live feedback frame.
http.createServer(handler).listen(port + 1, '127.0.0.1');
