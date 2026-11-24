import { isSqliteBusy } from './db.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import { ADFRAME_HTML } from './preview-snapshot.js';
import { createServer } from 'node:http';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const webFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'],
  ['/app.js', 'app.js'], ['/style.css', 'style.css'], ['/favicon.svg', 'favicon.svg'],
  ['/apple-touch-icon.png', 'apple-touch-icon.png'], ['/icon-192.png', 'icon-192.png'], ['/icon-512.png', 'icon-512.png'],
  ['/manifest.webmanifest', 'manifest.webmanifest']]);
const vietnamTime = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Ho_Chi_Minh',
});

function regionsCooldown(res, resumeAt) {
  return json(res, 409, {
    error: 'Đang tạm nghỉ sau khi Google chặn — thử lại sau ' + vietnamTime.format(new Date(resumeAt)) + '.',
  });
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
    let data = await readFile(file);
    if (name === 'index.html') {
      // Gắn số phiên bản vào app.js/style.css để trình duyệt (nhất là iPhone) luôn tải bản mới sau khi cài.
      const version = async (asset) => {
        try { return Math.round((await stat(join(root, asset))).mtimeMs).toString(36); } catch { return '0'; }
      };
      const [js, css] = await Promise.all([version('app.js'), version('style.css')]);
      data = Buffer.from(String(data).replace('src="/app.js"', `src="/app.js?v=${js}"`)
        .replace('href="/style.css"', `href="/style.css?v=${css}"`));
      headers = { ...headers, 'Cache-Control': 'no-store' };
    }
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(data);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return false;
    throw error;
  }
}

export async function startServer({
  store, port = 4317, host = '127.0.0.1', triggerScan, isScanning, waitForAcquisition = false, lanUrls = () => [], access = null, accessStatus = () => null, readScanProgress = () => null, imagingStatus = () => null,
}) {
  const hasCreativeForProfile = store.hasCreativeForProfile?.bind(store);
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
        const progress = readScanProgress();
        // Tiến độ chỉ có ý nghĩa khi đang quét hoặc vừa xong (≤ 2 phút) để giao diện hiện "Xong".
        const fresh = progress && (active ? !progress.finishedAt
          : progress.finishedAt && Date.now() - Date.parse(progress.finishedAt) < 120_000);
        let images = null;
        try { images = imagingStatus(); } catch {}
        let owners = {};
        try {
          owners = active ? await store.watchOwners?.([scanningWatchId, ...(fresh ? progress.order ?? [] : [])]) ?? {} : {};
        } catch {}
        return json(res, 200, { scanning: active, scanningWatchId, last, lanUrls: lanUrls(),
          ...(Object.keys(owners).length ? { owners } : {}), ...(images ? { images } : {}),
          ...(fresh ? { progress } : {}), ...(accessStatus() ? { gateway: accessStatus() } : {}) });
      }
      if (method === 'GET' && path === '/api/suggest') {
        return json(res, 200, await store.suggest(params.get('q') ?? ''));
      }
      const regionsRoute = path.match(/^\/api\/profiles\/([\w-]+)\/creatives\/([^/]*)\/regions$/);
      const groupRegionsRoute = path.match(/^\/api\/profiles\/([\w-]+)\/watches\/([a-z0-9-]+)\/group-regions$/i);
      if (method === 'POST' && (path === '/api/scan' || regionsRoute || groupRegionsRoute)) {
        let watchId = null;
        let creativeIds;
        let automatic = false;
        let quick = false;
        if (regionsRoute) {
          const [, , creativeId] = regionsRoute;
          if (!/^CR\d+$/.test(creativeId)) return json(res, 409, { error: 'Mã mẫu quảng cáo không hợp lệ.' });
          creativeIds = [creativeId];
          automatic = (await readBody(req, true)).automatic === true;
        } else if (groupRegionsRoute) {
          // Lấy quốc gia cho mọi mẫu của một nhóm (vd. một dự án trong nhà quảng cáo).
          const [, pid, wid] = groupRegionsRoute;
          const { key } = await readBody(req);
          if (typeof key !== 'string' || !key) return json(res, 409, { error: 'Nhóm không hợp lệ.' });
          creativeIds = await store.groupCreativeIds(pid, wid, key);
          if (!creativeIds.length) {
            return json(res, 409, { error: 'Mọi mẫu của nhóm này đã có quốc gia trong 24 giờ qua.' });
          }
        } else {
          const body = await readBody(req, true);
          ({ watchId = null } = body);
          quick = body.quick === true && watchId === null;
          if (watchId !== null && (typeof watchId !== 'string' || !/^[a-z0-9-]+$/i.test(watchId))) {
            throw new Error('Mục theo dõi không hợp lệ.');
          }
        }
        if (await scanning() || scanPending) return json(res, 409, { error: 'Đang có lượt quét.' });
        scanPending = true;
        pendingWatchId = regionsRoute || groupRegionsRoute ? 'regions' : quick ? 'quick' : watchId;
        let validated = false;
        try {
          if (regionsRoute) {
            const [, pid, creativeId] = regionsRoute;
            if (!await hasCreativeForProfile(pid, creativeId)) {
              return json(res, 409, { error: 'Không tìm thấy mẫu quảng cáo trong hồ sơ này.' });
            }
          }
          if (watchId && store.isWatchActive && !await store.isWatchActive(watchId)) {
            throw Object.assign(new Error('Không tìm thấy mục theo dõi.'), { code: 'NOT_FOUND' });
          }
          validated = true;
        } finally {
          if (!validated) {
            scanPending = false;
            pendingWatchId = null;
          }
        }
        const accepted = new Promise((resolve, reject) => {
          let acknowledged = false;
          const acquired = () => {
            acknowledged = true;
            resolve({});
          };
          Promise.resolve().then(() => triggerScan(acquired, watchId, creativeIds, quick ? { quick } : { automatic })).then(acquired, (error) => {
            if (error.code === 'SCAN_BUSY') resolve({ busy: true });
            else if (error.code === 'SCAN_COOLDOWN') resolve({ resumeAt: error.resumeAt });
            else {
              reject(Object.assign(new Error(error.message), { code: 'SCAN_START_FAILED' }));
              if (!waitForAcquisition || acknowledged) console.error('Không thể hoàn tất lượt quét:', error.message);
            }
          }).finally(() => { scanPending = false; pendingWatchId = null; });
          if (!waitForAcquisition) acquired();
        });
        const { busy, resumeAt } = await accepted;
        if (busy) return json(res, 409, { error: 'Đang có lượt quét.' });
        if (resumeAt) return regionsCooldown(res, resumeAt);
        return json(res, 202, { scanning: true });
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

      if (method === 'GET' && path === '/adframe') {
        // Khung vẽ quảng cáo cho bản xem trước trực tiếp (giống /adframe của ATC).
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(ADFRAME_HTML);
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
