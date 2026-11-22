import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const webFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'],
  ['/app.js', 'app.js'], ['/style.css', 'style.css']]);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 16384) chunks.push(chunk);
  }
  if (size > 16384) throw new Error('Thông tin gửi quá dài.');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Thông tin gửi không hợp lệ.');
  }
}

async function serveFile(res, dir, name) {
  const type = contentTypes[extname(name).toLowerCase()];
  if (!type || name !== basename(name) || name.includes('\\')) return false;
  try {
    const root = await realpath(resolve(dir));
    const file = await realpath(join(root, name));
    const path = relative(root, file);
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) return false;
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return false;
    throw error;
  }
}

export async function startServer({
  store, port = 4317, host = '127.0.0.1', triggerScan, isScanning,
}) {
  let scanPending = false;
  const scanning = () => scanPending || isScanning();

  const server = createServer(async (req, res) => {
    const method = req.method;
    try {
      const [path] = req.url.split('?');
      const params = new URL(req.url, 'http://localhost').searchParams;
      if (path === '/api/profiles') {
        if (method === 'GET') return json(res, 200, await store.listProfiles());
        if (method === 'POST') {
          const { name } = await readBody(req);
          if (typeof name !== 'string' || !name.trim()) throw new Error('Vui lòng nhập tên hồ sơ.');
          return json(res, 201, await store.addProfile(name.trim()));
        }
      }
      if (method === 'GET' && path === '/api/status') {
        const [last = null] = await store.getScanLog();
        return json(res, 200, { scanning: scanning(), last });
      }
      if (method === 'POST' && path === '/api/scan') {
        if (scanning()) return json(res, 409, { error: 'Đang có lượt quét.' });
        scanPending = true;
        Promise.resolve().then(triggerScan).catch((error) => {
          console.error('Không thể hoàn tất lượt quét:', error.message);
        }).finally(() => { scanPending = false; });
        return json(res, 202, { scanning: true });
      }

      const profile = path.match(/^\/api\/profiles\/([\w-]+)\/(watchlist|ads)(?:\/([\w.-]+))?$/);
      if (profile) {
        const [, pid, resource, wid] = profile;
        if (resource === 'watchlist') {
          if (method === 'GET' && !wid) return json(res, 200, await store.getWatchlist(pid));
          if (method === 'POST' && !wid) {
            const { input, region = null } = await readBody(req);
            if (typeof input !== 'string' || !input.trim()) {
              throw new Error('Vui lòng nhập tên miền hoặc link nhà quảng cáo.');
            }
            if (region !== null && (!Number.isSafeInteger(region) || region <= 0)) {
              throw new Error('Khu vực không hợp lệ.');
            }
            return json(res, 201, await store.addWatch(pid, input, region));
          }
          if (method === 'DELETE' && wid && wid !== '.' && wid !== '..') {
            await store.removeWatch(pid, wid);
            res.writeHead(204);
            return res.end();
          }
        }
        if (method === 'GET' && resource === 'ads' && !wid) {
          const filters = {
            filter: params.get('filter') || 'all',
            q: params.get('q') || '',
            format: params.get('format') || '',
          };
          return json(res, 200, await store.listAdsForProfile(pid, filters, new Date()));
        }
      }

      if (method === 'GET') {
        const name = webFiles.get(path);
        if (name && await serveFile(res, webDir, name)) return;
        if (path.startsWith('/images/')) {
          let image;
          try {
            image = decodeURIComponent(path.slice('/images/'.length));
          } catch {
            return json(res, 404, { error: 'Không tìm thấy.' });
          }
          if (/^[\w.-]+\.(png|jpe?g)$/i.test(image) &&
              await serveFile(res, await store.imagesDir(), image)) return;
        }
      }
      return json(res, 404, { error: 'Không tìm thấy.' });
    } catch (error) {
      if (error.code) {
        console.error(error);
        return json(res, 500, { error: 'Có lỗi xảy ra. Vui lòng thử lại.' });
      }
      return json(res, 400, { error: error.message });
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  return server;
}
