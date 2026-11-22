import { isSqliteBusy } from './db.js';
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

function noContent(res) {
  res.writeHead(204);
  return res.end();
}

async function readBody(req, allowEmpty = false) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 16384) chunks.push(chunk);
  }
  if (size > 16384) throw new Error('Thông tin gửi quá dài.');
  if (allowEmpty && !size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Thông tin gửi không hợp lệ.');
  }
}

async function serveFile(res, dir, name, headers = {}) {
  const type = contentTypes[extname(name).toLowerCase()];
  if (!type || name !== basename(name) || name.includes('\\')) return false;
  try {
    const root = await realpath(resolve(dir));
    const file = await realpath(join(root, name));
    const path = relative(root, file);
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) return false;
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(data);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return false;
    throw error;
  }
}

export async function startServer({
  store, port = 4317, host = '127.0.0.1', triggerScan, isScanning, waitForAcquisition = false, lanUrls = () => [], access = null,
}) {
  const webStore = store.forWeb?.();
  store = webStore ?? store;
  let scanPending = false;
  let pendingWatchId = null;
  const scanning = () => scanPending || isScanning();

  const server = createServer(async (req, res) => {
    const method = req.method;
    if (access && !access.allows(req.socket.remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`ATC Iso chỉ mở cho máy trong mạng ${access.name}.`);
    }
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
        const active = await scanning();
        const last = await store.getLastScan();
        const scanningWatchId = active ? (scanPending ? pendingWatchId : await store.getScanningWatchId()) : null;
        return json(res, 200, { scanning: active, scanningWatchId, last, lanUrls: lanUrls() });
      }
      if (method === 'GET' && path === '/api/suggest') {
        return json(res, 200, await store.suggest(params.get('q') ?? ''));
      }
      if (method === 'POST' && path === '/api/scan') {
        const { watchId = null } = await readBody(req, true);
        if (watchId !== null && (typeof watchId !== 'string' || !/^[a-z0-9-]+$/i.test(watchId))) {
          throw new Error('Mục theo dõi không hợp lệ.');
        }
        if (await scanning() || scanPending) return json(res, 409, { error: 'Đang có lượt quét.' });
        scanPending = true;
        pendingWatchId = watchId;
        if (watchId && store.isWatchActive) {
          try {
            if (!await store.isWatchActive(watchId)) throw Object.assign(
              new Error('Không tìm thấy mục theo dõi.'), { code: 'NOT_FOUND' },
            );
          } catch (error) {
            scanPending = false;
            pendingWatchId = null;
            throw error;
          }
        }
        const accepted = new Promise((resolve, reject) => {
          let acknowledged = false;
          const acquired = () => {
            acknowledged = true;
            resolve(202);
          };
          Promise.resolve().then(() => triggerScan(acquired, watchId)).then(acquired, (error) => {
            if (error.code === 'SCAN_BUSY') resolve(409);
            else {
              reject(Object.assign(new Error(error.message), { code: 'SCAN_START_FAILED' }));
              if (!waitForAcquisition || acknowledged) console.error('Không thể hoàn tất lượt quét:', error.message);
            }
          }).finally(() => { scanPending = false; pendingWatchId = null; });
          if (!waitForAcquisition) acquired();
        });
        const status = await accepted;
        if (status === 409) return json(res, status, { error: 'Đang có lượt quét.' });
        return json(res, status, { scanning: true });
      }

      const profile = path.match(/^\/api\/profiles\/([\w-]+)\/(watchlist|ads|summary|series|groups|trash)(?:\/([\w.-]+))?$/);
      if (profile) {
        const [, pid, resource, wid] = profile;
        if (resource === 'groups') {
          if (method === 'GET' && !wid) return json(res, 200, await store.getGroups(pid));
          if (method === 'POST' && !wid) {
            const { name, kind } = await readBody(req);
            return json(res, 201, await store.addGroup(pid, name, kind));
          }
          if (method === 'PATCH' && wid) {
            const { name } = await readBody(req);
            return json(res, 200, await store.renameGroup(pid, wid, name));
          }
          if (method === 'DELETE' && wid) {
            await store.removeGroup(pid, wid);
            return noContent(res);
          }
        }
        if (resource === 'trash') {
          if (method === 'GET' && !wid) return json(res, 200, await store.getTrash(pid));
          if (method === 'POST' && (wid === 'restore' || wid === 'purge')) {
            const { ids } = await readBody(req);
            if (wid === 'restore') await store.restoreWatches(pid, ids);
            else await store.purgeWatches(pid, ids);
            return noContent(res);
          }
        }
        if (resource === 'watchlist') {
          if (method === 'GET' && !wid) return json(res, 200, await store.getWatchlist(pid));
          if (method === 'POST' && !wid) {
            const { input, region = null, groupId } = await readBody(req);
            if (typeof input !== 'string' || !input.trim()) {
              throw new Error('Vui lòng nhập tên miền hoặc link nhà quảng cáo.');
            }
            if (region !== null && (!Number.isSafeInteger(region) || region <= 0)) {
              throw new Error('Khu vực không hợp lệ.');
            }
            return json(res, 201, await store.addWatch(pid, input, region, undefined, groupId));
          }
          if (method === 'POST' && wid === 'delete') {
            const { ids } = await readBody(req);
            await store.removeWatches(pid, ids);
            return noContent(res);
          }
          if (method === 'PATCH' && wid) {
            const { groupId } = await readBody(req);
            return json(res, 200, await store.setWatchGroup(pid, wid, groupId));
          }
          if (method === 'DELETE' && wid && wid !== '.' && wid !== '..') {
            await store.removeWatch(pid, wid);
            return noContent(res);
          }
        }
        if (method === 'GET' && resource === 'summary' && !wid) {
          return json(res, 200, await store.getSummary(pid, {
            window: params.get('window') ?? 'day', from: params.get('from'), to: params.get('to'),
          }));
        }
        if (method === 'GET' && resource === 'series' && !wid) {
          return json(res, 200, await store.getSeries(pid, {
            watchId: params.get('watchId') || null, group: params.get('group'),
            from: params.get('from'), to: params.get('to'),
            days: params.has('days') ? Number(params.get('days')) : undefined,
          }));
        }
        if (method === 'GET' && resource === 'ads' && !wid) {
          const filters = {
            filter: params.get('filter') || 'all',
            q: params.get('q') || '',
            format: params.get('format') || '',
          };
          if (params.has('watchId')) filters.watchId = params.get('watchId');
          if (params.has('group')) filters.group = params.get('group');
          if (params.has('from')) filters.from = params.get('from');
          if (params.has('to')) filters.to = params.get('to');
          return json(res, 200, await store.listAdsForProfile(pid, filters, new Date()));
        }
      }

      if (method === 'GET') {
        const name = webFiles.get(path);
        if (name && await serveFile(res, webDir, name, { 'Cache-Control': 'no-cache' })) return;
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
      if (isSqliteBusy(error)) {
        return json(res, 503, { error: 'Đang cập nhật dữ liệu, thử lại sau vài giây' });
      }
      if (error.code === 'NOT_FOUND') return json(res, 404, { error: error.message });
      if (error.code) {
        console.error(error);
        return json(res, 500, { error: 'Có lỗi xảy ra. Vui lòng thử lại.' });
      }
      return json(res, 400, { error: error.message });
    }
  });

  if (webStore) server.once('close', () => webStore.close());
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
  } catch (error) {
    await webStore?.close();
    throw error;
  }
  return server;
}
