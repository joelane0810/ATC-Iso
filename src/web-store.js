import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const readMethods = ['listProfiles', 'getWatchlist', 'getGroups', 'getTrash', 'isWatchActive', 'getScanLog', 'getLastScan', 'getScanningWatchId', 'getSummary', 'getSeries', 'suggest', 'listAdsForProfile', 'imagesDir', 'watchOwners', 'groupCreativeIds'];
const writeMethods = ['addProfile', 'addWatch', 'removeWatch', 'setWatchGroup', 'addGroup', 'renameGroup', 'removeGroup',
  'removeWatches', 'restoreWatches', 'purgeWatches'];

export function createWebStore(root) {
  const worker = new Worker(new URL(import.meta.url), { workerData: root });
  const pending = new Map();
  let nextId = 0;
  let failure;
  function fail(error) {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  worker.on('error', fail);
  worker.on('exit', () => fail(new Error('Không thể mở dữ liệu.')));
  worker.on('message', ({ id, result, error }) => {
    const { resolve, reject } = pending.get(id);
    pending.delete(id);
    if (pending.size === 0) worker.unref();
    if (error) reject(Object.assign(new Error(error.message), error));
    else resolve(result);
  });
  worker.unref();
  const methods = Object.fromEntries([...readMethods, ...writeMethods].map(method => [method, (...args) => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ id, method, args });
    });
  }]));
  return { ...methods, close: () => worker.terminate() };
}

if (!isMainThread) {
  const storeModule = import('./store.js');
  let reader;
  let writer;
  parentPort.on('message', async ({ id, method, args }) => {
    try {
      const { createStore } = await storeModule;
      let result;
      if (readMethods.includes(method)) {
        reader ??= createStore(workerData, { readOnly: true, web: true });
        result = reader.read(() => reader[method](...args));
      } else {
        writer ??= createStore(workerData, { web: true });
        result = writer[method](...args);
      }
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: { message: error.message, code: error.code, errcode: error.errcode } });
    }
  });
}
