const byId = (id) => document.getElementById(id);
const profile = byId('profile');
const filter = byId('filter');
const query = byId('query');
const rangeDialog = byId('range-dialog');
const rangeOpen = byId('range-open');
const rangeFrom = byId('range-from');
const rangeTo = byId('range-to');
const calendar = byId('calendar-months');
const calendarJump = byId('calendar-jump');
const rangeStorage = 'atc-iso-date-range';
let rangeChoice;
let watchBounds;
let chartPending = false;
let calendarMonths = [];
let calendarIndex = 0;
let selectingEnd = false;
let draftPreset;
const format = byId('format');
const scan = byId('scan');
const errorMessage = byId('error');
const trashError = byId('trash-error');
const gallery = byId('gallery');
const watchForm = byId('watch-form');
const detail = byId('detail');
const mobileLayout = typeof matchMedia === 'function' ? matchMedia('(width < 1280px)') : null;
let mobilePanel;
let mobilePanelTrigger;
const dateFormat = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh',
});
const formats = { image: 'Hình ảnh', text: 'Chữ', video: 'Video' };
let watchId = '';
let selectedAd;
let regionLookup;
let ads = [];
let rangeAds = [];
let previousRangeAds = null;
let previousRangeLabel = ''; // ads của khoảng ngày liền trước (cùng độ dài) để so sánh
const kindLabels = { competitor: 'Nhà quảng cáo', project: 'Dự án' };
const groupLabels = { increase: 'Chạy thêm ads', decrease: 'Chạy bớt ads', stopped: 'Tắt hết ads', steady: 'Ổn định' };
const watchColors = [
  '#00796b', '#3949ab', '#ad1457', '#8d6e00', '#6a1b9a',
  '#0069a6', '#bf360c', '#33691e', '#455a64', '#c21824',
];
const regionNames = new Intl.DisplayNames('vi', { type: 'region', fallback: 'none' });
const dayMs = 86_400_000;
let overviewFilter = '';
let openGroup;
const renderedGroups = new Map();
let mode = 'groups';
const expandedWatches = new Set();
const expandedLists = new Set();
let suggestionVersion = 0;
let suggestionTimer;
let scanning = false;
let startingScan = false;
let statusVersion = 0;
let scanStatus;
const formatCount = new Intl.NumberFormat('vi-VN');
const vietnamTime = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Ho_Chi_Minh',
});
const shortDate = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh',
});
let suggestionKind;
let summary;
let watchCounts = new Map();
let watches = [];
let watchGroups = [];
let trashedWatches = [];
let managementAvailable = false;
let watchSelection;
let undoNotice;
const trashSelection = new Set();
const collapsedFolders = new Set();
const collapsedOverview = new Set();
let loadVersion = 0;
let pollTimer;

function element(tag, value) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
}

function setMobilePanel(panel, trigger) {
  if (!panel && !mobilePanel) return;
  const drawer = panel === 'watch';
  const detailOpen = panel === 'detail';
  const previousTrigger = mobilePanelTrigger;
  mobilePanel = panel;
  mobilePanelTrigger = trigger;
  byId('watch-menu').setAttribute('aria-expanded', String(drawer));
  byId('watch-panel').setAttribute('data-open', String(drawer));
  byId('detail-panel').setAttribute('data-open', String(detailOpen));
  byId('watch-backdrop').hidden = !drawer;
  byId('topbar').inert = gallery.inert = Boolean(panel);
  document.body.classList.toggle('mobile-panel-open', Boolean(panel));
  if (panel) byId(drawer ? 'watch-menu-close' : 'detail-close').focus();
  else previousTrigger?.focus({ preventScroll: true });
}

byId('watch-menu').onclick = (event) => setMobilePanel('watch', event.currentTarget);
byId('watch-menu-close').onclick = byId('watch-backdrop').onclick =
  byId('detail-close').onclick = () => setMobilePanel();
mobileLayout?.addEventListener('change', () => setMobilePanel());
document.addEventListener?.('keydown', (event) => {
  if (mobilePanel && event.key === 'Escape' && !event.defaultPrevented) setMobilePanel();
});

async function api(path, method = 'GET', data) {
  const options = { method };
  if (data !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  const response = await fetch('/api/' + path, options);
  if (response.status === 204 || response.status === 202) return;
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || 'Có lỗi xảy ra. Vui lòng thử lại.');
    error.status = response.status;
    throw error;
  }
  return body;
}

async function optionalList(path) {
  try {
    return await api(path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function report(error) {
  const target = byId('trash-dialog').open ? trashError : errorMessage;
  target.textContent = error.status ? error.message : 'Không tải được thông tin. Vui lòng thử lại.';
  target.hidden = false;
}

function run(action) {
  errorMessage.hidden = trashError.hidden = true;
  return Promise.resolve().then(action).catch(report);
}

function profilePath(id) {
  return 'profiles/' + encodeURIComponent(id);
}

async function loadProfiles(preferred) {
  const profiles = await api('profiles');
  profile.replaceChildren(...profiles.map(({ id, name }) => new Option(name, id)));
  if (profiles.some(({ id }) => id === preferred)) profile.value = preferred;
  profile.disabled = !profiles.length;
  watchForm.querySelectorAll('input, button').forEach((node) => {
    node.disabled = !profiles.length;
  });
  for (const kind of Object.keys(kindLabels)) byId('add-' + kind).disabled = !profiles.length;
  await selectProfile();
}

async function selectProfile() {
  setMobilePanel();
  watchId = '';
  overviewFilter = '';
  expandedWatches.clear();
  expandedLists.clear();
  suggestionKind = undefined;
  clearSuggestions();
  showWatchType();
  watchBounds = undefined;
  if (rangeDialog.open) rangeDialog.close();
  selectedAd = undefined;
  watches = [];
  watchGroups = [];
  trashedWatches = [];
  managementAvailable = false;
  watchSelection = undefined;
  trashSelection.clear();
  collapsedFolders.clear();
  collapsedOverview.clear();
  for (const kind of Object.keys(kindLabels)) setupGroupEditor(kind);
  if (byId('trash-dialog').open) byId('trash-dialog').close();
  clearUndo();
  ads = [];
  rangeAds = [];
  summary = undefined;
  watchCounts = new Map();
  renderWatches();
  renderAds();
  try { localStorage.setItem('atc-iso-profile', profile.value); } catch {}
  await loadProfileData();
}

async function loadProfileData({ refreshChart = true, reopenGroup = false } = {}) {
  const version = ++loadVersion;
  const id = profile.value;
  if (!id) return;
  const currentWatch = watchId;
  const currentGroup = reopenGroup && openGroup;
  const path = profilePath(id);
  const filters = { filter: filter.value || 'all', q: query.value || '', format: format.value || '' };
  const series = currentWatch && (refreshChart || chartPending || !watchBounds)
    ? loadSeries(path, currentWatch, undefined, rangeChoice?.from ? rangeChoice : null).then(
      (data) => ({ data }), () => ({ error: true }),
    )
    : null;
  if (series) {
    chartPending = true;
    byId('watch-chart').replaceChildren(element('p', 'Đang tải biểu đồ…'));
  }
  const chart = await series;
  if (version !== loadVersion) return;
  if (chart?.data) watchBounds = chart.data;
  const range = rangeChoice?.from ? rangeChoice : null;
  // With no explicit range, the summary reports activity on the latest day
  // and still includes historical totals for each group.
  const adParams = withRange(new URLSearchParams({ watchId: currentWatch }), range);
  const hasGridFilters = mode === 'grid' && (filters.filter !== 'all' || filters.q.trim() || filters.format);
  const previous = currentWatch && range ? previousRangeOf(range) : null;
  // Gọi khoảng liền trước trước tiên để các yêu cầu chính vẫn là yêu cầu cuối cùng.
  const previousRequest = previous
    ? api(path + '/ads?' + withRange(new URLSearchParams({ watchId: currentWatch }), previous)).catch(() => null) : null;
  const [list, data, groups, trash, rangeResults, gridResults, previousResults] = await Promise.all([
    api(path + '/watchlist'), api(path + '/summary?' + withRange(new URLSearchParams(), range)),
    optionalList(path + '/groups'), optionalList(path + '/trash'),
    currentWatch ? api(path + '/ads?' + adParams) : [],
    currentWatch && hasGridFilters
      ? api(path + '/ads?' + new URLSearchParams({ ...Object.fromEntries(adParams), ...filters }))
      : null,
    previousRequest,
  ]);
  if (version !== loadVersion) return;
  summary = data;
  watches = list;
  watchGroups = groups ?? [];
  trashedWatches = trash ?? [];
  managementAvailable = Boolean(groups && trash);
  if (watchSelection) {
    for (const id of watchSelection.ids) {
      if (!list.some((watch) => watch.id === id)) watchSelection.ids.delete(id);
    }
  }
  for (const id of trashSelection) {
    if (!trashedWatches.some((watch) => watch.watchId === id)) trashSelection.delete(id);
  }
  rangeAds = rangeResults.filter((ad) => ad.platform === 'search');
  previousRangeAds = previousResults ? previousResults.filter((ad) => ad.platform === 'search') : null;
  previousRangeLabel = previous ? displayDate(previous.from, shortDate)
    + (previous.from === previous.to ? '' : ' – ' + displayDate(previous.to, shortDate)) : '';
  ads = gridResults ? gridResults.filter((ad) => ad.platform === 'search') : rangeAds;
  watchCounts = new Map(summary.watches.map((watch) => [watch.watchId, watch]));
  if (watchId && !watches.some((watch) => watch.id === watchId)) return chooseWatch('');
  renderWatches();
  renderAds();
  renderScanStatus();
  chartPending = false;
  if (chart?.data) {
    renderChart(byId('watch-chart'), chart.data, watches.find((watch) => watch.id === watchId)?.label);
  } else if (chart?.error) {
    byId('watch-chart').replaceChildren(element('p', 'Không tải được biểu đồ.'));
  }
  if (currentGroup) await renderedGroups.get(currentGroup.watchId)?.get(currentGroup.key)?.onclick();
}

function chooseWatch(id) {
  setMobilePanel();
  ++loadVersion;
  watchBounds = undefined;
  if (rangeDialog.open) rangeDialog.close();
  mode = 'groups';
  watchId = id;
  ads = [];
  rangeAds = [];
  selectedAd = undefined;
  byId('watch-stats').hidden = true;
  if (id) {
    const watch = watches.find((watch) => watch.id === id);
    if (watch) byId('group-' + kindOf(watch)).open = true;
  }
  byId('gallery-heading').focus({ preventScroll: true });
  return run(loadProfileData);
}

function kindOf(watch) {
  return watch.kind ?? 'competitor';
}

function button(label, action, className = '') {
  const node = element('button', label);
  node.type = 'button';
  node.className = className;
  node.onclick = action;
  return node;
}

function inlineActions(host, trigger, label, build) {
  const panel = element('div');
  panel.className = 'inline-actions';
  panel.hidden = true;
  const close = () => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus();
  };
  trigger.setAttribute('aria-expanded', 'false');
  trigger.onclick = () => {
    if (!panel.hidden) return close();
    panel.replaceChildren(...(label ? [element('p', label)] : []), ...build(close));
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  };
  panel.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  host.append(panel);
}

function confirmAction(host, trigger, question, actionLabel, action) {
  inlineActions(host, trigger, question, (close) => [
    button('Huỷ', close), mutationButton(actionLabel, action, 'danger-action'),
  ]);
}

function mutationButton(label, action, className) {
  const control = button(label, () => run(async () => {
    control.disabled = true;
    try { await action(); } finally { control.disabled = false; }
  }), className);
  return control;
}

function watchBuckets(kind) {
  const list = watches.filter((watch) => kindOf(watch) === kind);
  const named = watchGroups.filter((group) => group.kind === kind).map((group) => ({
    ...group, items: list.filter((watch) => watch.groupId === group.id),
  }));
  const ids = new Set(named.map((group) => group.id));
  return [...named, { id: null, name: 'Không nhóm', kind, items: list.filter((watch) => !ids.has(watch.groupId)) }];
}

function groupChoices(kind, choose) {
  return [...watchGroups.filter((group) => group.kind === kind), { id: null, name: 'Không nhóm' }]
    .map(({ id, name }) => mutationButton(name, () => choose(id)));
}

async function editProfile(request, after = () => {}) {
  const id = profile.value;
  await request(profilePath(id));
  if (profile.value !== id) return;
  after();
  await loadProfileData();
}

function groupEditor(host, trigger, kind, group, after) {
  inlineActions(host, trigger, '', (close) => {
    const form = element('form');
    const name = element('input');
    name.required = true;
    name.value = group?.name ?? '';
    name.setAttribute('aria-label', 'Tên nhóm');
    const save = element('button', 'Lưu');
    save.type = 'submit';
    form.append(name, button('Huỷ', close), save);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!name.value.trim() || save.disabled) return;
      save.disabled = true;
      return run(async () => {
        try {
          await editProfile((path) => group
            ? api(path + '/groups/' + encodeURIComponent(group.id), 'PATCH', { name: name.value.trim() })
            : api(path + '/groups', 'POST', { name: name.value.trim(), kind }), after);
        } finally { save.disabled = false; }
      });
    };
    return [form];
  });
}

function moveWatches(ids, groupId) {
  return editProfile(async (path) => {
    const results = await Promise.allSettled(ids.map((id) =>
      api(path + '/watchlist/' + encodeURIComponent(id), 'PATCH', { groupId })));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      if (profilePath(profile.value) === path) await loadProfileData();
      throw failed.reason;
    }
  }, () => { watchSelection = undefined; });
}

function deleteWatches(ids, bulk = false) {
  return editProfile((path) => bulk
    ? api(path + '/watchlist/delete', 'POST', { ids })
    : api(path + '/watchlist/' + encodeURIComponent(ids[0]), 'DELETE'), () => {
    watchSelection = undefined;
    if (ids.includes(watchId)) {
      watchId = '';
      watchBounds = undefined;
      selectedAd = undefined;
    }
    showUndo(ids);
  });
}

function showUndo(ids) {
  const toast = byId('undo-toast');
  const id = profile.value;
  const pending = undoNotice?.profileId === id ? undoNotice.ids : [];
  clearUndo();
  const notice = { profileId: id, ids: [...new Set([...pending, ...ids])] };
  undoNotice = notice;
  toast.replaceChildren(element('span', 'Đã chuyển vào thùng rác ·'),
    mutationButton('Hoàn tác', async () => {
      if (profile.value !== id || undoNotice !== notice) return;
      await editProfile((path) => api(path + '/trash/restore', 'POST', { ids: notice.ids }), () => {
        if (undoNotice === notice) clearUndo();
      });
    }));
  toast.hidden = false;
  notice.timer = setTimeout(clearUndo, 8000);
}

function clearUndo() {
  clearTimeout(undoNotice?.timer);
  undoNotice = undefined;
  byId('undo-toast').hidden = true;
}

function checkbox(label, selected, id, update) {
  const check = element('input');
  check.type = 'checkbox';
  check.checked = selected.has(id);
  check.setAttribute('aria-label', 'Chọn ' + label);
  check.onchange = () => {
    if (check.checked) selected.add(id);
    else selected.delete(id);
    update();
  };
  return check;
}

function renderWatchSelection(kind) {
  const host = byId('selection-' + kind);
  host.replaceChildren();
  if (watchSelection?.kind !== kind) return;
  const ids = [...watchSelection.ids];
  const remove = button('Chuyển vào thùng rác');
  const move = button('Chuyển vào nhóm…');
  remove.disabled = move.disabled = !ids.length;
  host.append(element('p', 'Đã chọn ' + formatCount.format(ids.length)), remove, move,
    button('Huỷ', () => { watchSelection = undefined; renderWatches(); }));
  confirmAction(host, remove, 'Chuyển ' + ids.length + ' mục vào thùng rác?',
    'Chuyển vào thùng rác', () => deleteWatches(ids, true));
  inlineActions(host, move, 'Chuyển vào nhóm…', (close) => [
    ...groupChoices(kind, (id) => moveWatches(ids, id)), button('Huỷ', close),
  ]);
}

function renderWatchItem(watch, kind, management) {
  const item = element('li');
  const row = element('div');
  row.className = 'watch-item';
  const choose = button('', () => chooseWatch(watch.id), 'watch-choice');
  choose.setAttribute('aria-pressed', String(watchId === watch.id));
  const { runningNow = 0, newAds = 0, groups = [] } = watchCounts.get(watch.id) ?? {};
  const counts = element('span');
  counts.className = 'watch-counts';
  // Nhà quảng cáo: số dự án đang chạy. Dự án: số nhà quảng cáo đang chạy (bỏ mẫu chưa rõ tên miền).
  const activeGroups = groups.filter((group) => group.key && group.runningNow > 0).length;
  const groupPill = element('span', formatCount.format(activeGroups)
    + (watch.kind === 'project' ? ' nhà QC' : ' dự án'));
  groupPill.className = 'count-pill count-groups';
  groupPill.title = watch.kind === 'project' ? 'Số nhà quảng cáo đang chạy' : 'Số dự án đang chạy';
  const running = element('span', formatCount.format(runningNow) + ' ads');
  running.className = 'count-pill';
  running.title = 'Số ads đang chạy';
  counts.append(groupPill, running);
  if (newAds > 0) {
    const fresh = element('span', formatCount.format(newAds) + ' ads mới');
    fresh.className = 'count-pill count-new';
    counts.append(fresh);
  }
  choose.append(watchName('strong', watch.label, watch.id), counts);
  const scanWatch = scanButton('⟳', watch.id, 'Quét ' + watch.label);
  scanWatch.className = 'sidebar-scan';
  const selecting = watchSelection?.kind === kind;
  if (selecting) row.append(checkbox(watch.label, watchSelection.ids, watch.id, () => renderWatchSelection(kind)));
  row.append(choose, scanWatch);
  item.append(row);
  if (!management || selecting) return item;
  row.draggable = true;
  row.ondragstart = (event) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-atc-watch', watch.id);
  };
  const menu = button('⋯', undefined, 'watch-item-menu');
  menu.setAttribute('aria-label', 'Tuỳ chọn cho ' + watch.label);
  const remove = button('×', undefined, 'remove-watch');
  remove.setAttribute('aria-label', 'Xoá ' + watch.label);
  row.append(menu, remove);
  inlineActions(item, menu, '', (close) => {
    const options = element('div');
    const move = button('Chuyển vào nhóm…');
    options.append(move);
    inlineActions(options, move, '', (back) => [
      ...groupChoices(kind, (id) => moveWatches([watch.id], id)), button('Huỷ', back),
    ]);
    return [options, button('Đóng', close)];
  });
  confirmAction(item, remove, 'Chuyển ' + watch.label + ' vào thùng rác?',
    'Chuyển vào thùng rác', () => deleteWatches([watch.id]));
  return item;
}

function renderWatchBucket(group, management) {
  const item = element('li');
  const folder = element('details');
  folder.className = 'watch-folder';
  const key = JSON.stringify([group.kind, group.id]);
  folder.open = !collapsedFolders.has(key);
  folder.ontoggle = () => {
    if (folder.open) collapsedFolders.delete(key);
    else collapsedFolders.add(key);
  };
  const title = element('summary', group.name + ' · ' + formatCount.format(group.items.length));
  if (management) {
    folder.ondragover = (event) => {
      if (Array.from(event.dataTransfer.types).includes('application/x-atc-watch')) event.preventDefault();
    };
    folder.ondrop = (event) => {
      event.preventDefault();
      const id = event.dataTransfer.getData('application/x-atc-watch');
      const watch = watches.find((entry) => entry.id === id && kindOf(entry) === group.kind);
      if (watch && (watch.groupId ?? null) !== group.id) return run(() => moveWatches([id], group.id));
    };
  }
  const list = element('ul');
  list.append(...group.items.map((watch) => renderWatchItem(watch, group.kind, management)));
  folder.append(title, list);
  item.append(folder);
  if (management && group.id !== null) {
    const menu = button('⋯', undefined, 'folder-menu');
    menu.setAttribute('aria-label', 'Tuỳ chọn nhóm ' + group.name);
    item.append(menu);
    inlineActions(item, menu, '', (close) => {
      const actions = element('div');
      const rename = button('Đổi tên');
      const remove = button('Xoá nhóm (giữ các mục)');
      actions.append(rename, remove);
      groupEditor(actions, rename, group.kind, group);
      confirmAction(actions, remove, 'Xoá nhóm ' + group.name + ' và giữ các mục?',
        'Xoá nhóm (giữ các mục)', () => editProfile((path) =>
          api(path + '/groups/' + encodeURIComponent(group.id), 'DELETE')));
      return [actions, button('Đóng', close)];
    });
  }
  return item;
}

function renderWatches() {
  const management = managementAvailable && Boolean(profile.value);
  byId('home').setAttribute('aria-pressed', String(!watchId));
  for (const kind of Object.keys(kindLabels)) {
    const buckets = watchBuckets(kind);
    const count = buckets.reduce((total, bucket) => total + bucket.items.length, 0);
    byId('count-' + kind).textContent = formatCount.format(count);
    byId('new-group-' + kind).disabled = !management;
    const select = byId('select-' + kind);
    select.disabled = !management || count === 0;
    select.setAttribute('aria-pressed', String(watchSelection?.kind === kind));
    renderWatchSelection(kind);
    byId('watches-' + kind).replaceChildren(...buckets.map((group) => renderWatchBucket(group, management)));
  }
  byId('trash-open').disabled = !management;
  byId('trash-open').className = trashedWatches.length ? 'has-trash' : '';
  byId('trash-count').textContent = formatCount.format(trashedWatches.length);
  if (byId('trash-dialog').open) renderTrash();
}

function renderTrash() {
  const host = byId('trash-content');
  const controls = element('div');
  const list = element('ul');
  list.className = 'trash-list';
  const update = () => {
    const ids = [...trashSelection];
    const restore = mutationButton('Khôi phục', () => changeTrash('restore', ids));
    const purge = button('Xoá hẳn');
    restore.disabled = purge.disabled = !ids.length;
    controls.replaceChildren(element('span', 'Đã chọn ' + formatCount.format(ids.length)), restore, purge);
    confirmAction(controls, purge, 'Xoá hẳn ' + ids.length + ' mục?', 'Xoá hẳn', () => changeTrash('purge', ids));
  };
  for (const item of trashedWatches) {
    const row = element('li');
    const remaining = Math.max(0, Math.ceil((Date.parse(item.purgeAt) - Date.now()) / dayMs));
    const purge = button('Xoá hẳn');
    row.append(checkbox(item.label, trashSelection, item.watchId, update), element('strong', item.label),
      element('span', kindLabels[kindOf(item)] + ' · Đã xoá ' + displayDate(item.deletedAt)
        + ' · Tự xoá sau ' + formatCount.format(remaining) + ' ngày'),
      mutationButton('Khôi phục', () => changeTrash('restore', [item.watchId])), purge);
    confirmAction(row, purge, 'Xoá hẳn ' + item.label + '?', 'Xoá hẳn', () => changeTrash('purge', [item.watchId]));
    list.append(row);
  }
  update();
  host.replaceChildren(...(trashedWatches.length ? [controls, list] : [element('p', 'Thùng rác trống.')]));
}

function changeTrash(action, ids) {
  return editProfile((path) => api(path + '/trash/' + action, 'POST', { ids }), () => {
    for (const id of ids) trashSelection.delete(id);
    if (undoNotice) {
      undoNotice.ids = undoNotice.ids.filter((id) => !ids.includes(id));
      if (!undoNotice.ids.length) clearUndo();
    }
  });
}

function watchName(tag, label, id) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  const dot = element('span');
  dot.className = 'watch-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.setAttribute('style', '--watch-color: ' + watchColors[(hash >>> 0) % watchColors.length]);
  const name = element(tag);
  name.className = 'watch-name';
  const text = element('span', label);
  text.className = /\s/.test(label) ? 'item-name' : 'item-name unspaced-name';
  name.append(dot, text);
  return name;
}

function badge(label, status) {
  const node = element('span', label);
  node.className = 'badge tone-' + status;
  return node;
}

function regionLabel(iso) {
  if (!/^[A-Z]{2}$/.test(iso ?? '')) return { flag: '🌐', name: 'Chưa rõ quốc gia' };
  const name = regionNames.of(iso);
  if (!name || iso === 'ZZ') return { flag: '🌐', name: 'Chưa rõ quốc gia' };
  const flag = String.fromCodePoint(...Array.from(iso, (letter) => 127397 + letter.charCodeAt(0)));
  return { flag, name };
}

function regionStrip(regions, withCounts = false) {
  const strip = element('span');
  strip.className = 'regions';
  const visible = withCounts ? regions.slice(0, 6) : regions;
  for (const region of visible) {
    const { flag, name } = regionLabel(region.iso);
    const count = withCounts ? ' ' + formatCount.format(region.running) : '';
    const entry = element('span', flag + count);
    entry.title = name + count;
    entry.setAttribute('aria-label', entry.title);
    strip.append(entry);
  }
  if (regions.length > visible.length) {
    strip.append(element('span', '+' + formatCount.format(regions.length - visible.length)));
  }
  return strip;
}

function signed(value) {
  return (value > 0 ? '+' : value < 0 ? '−' : '') + formatCount.format(Math.abs(value));
}

function previewIcon(ad) {
  const icon = element('span', { text: '≡', image: '▧', video: '▷' }[ad.format] || '▧');
  icon.className = 'format-icon';
  return icon;
}

function previewFallback(ad) {
  const placeholder = element('span');
  placeholder.className = 'preview preview-empty';
  const icon = previewIcon(ad);
  icon.setAttribute('aria-hidden', 'true');
  placeholder.append(icon, element('span', 'Chưa có ảnh xem trước'));
  return placeholder;
}

const livePreviews = new Map();
const loadingPreviews = new Map();
const maxLiveLoads = 4;
const previewTimeout = 12_000;

function previewScriptUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.origin !== 'https://displayads-formats.googleusercontent.com' ||
        url.username || url.password || !url.pathname.includes('/content.js')) return null;
    // Keep the original query encoding, including any repeated parameters.
    const keys = ['htmlParentId', 'responseCallback'];
    const query = url.search.slice(1).split('&').filter((part) =>
      part && !keys.some((key) => new URLSearchParams(part).has(key)));
    query.push('htmlParentId=atc-preview', 'responseCallback=atcPreviewReady');
    url.search = '?' + query.join('&');
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function previewDocument(url) {
  const src = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<base href="https://displayads-formats.googleusercontent.com/">
<style>html,body{margin:0;overflow:hidden}</style>
</head><body>
<div id="atc-preview"></div>
<script>
  (() => {
    const target = document.getElementById('atc-preview');
    let dimensions;
    const observer = new MutationObserver(report);
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    function report() {
      if (!dimensions || !target.querySelector(':not(script, style, link, template):not([hidden])')
          && !target.textContent.trim()) return;
      parent.postMessage({ type: 'atc-preview-ready', ...dimensions }, '*');
      observer.disconnect();
    }
    window.atcPreviewReady = ({ previewMetadata } = {}) => {
      const { width, height } = previewMetadata?.[0] ?? {};
      if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return;
      dimensions = { width, height };
      report();
    };
  })();
</script>
<script src="${src}"></script></body></html>`;
}

function fitLivePreview(entry, width) {
  const { box, frame, size, large } = entry;
  if (!size || width <= 0) return;
  const heightLimit = large ? Infinity : width * 3 / 4;
  const scale = Math.min(1, width / size.width, heightLimit / size.height);
  frame.style.transform = 'scale(' + scale + ')';
  if (large) box.style.height = size.height * scale + 'px';
}

function releasePreviewLoad(entry) {
  loadingPreviews.delete(entry.source);
  clearTimeout(entry.timer);
}

function drainPreviews() {
  for (const entry of livePreviews.values()) {
    if (loadingPreviews.size >= maxLiveLoads) break;
    if (!entry.visible || entry.frame || !entry.box.isConnected) continue;
    previewVisibility.unobserve(entry.box);
    const frame = element('iframe');
    frame.title = 'Xem trước mẫu quảng cáo';
    frame.className = 'live-preview-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    if (!entry.large) frame.tabIndex = -1;
    frame.srcdoc = previewDocument(entry.url);
    entry.frame = frame;
    entry.box.append(frame);
    entry.source = frame.contentWindow;
    loadingPreviews.set(entry.source, entry);
    entry.timer = setTimeout(() => {
      releasePreviewLoad(entry);
      livePreviews.delete(entry.box);
      entry.box.replaceWith(preview({ ...entry.ad, image: null, previewUrl: null }, false, entry.large));
      drainPreviews();
    }, previewTimeout);
  }
}

const previewVisibility = typeof IntersectionObserver === 'function' ? new IntersectionObserver((changes) => {
  for (const { target, isIntersecting } of changes) {
    const entry = livePreviews.get(target);
    if (entry) entry.visible = isIntersecting;
  }
  drainPreviews();
}) : null;

const previewSizes = typeof ResizeObserver === 'function' ? new ResizeObserver((changes) => {
  for (const { target, contentRect } of changes) {
    const entry = livePreviews.get(target);
    if (entry) fitLivePreview(entry, contentRect.width);
  }
}) : null;

if (previewVisibility) {
  // Release slots and observers when a view removes cards or replaces the detail.
  new MutationObserver(() => {
    let removed = false;
    for (const entry of livePreviews.values()) {
      if (entry.box.isConnected) continue;
      previewVisibility.unobserve(entry.box);
      previewSizes?.unobserve(entry.box);
      if (loadingPreviews.has(entry.source)) releasePreviewLoad(entry);
      livePreviews.delete(entry.box);
      removed = true;
    }
    if (removed) drainPreviews();
  }).observe(document.body, { childList: true, subtree: true });

  window.addEventListener('message', ({ source, origin, data }) => {
    // Khung xem trước bị cách ly (sandbox, không same-origin) nên có nguồn "null";
    // chỉ nhận tin từ đúng khung mình đã tạo.
    if (origin !== 'null' && origin !== window.location.origin) return;
    if (data?.type !== 'atc-preview-ready') return;
    const entry = loadingPreviews.get(source);
    if (!entry?.box.isConnected) return;
    const { width, height } = data;
    if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return;
    releasePreviewLoad(entry);
    entry.size = { width, height };
    entry.frame.style.width = width + 'px';
    entry.frame.style.height = height + 'px';
    entry.box.classList.add('live-preview-ready');
    if (entry.large) entry.box.classList.add('live-preview-large');
    fitLivePreview(entry, entry.box.clientWidth);
    previewSizes?.observe(entry.box);
    entry.box.firstElementChild.remove();
    drainPreviews();
  });
}

function livePreview(ad, large) {
  const url = previewVisibility && previewScriptUrl(ad.previewUrl);
  if (!url) return previewFallback(ad);
  const box = element('span');
  box.className = 'preview live-preview';
  box.append(element('span', 'Đang tải mẫu…'));
  livePreviews.set(box, { ad, box, large, url });
  previewVisibility.observe(box);
  return box;
}

function preview(ad, thumbnail = false, large = false) {
  const filename = /^(?:images\/)?([\w.-]+\.(?:png|jpe?g|webp|gif|avif))$/i.exec(ad.image || '')?.[1];
  const remote = /^https?:\/\//i.test(ad.imageUrl || '') ? ad.imageUrl : null;
  const local = filename ? '/images/' + encodeURIComponent(filename) : null;
  const fallback = () => {
    if (!thumbnail) return livePreview(ad, large);
    const icon = previewIcon(ad);
    icon.setAttribute('aria-label', formats[ad.format] || 'Mẫu quảng cáo');
    return icon;
  };
  if (!local && !remote) return fallback();

  const image = element('img');
  image.className = 'preview';
  image.alt = thumbnail ? '' : 'Ảnh mẫu quảng cáo';
  image.loading = 'lazy';
  let triedRemote = !local;
  image.onerror = () => {
    if (remote && !triedRemote) {
      triedRemote = true;
      image.src = remote;
      return;
    }
    if (image.isConnected !== false) image.replaceWith(fallback());
  };
  image.src = local || remote;
  return image;
}

function watchStatCounts(list, project, range) {
  const identities = new Set();
  let unknownDomains = 0;
  let newAds = 0;
  for (const ad of list) {
    const identity = project ? ad.advertiserId || ad.advertiserName?.trim()
      : ad.domain?.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (identity) identities.add(identity);
    else if (!project) unknownDomains++;
    const first = dateInVietnam(ad.firstShown);
    if (first && (!range || (first >= range.from && first <= range.to))) newAds++;
  }
  return { groups: identities.size, ads: list.length, newAds, unknownDomains };
}

function renderWatchStats(watch) {
  const stats = byId('watch-stats');
  stats.hidden = !watch;
  if (!watch) return;
  const kind = kindOf(watch);
  const project = kind === 'project';
  const range = isAllTime() ? null : activeRange();
  const now = watchStatCounts(rangeAds, project, range);
  // So với khoảng liền trước cùng độ dài (Hôm nay ↔ Hôm qua, 7 ngày ↔ 7 ngày trước…).
  const before = range && previousRangeAds ? watchStatCounts(previousRangeAds, project, previousRangeOf(range)) : null;
  byId('watch-stats-cards').replaceChildren(...[
    [project ? 'Nhà quảng cáo' : 'Dự án', 'groups'],
    ['Ads', 'ads'],
    ['Ads mới', 'newAds'],
  ].map(([label, key]) => {
    const card = element('div');
    card.className = 'total tone-' + kind;
    card.setAttribute('data-label', label);
    card.append(element('span', label), element('strong', formatCount.format(now[key])));
    if (before) {
      const change = now[key] - before[key];
      const delta = element('small', (change > 0 ? '+' : change < 0 ? '−' : '±') + formatCount.format(Math.abs(change))
        + ' so với ' + previousRangeLabel);
      delta.className = 'stat-delta ' + (change > 0 ? 'delta-up' : change < 0 ? 'delta-down' : 'delta-flat');
      card.append(delta);
    }
    return card;
  }));
  const note = byId('watch-stats-unknown');
  note.hidden = !now.unknownDomains;
  note.textContent = '+' + formatCount.format(now.unknownDomains) + ' ads chưa rõ tên miền';
}

function renderAds() {
  const keepRegionDetail = regionLookup?.pid === profile.value
    && selectedAd?.creativeId === regionLookup.creativeId ? selectedAd : null;
  closeGroup();
  renderedGroups.clear();
  renderRangeControl();
  const watch = watches.find(({ id }) => id === watchId);
  renderWatchStats(watch);
  byId('overview').hidden = Boolean(watch);
  byId('watch-view').hidden = !watch;
  if (watch) {
    byId('scan-watch').onclick = () => startScan(watch.id);
    byId('group-view').hidden = mode !== 'groups';
    byId('grid-view').hidden = mode !== 'grid';
    for (const view of ['groups', 'grid']) {
      byId('mode-' + view).setAttribute('aria-pressed', String(mode === view));
    }
    if (mode === 'groups') renderWatchGroups();
    const visible = mode === 'grid' ? ads : [];
    selectedAd = keepRegionDetail ?? visible.find((ad) => ad.creativeId === selectedAd?.creativeId);
    const domain = watch.type === 'domain' ? watch.value : visible.find((ad) => ad.domain)?.domain;
    byId('gallery-heading').textContent = watch.label;
    byId('gallery-summary').textContent = domain || '';
    byId('empty').hidden = visible.length > 0;
    byId('empty').textContent = 'Chưa có mẫu phù hợp.';
    renderGrid(byId('ads'), visible);
  } else {
    selectedAd = undefined;
    renderOverview();
  }
  if (keepRegionDetail) selectedAd = keepRegionDetail;
  else showDetail(selectedAd);
}

function renderOverview() {
  byId('gallery-heading').textContent = 'Tổng quan thay đổi';
  byId('gallery-summary').textContent = summary?.dataNote ?? '';
  const allTime = isAllTime();
  const prevFrom = summary?.prevFrom ?? summary?.prevDate;
  const prevTo = summary?.prevTo ?? prevFrom;
  byId('comparison').textContent = !allTime && prevFrom ? 'So với ' + displayDate(prevFrom, shortDate)
    + ' – ' + displayDate(prevTo, shortDate) : '';
  byId('comparison-note').hidden = !allTime;
  byId('totals').className = allTime ? 'totals' : 'totals overview-totals';
  if (allTime) {
    byId('totals').replaceChildren(...[
      ['Tổng ads trong dữ liệu', summary?.watches.reduce((sum, watch) => sum + totalWatchAds(watch), 0) ?? 0, 'running'],
      ['Ads đang chạy', summary?.totals.runningAds ?? 0, 'new'],
    ].map(([label, count, tone]) => {
      const card = element('div');
      card.className = 'total tone-' + tone;
      if (tone === 'new') card.title = 'Ads đang chạy trong ngày dữ liệu mới nhất';
      card.setAttribute('data-label', label);
      card.append(element('span', label), element('strong', formatCount.format(count)));
      return card;
    }));
    renderOverviewWatches();
    return;
  }
  const comparisonDates = prevFrom
    ? displayDate(prevFrom, shortDate) + (prevTo === prevFrom ? '' : ' – ' + displayDate(prevTo, shortDate))
    : '';
  renderOverviewTotals(summary?.totals, comparisonDates);
  renderOverviewWatches();
}

function signedCount(count) {
  return (count > 0 ? '+' : count < 0 ? '−' : '') + formatCount.format(Math.abs(count));
}

function renderOverviewTotals(totals, comparisonDates) {
  const buttons = new Map();
  // Thẻ số: nhãn · số lớn · đơn vị (đếm cái gì) · thay đổi ads.
  const card = (key, label, tone, symbol, title, value, unit, note, noteTone) => {
    const button = element('button');
    button.type = 'button';
    button.className = 'overview-total tone-' + tone;
    button.title = title;
    button.setAttribute('data-label', label);
    button.setAttribute('aria-pressed', String(overviewFilter === key));
    const icon = element('span', symbol);
    icon.className = 'overview-total-icon';
    icon.setAttribute('aria-hidden', 'true');
    const heading = element('span');
    heading.className = 'overview-total-label';
    heading.append(icon, element('span', label));
    const number = element('strong', value);
    number.className = 'overview-total-number';
    const unitText = element('span', unit);
    unitText.className = 'overview-total-unit';
    button.append(heading, number, unitText);
    if (note) {
      const change = element('small', note);
      change.className = 'overview-total-note' + (noteTone ? ' ' + noteTone : '');
      button.append(change);
    }
    buttons.set(key, button);
    button.onclick = () => {
      overviewFilter = key === 'runningAds' || overviewFilter === key ? '' : key;
      closeGroup();
      showDetail();
      for (const [filter, control] of buttons) {
        control.setAttribute('aria-pressed', String(filter === overviewFilter));
      }
      renderOverviewWatches();
    };
    return button;
  };
  const block = (title, className, ...cards) => {
    const section = element('section');
    section.className = 'overview-total-block ' + className;
    const list = element('div');
    list.className = 'overview-total-rows';
    list.append(...cards);
    section.append(element('h3', title), list);
    return section;
  };
  const count = (value) => value == null ? '—' : formatCount.format(value);
  const delta = totals?.runningAds - totals?.runningAdsPrev;
  const tone = (value) => value > 0 ? 'delta-up' : value < 0 ? 'delta-down' : '';
  const ads = block('Quảng cáo', 'overview-ads',
    card('runningAds', 'Đang chạy', 'running', '●', 'Số quảng cáo có hiển thị trong khoảng ngày đã chọn.',
      count(totals?.runningAds), 'ads',
      comparisonDates && Number.isFinite(delta) ? signedCount(delta) + ' so với ' + comparisonDates : '', tone(delta)),
    card('newAds', 'Mới bắt đầu chạy', 'new', '★', 'Số quảng cáo bắt đầu chạy trong khoảng ngày đã chọn.',
      count(totals?.newAds), 'ads'));
  const newTotal = totals ? (totals.newProjects ?? 0) + (totals.newAdvertisers ?? 0) : null;
  const competitors = block('Đối thủ thay đổi', 'overview-competitors',
    card('newGroups', 'Mới xuất hiện', 'new', '★', 'Dự án và nhà quảng cáo lần đầu xuất hiện trong khoảng ngày đã chọn.',
      count(newTotal), totals ? count(totals.newProjects) + ' dự án · ' + count(totals.newAdvertisers) + ' nhà QC' : ''),
    ...[
      ['increased', 'increase', '↑', 'Số nhà quảng cáo/dự án kỳ này chạy NHIỀU ads hơn kỳ trước.'],
      ['decreased', 'decrease', '↓', 'Số nhà quảng cáo/dự án kỳ này vẫn chạy nhưng ÍT ads hơn kỳ trước.'],
      ['stopped', 'stopped', '■', 'Số nhà quảng cáo/dự án kỳ trước có chạy, kỳ này không còn ads nào.'],
    ].map(([key, status, symbol, hint]) => {
      const { advertiser = 0, domain = 0 } = totals?.byType?.[key] ?? {};
      const unit = advertiser && domain ? formatCount.format(advertiser) + ' nhà QC · ' + formatCount.format(domain) + ' dự án'
        : advertiser ? 'nhà quảng cáo' : domain ? 'dự án' : 'nhà QC / dự án';
      const change = totals?.[key + 'Ads'];
      return card(key, groupLabels[status], status, symbol, hint, count(totals?.[key]), unit,
        change == null ? '' : signedCount(change) + ' ads', tone(change));
    }));
  byId('totals').replaceChildren(ads, competitors);
}

function matchesTotal(group) {
  switch (overviewFilter) {
    case 'newGroups': return group.status === 'new';
    case 'newAds': return group.newAds > 0;
    case 'increased': return group.status === 'increase';
    case 'decreased': return group.status === 'decrease';
    case 'stopped': return group.status === 'stopped';
    default: return true;
  }
}

function totalWatchAds(watch) {
  return watch.groups.reduce((sum, group) => sum + group.totalAds, 0);
}

function renderOverviewWatches() {
  renderedGroups.clear();
  const allTime = isAllTime();
  const table = element('table');
  table.className = 'overview-table';
  const heading = element('tr');
  const labels = allTime
    ? ['Mục theo dõi', 'Loại', 'Tổng ads trong dữ liệu', 'Ads đang chạy (ngày dữ liệu mới nhất)', 'Quét']
    : ['Mục theo dõi', 'Loại', 'Đang chạy (±)', 'Mới', 'Xu hướng', 'Quét'];
  heading.append(...labels.map((label) => {
    const cell = element('th', label);
    cell.setAttribute('scope', 'col');
    return cell;
  }));
  const head = element('thead');
  head.append(heading);
  const body = element('tbody');
  table.append(head, body);
  const entries = new Map((summary?.watches ?? []).map((watch) => [watch.watchId, watch]));
  for (const kind of Object.keys(kindLabels)) {
    for (const folder of watchBuckets(kind)) {
      const rows = folder.items.map(({ id }) => entries.get(id)).filter(Boolean).map((watch) => ({
        watch, groups: watch.groups.filter(matchesTotal),
      })).filter(({ groups }) => !overviewFilter || groups.length);
      if (!rows.length) continue;
      const key = JSON.stringify([kind, folder.id]);
      const header = element('tr');
      header.className = 'overview-folder kind-' + kind;
      const cell = element('td');
      cell.setAttribute('colspan', labels.length);
      const open = !collapsedOverview.has(key);
      const total = (amount) => formatCount.format(rows.reduce((sum, { watch }) => sum + amount(watch), 0));
      const label = [folder.name + ' · ' + kindLabels[kind], rows.length + ' mục',
        total((watch) => watch.runningNow) + ' ads đang chạy',
        allTime ? total(totalWatchAds) + ' ads trong dữ liệu' : total((watch) => watch.newAds) + ' ads mới',
      ].join(' · ');
      const content = rows.map(({ watch, groups }) => overviewWatchRows(watch, groups, labels.length, allTime));
      const update = (expanded) => {
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = (expanded ? '▾ ' : '▸ ') + label;
        for (const [watch, row, panel] of content) {
          row.hidden = !expanded;
          panel.hidden = !expanded || !expandedWatches.has(watch.watchId);
        }
      };
      const toggle = button('', () => {
        if (collapsedOverview.has(key)) collapsedOverview.delete(key);
        else {
          collapsedOverview.add(key);
          if (content.some(([watch]) => watch.watchId === openGroup?.watchId)) {
            closeGroup();
            showDetail();
          }
        }
        update(!collapsedOverview.has(key));
      }, 'watch-toggle');
      update(open);
      cell.append(toggle);
      header.append(cell);
      body.append(header, ...content.flatMap(([, ...pair]) => pair));
    }
  }
  const message = overviewFilter ? 'Không có mục phù hợp.'
    : profile.value ? 'Chưa có mục theo dõi.' : 'Thêm hồ sơ để bắt đầu theo dõi.';
  byId('overview-watches').replaceChildren(body.children.length ? table : element('p', message));
}

function overviewWatchRows(watch, groups, columns, allTime) {
  const row = element('tr');
  row.className = 'overview-card';
  const expansion = element('tr');
  expansion.className = 'overview-expansion';
  const panel = element('td');
  panel.setAttribute('colspan', columns);
  expansion.append(panel);
  const open = expandedWatches.has(watch.watchId);
  expansion.hidden = !open;
  const toggle = element('button');
  toggle.type = 'button';
  toggle.className = 'watch-toggle';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.append(element('span', open ? '▾' : '▸'), watchName('strong', watch.label, watch.watchId));
  const update = () => {
    closeGroup();
    showDetail();
    const expanded = !expandedWatches.has(watch.watchId);
    if (expanded) expandedWatches.add(watch.watchId);
    else expandedWatches.delete(watch.watchId);
    toggle.children[0].textContent = expanded ? '▾' : '▸';
    toggle.setAttribute('aria-expanded', String(expanded));
    expansion.hidden = !expanded;
    if (expanded) fillOverviewGroups(panel, watch, groups);
  };
  toggle.onclick = update;
  row.onclick = (event) => {
    if (!event.target.closest('button')) update();
  };
  const kind = kindOf(watch);
  const type = element('span', kindLabels[kind]);
  type.className = 'kind-chip kind-' + kind;
  const running = element('strong', formatCount.format(watch.runningNow));
  running.setAttribute('data-label', 'đang chạy');
  const counts = element('span');
  counts.className = 'overview-counts';
  counts.append(running);
  if (!allTime) {
    const arrow = watch.delta > 0 ? '▲ ' : watch.delta < 0 ? '▼ ' : '';
    const delta = element('span', arrow + signed(watch.delta));
    delta.className = watch.delta > 0 ? 'delta-up' : watch.delta < 0 ? 'delta-down' : 'delta-steady';
    delta.setAttribute('data-label', watch.delta === 0 ? ' (±' : ' (');
    counts.append(delta);
  }
  const scan = scanButton('⟳ Quét', watch.watchId, 'Quét ' + watch.label);
  scan.className = 'overview-scan';
  scan.setAttribute('data-label', '⟳');
  const values = [
    toggle, type,
    ...(allTime ? [formatCount.format(totalWatchAds(watch)), counts]
      : [counts, formatCount.format(watch.newAds), sparkline(watch.spark)]),
    scan,
  ];
  const fields = allTime
    ? ['name', 'kind', 'total', 'running', 'scan']
    : ['name', 'kind', 'running', 'new', 'trend', 'scan'];
  const mobileLabels = { total: 'ads trong dữ liệu', new: 'mới' };
  for (const [index, value] of values.entries()) {
    const cell = element('td');
    const field = fields[index];
    cell.className = 'overview-' + field + '-cell';
    if (mobileLabels[field]) cell.setAttribute('data-label', mobileLabels[field]);
    if (typeof value === 'string') cell.textContent = value;
    else cell.append(value);
    row.append(cell);
  }
  if (open) fillOverviewGroups(panel, watch, groups);
  return [watch, row, expansion];
}

function fillOverviewGroups(panel, watch, groups) {
  const expanded = expandedLists.has(watch.watchId);
  panel.replaceChildren(...(expanded ? groups : groups.slice(0, 5)).map((group) => groupRow(watch, group)));
  if (!groups.length) panel.append(element('p', 'Chưa có mẫu quảng cáo.'));
  if (groups.length <= 5) return;
  const more = element('button', expanded ? 'Thu gọn' : 'Xem thêm');
  more.type = 'button';
  more.onclick = () => {
    closeGroup();
    showDetail();
    if (expanded) expandedLists.delete(watch.watchId);
    else expandedLists.add(watch.watchId);
    fillOverviewGroups(panel, watch, groups);
    panel.lastElementChild.focus();
  };
  panel.append(more);
}

function renderWatchGroups() {
  const watch = watchCounts.get(watchId);
  const allTime = isAllTime();
  const sort = byId('group-sort');
  for (const id of ['sort-new', 'sort-change']) {
    byId(id).hidden = byId(id).disabled = allTime;
  }
  byId('sort-total').hidden = byId('sort-total').disabled = !allTime;
  if ((allTime && ['newAds', 'delta'].includes(sort.value)) || (!allTime && sort.value === 'totalAds')) {
    sort.value = 'runningNow';
  }
  const key = sort.value || 'runningNow';
  const groups = (watch?.groups ?? []).filter((group) => allTime
    || group.runningNow > 0 || group.runningPrev > 0 || group.newAds > 0);
  // Số ads của nhóm: đang chạy trong khoảng ngày, hoặc tổng ads khi xem "Mọi lúc".
  const adsOf = (group) => allTime ? group.totalAds : group.runningNow;
  const started = (group) => Date.parse(group.firstShown) || 0;
  const compare = {
    name: () => 0,
    mostAds: (a, b) => adsOf(b) - adsOf(a),
    fewestAds: (a, b) => adsOf(a) - adsOf(b),
    oldest: (a, b) => (started(a) || Infinity) - (started(b) || Infinity),
    newest: (a, b) => started(b) - started(a),
  }[key] ?? ((a, b) => b[key] - a[key]);
  groups.sort((a, b) => compare(a, b) || a.name.localeCompare(b.name, 'vi'));
  byId('watch-groups').replaceChildren(...(groups.length
    ? groups.map((group) => groupRow(watch, group))
    : [element('p', 'Chưa có mẫu quảng cáo.')]));
}

function groupRow(watch, group) {
  const row = element('button');
  row.type = 'button';
  row.className = 'group-row';
  row.setAttribute('aria-expanded', 'false');
  if (!renderedGroups.has(watch.watchId)) renderedGroups.set(watch.watchId, new Map());
  renderedGroups.get(watch.watchId).set(group.key, row);
  const heading = element('span');
  heading.className = 'group-heading';
  if (!isAllTime()) heading.append(badge(group.status === 'new' ? (group.groupType === 'advertiser' ? 'Nhà quảng cáo mới' : 'Dự án mới') : groupLabels[group.status], group.status));
  const name = element('strong', group.name);
  name.className = /\s/.test(group.name) ? 'item-name' : 'item-name unspaced-name';
  heading.append(name);
  const counts = element('span');
  counts.className = 'group-counts';
  if (isAllTime()) {
    counts.append(element('span', 'Tổng ads trong dữ liệu ' + formatCount.format(group.totalAds)),
      element('span', 'Ads đang chạy (ngày dữ liệu mới nhất) ' + formatCount.format(group.runningNow)));
  } else {
    counts.append(element('span', formatCount.format(group.runningPrev) + ' → ' + formatCount.format(group.runningNow)),
      badge(signed(group.delta), group.delta > 0 ? 'increase' : group.delta < 0 ? group.status : 'steady'),
      element('span', formatCount.format(group.newAds) + ' ads mới'));
  }
  const samples = element('span');
  samples.className = 'group-samples';
  samples.setAttribute('aria-hidden', 'true');
  for (const ad of group.sampleAds.filter((ad) => ad.platform === 'search').slice(0, 4)) samples.append(preview(ad, true));
  row.append(heading, counts, regionStrip(group.regions, true), samples);
  const wrapper = element('div');
  const panel = element('div');
  panel.className = 'group-ads';
  panel.hidden = true;
  const controls = element('div');
  controls.className = 'group-controls';
  controls.append(row);
  const input = group.key.replace(/^(?:advertiser|domain):/, '');
  if (!group.followed && input) {
    const follow = element('button', 'Theo dõi');
    follow.type = 'button';
    follow.onclick = () => run(async () => {
      follow.disabled = true;
      try {
        await addWatch(input, group.groupType === 'advertiser' ? 'competitor' : 'project', null);
      } finally {
        follow.disabled = false;
      }
    });
    controls.append(follow);
  }
  wrapper.append(controls, panel);
  row.onclick = () => {
    const alreadyOpen = openGroup?.row === row;
    closeGroup();
    if (!regionLookup || regionLookup.pid !== profile.value || regionLookup.creativeId !== selectedAd?.creativeId) {
      selectedAd = undefined;
      showDetail();
    }
    if (alreadyOpen) return;
    const request = { row, panel, watchId: watch.watchId, key: group.key };
    openGroup = request;
    row.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    const message = element('p', 'Đang tải mẫu…');
    message.setAttribute('role', 'status');
    panel.append(message);
    return loadGroupAds(request, group.name, message);
  };
  return wrapper;
}

function closeGroup() {
  if (!openGroup) return;
  selectedAd = undefined;
  openGroup.row.setAttribute('aria-expanded', 'false');
  openGroup.panel.hidden = true;
  openGroup.panel.replaceChildren();
  openGroup = undefined;
}

async function loadGroupAds(request, name, message) {
  const { watchId: id, key } = request;
  const range = activeRange();
  const params = withRange(new URLSearchParams({ filter: 'all', watchId: id, group: key }), isAllTime() ? null : range);
  const path = profilePath(profile.value);
  const chart = element('div', 'Đang tải biểu đồ…');
  request.panel.replaceChildren(chart, message);
  const graph = loadSeries(path, id, key, range).then((series) => {
    if (openGroup === request) renderChart(chart, series, name);
  }).catch(() => {
    if (openGroup === request) chart.textContent = 'Không tải được biểu đồ.';
  });
  try {
    const results = await api(path + '/ads?' + params);
    if (openGroup !== request) return;
    const visible = results.filter((ad) => ad.platform === 'search');
    if (!visible.length) {
      message.textContent = 'Chưa có mẫu phù hợp.';
    } else {
      const grid = element('div');
      grid.className = 'ads';
      renderGrid(grid, visible);
      request.panel.replaceChildren(chart, grid);
    }
  } catch {
    if (openGroup === request) message.textContent = 'Không tải được mẫu. Đóng rồi mở lại để thử lại.';
  }
  await graph;
}

function domainLabel(ad, tag) {
  const label = element(tag, ad.domain || 'Chưa rõ tên miền');
  if (!ad.domain) label.className = 'domain-unknown';
  else if (tag === 'dd' && ad.domainSource === 'ocr') {
    label.append(element('small', ' (đọc từ ảnh)'));
  }
  return label;
}

function renderGrid(grid, visible) {
  grid.replaceChildren(...visible.map((ad) => {
    const button = element('button');
    button.className = 'ad';
    button.type = 'button';
    const info = element('span');
    info.className = 'ad-info';
    const dates = element('span', 'Bắt đầu ' + displayDate(ad.firstShown)
      + ' · Gần nhất ' + displayDate(ad.lastShown));
    dates.className = 'ad-dates';
    info.append(element('strong', ad.advertiserName || ad.domain || 'Chưa rõ'),
      domainLabel(ad, 'span'), dates);
    const badges = element('span');
    badges.className = 'ad-badges';
    if (isNewAd(ad)) badges.append(badge('Mới', 'new'));
    if (isRunningAd(ad) === false) badges.append(badge('Đã dừng', 'stopped'));
    info.append(badges);
    if (ad.regions?.length) info.append(regionStrip(ad.regions));
    button.append(preview(ad), info);
    button.setAttribute('aria-pressed', String(ad === selectedAd));
    button.onclick = () => {
      gallery.querySelector('.ad[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      selectedAd = ad;
      showDetail(ad);
      if (mobileLayout?.matches) setMobilePanel('detail', button);
      else detail.parentElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    return button;
  }));
}

function displayDate(value, formatter = dateFormat) {
  const time = value ? +new Date(value) : NaN;
  return Number.isFinite(time) ? formatter.format(time) : 'Chưa rõ';
}

function isNewAd(ad) {
  if (typeof ad.isNew === 'boolean') return ad.isNew;
  return dateInVietnam(ad.firstShown) === summary?.refDate && Boolean(summary?.refDate);
}

function dateInVietnam(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(+date)) return '';
  const parts = dateFormat.formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return [part('year'), part('month'), part('day')].join('-');
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function shiftDate(date, days) {
  return new Date(Date.parse(date) + days * dayMs).toISOString().slice(0, 10);
}

function dateBounds() {
  const ref = watchBounds?.refDate ?? summary?.refDate;
  const min = watchBounds ? watchBounds.minDate : summary?.minDate;
  return ref ? { from: min && min <= ref ? min : ref, to: ref } : null;
}

function previousRangeOf(range) {
  const days = Math.round((Date.parse(range.to + 'T00:00:00Z') - Date.parse(range.from + 'T00:00:00Z')) / 86_400_000) + 1;
  const to = shiftDate(range.from, -1);
  return { from: shiftDate(to, -(days - 1)), to };
}

function isAllTime() {
  return rangeChoice === 'all' || (!rangeChoice && Boolean(watchId));
}

function activeRange() {
  if (rangeChoice?.from) return rangeChoice;
  const bounds = dateBounds();
  if (!bounds || watchId || rangeChoice === 'all') return bounds;
  return { from: bounds.to, to: bounds.to };
}

function withRange(params, range) {
  if (range) {
    params.set('from', range.from);
    params.set('to', range.to);
  }
  return params;
}

function dateText(date, includeYear = true) {
  const [year, month, day] = date.split('-');
  return Number(day) + ' thg ' + Number(month) + (includeYear ? ', ' + year : '');
}

function rangeText(range) {
  const { from, to } = range;
  if (from === to) return dateText(to);
  return dateText(from, from.slice(0, 4) !== to.slice(0, 4)) + ' – ' + dateText(to);
}

function parseDateText(value) {
  const input = value.trim().toLowerCase();
  const parts = /^(\d{1,2})\s+thg\s+(\d{1,2})\s*,\s*(\d{4})$/.exec(input);
  const date = parts ? [parts[3], parts[2].padStart(2, '0'), parts[1].padStart(2, '0')].join('-') : input;
  return validDate(date) ? date : '';
}

const rangePresets = [
  { label: 'Hôm nay', dates: (ref) => [ref, ref] },
  { label: 'Hôm qua', dates: (ref) => { const day = shiftDate(ref, -1); return [day, day]; } },
  { label: '7 ngày qua', chip: '7 ngày', dates: (ref) => [shiftDate(ref, -6), ref] },
  { label: '30 ngày qua', chip: '30 ngày', dates: (ref) => [shiftDate(ref, -29), ref] },
  { label: 'Tháng này', dates: (ref) => [ref.slice(0, 7) + '-01', ref] },
  { label: 'Tháng trước', dates: (ref) => {
    const last = shiftDate(ref.slice(0, 7) + '-01', -1);
    return [last.slice(0, 7) + '-01', last];
  } },
  { label: 'Mọi lúc' },
];

function presetRange(preset, bounds) {
  if (!preset.dates) return bounds;
  const clamp = (date) => date < bounds.from ? bounds.from : date > bounds.to ? bounds.to : date;
  const [from, to] = preset.dates(bounds.to);
  return { from: clamp(from), to: clamp(to) };
}

function matchingPreset(range, bounds, allTime, preferredLabel) {
  if (!range || !bounds) return undefined;
  if (allTime) return rangePresets.at(-1);
  const matches = rangePresets.filter((preset) => {
    if (!preset.dates) return false;
    const { from, to } = presetRange(preset, bounds);
    return range.from === from && range.to === to;
  });
  return matches.find(({ label }) => label === preferredLabel) ?? matches[0];
}

function addPresetButton(container, label, onClick, className = '') {
  const button = element('button', label);
  button.type = 'button';
  button.className = className;
  button.onclick = onClick;
  byId(container).append(button);
  return button;
}

for (const preset of rangePresets) {
  preset.button = addPresetButton('range-presets', preset.label, () => {
    const bounds = dateBounds();
    if (!bounds) return;
    draftPreset = preset;
    const range = presetRange(preset, bounds);
    fillRangeInputs(range);
    scrollToRange(range, bounds);
  });
  if (preset.dates) {
    preset.chipButton = addPresetButton('range-chips', preset.chip ?? preset.label, () => {
      const bounds = dateBounds();
      if (bounds) return applyRange({ ...presetRange(preset, bounds), preset: preset.label });
    }, 'chip');
  }
}

function renderRangeControl() {
  const range = activeRange();
  const bounds = dateBounds();
  const preset = matchingPreset(range, bounds, isAllTime(), rangeChoice?.preset);
  rangeOpen.disabled = !bounds;
  byId('range-value').textContent = preset?.label ?? (range && !isAllTime() ? rangeText(range) : 'Mọi lúc');
  for (const item of rangePresets) {
    if (!item.chipButton) continue;
    item.chipButton.disabled = !bounds;
    item.chipButton.setAttribute('aria-pressed', String(item === preset));
  }
  byId('comparison').hidden = Boolean(watchId);
}

function applyRange(choice) {
  rangeChoice = choice;
  overviewFilter = '';
  try { localStorage.setItem(rangeStorage, JSON.stringify(choice)); } catch {}
  if (rangeDialog.open) rangeDialog.close();
  renderRangeControl();
  return run(() => loadProfileData({ reopenGroup: true }));
}

function monthTitle(month) {
  return 'THG ' + Number(month.slice(5)) + ' ' + month.slice(0, 4);
}

function setCalendarMonth(index, scroll = true) {
  calendarIndex = Math.max(0, Math.min(calendarMonths.length - 1, index));
  const month = calendarMonths[calendarIndex];
  byId('calendar-title').textContent = month.title;
  calendarJump.value = String(calendarIndex);
  byId('calendar-prev').disabled = calendarIndex === 0;
  byId('calendar-next').disabled = calendarIndex === calendarMonths.length - 1;
  if (scroll) calendar.scrollTop = month.section.offsetTop;
}

function paintCalendar() {
  const from = parseDateText(rangeFrom.value);
  const to = parseDateText(rangeTo.value);
  for (const { days } of calendarMonths) {
    for (const [date, button] of days) {
      const start = date === from;
      const end = date === to;
      button.className = (from && to && date >= from && date <= to ? 'in-range ' : '')
        + (start ? 'range-start ' : '') + (end ? 'range-end' : '');
      button.setAttribute('aria-pressed', String(start || end));
    }
  }
  const preset = matchingPreset({ from, to }, dateBounds(), draftPreset === rangePresets.at(-1), draftPreset?.label);
  for (const item of rangePresets) item.button.setAttribute('aria-pressed', String(item === preset));
  byId('range-error').hidden = true;
}

function pickDate(date) {
  draftPreset = undefined;
  const start = parseDateText(rangeFrom.value);
  if (!selectingEnd || !start) {
    rangeFrom.value = dateText(date);
    rangeTo.value = '';
    selectingEnd = true;
  } else {
    rangeFrom.value = dateText(date < start ? date : start);
    rangeTo.value = dateText(date < start ? start : date);
    selectingEnd = false;
  }
  paintCalendar();
}

function buildCalendar(bounds) {
  calendarMonths = [];
  const cursor = new Date(bounds.from.slice(0, 7) + '-01');
  while (cursor.toISOString().slice(0, 7) <= bounds.to.slice(0, 7)) {
    const month = cursor.toISOString().slice(0, 7);
    const offset = (cursor.getUTCDay() + 6) % 7;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    const title = monthTitle(month);
    const section = element('section');
    const grid = element('div');
    grid.className = 'calendar-grid';
    section.append(element('h3', title), grid);
    for (let i = 0; i < offset; i++) grid.append(element('span'));
    const days = [];
    for (let date = month + '-01'; date < cursor.toISOString().slice(0, 10); date = shiftDate(date, 1)) {
      const button = element('button', String(Number(date.slice(8))));
      button.type = 'button';
      button.disabled = date < bounds.from || date > bounds.to;
      button.setAttribute('aria-label', dateText(date));
      const selectedDate = date;
      button.onclick = () => pickDate(selectedDate);
      grid.append(button);
      days.push([date, button]);
    }
    calendarMonths.push({ month, title, section, days });
  }
  calendar.replaceChildren(...calendarMonths.map(({ section }) => section));
  calendarJump.replaceChildren(...calendarMonths.map(({ title }, index) => new Option(title, String(index))));
}

function fillRangeInputs(range) {
  rangeFrom.value = dateText(range.from);
  rangeTo.value = dateText(range.to);
  selectingEnd = false;
  paintCalendar();
}

function scrollToRange(range, bounds) {
  const index = calendarMonths.findIndex(({ month }) => month === range.from.slice(0, 7));
  setCalendarMonth(index < 0 && range.from > bounds.to ? calendarMonths.length - 1 : index);
}

rangeOpen.onclick = () => {
  const bounds = dateBounds();
  if (!bounds) return;
  const range = activeRange();
  draftPreset = matchingPreset(range, bounds, isAllTime(), rangeChoice?.preset);
  buildCalendar(bounds);
  fillRangeInputs(range);
  rangeDialog.showModal();
  scrollToRange(range, bounds);
  rangeFrom.focus({ preventScroll: true });
};

byId('calendar-prev').onclick = () => setCalendarMonth(calendarIndex - 1);
byId('calendar-next').onclick = () => setCalendarMonth(calendarIndex + 1);
calendarJump.onchange = () => setCalendarMonth(Number(calendarJump.value));
calendar.onscroll = () => {
  const next = calendarMonths.findIndex(({ section }) => section.offsetTop > calendar.scrollTop + 8);
  setCalendarMonth(next < 0 ? calendarMonths.length - 1 : Math.max(0, next - 1), false);
};
rangeFrom.oninput = rangeTo.oninput = () => {
  draftPreset = undefined;
  selectingEnd = false;
  paintCalendar();
};
byId('range-cancel').onclick = () => rangeDialog.close();
rangeDialog.onclick = (event) => {
  if (event.target !== rangeDialog) return;
  const { left, right, top, bottom } = rangeDialog.getBoundingClientRect();
  if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) {
    rangeDialog.close();
  }
};
byId('range-form').onsubmit = (event) => {
  event.preventDefault();
  const from = parseDateText(rangeFrom.value);
  const to = parseDateText(rangeTo.value);
  const bounds = dateBounds();
  const error = byId('range-error');
  if (!bounds) return;
  if (!from || !to || from > to || from < bounds.from || to > bounds.to) {
    error.textContent = 'Nhập khoảng ngày từ ' + dateText(bounds.from) + ' đến ' + dateText(bounds.to)
      + ', với ngày bắt đầu trước hoặc bằng ngày kết thúc.';
    error.hidden = false;
    return;
  }
  const range = { from, to };
  if (draftPreset) {
    const expected = presetRange(draftPreset, bounds);
    if (from === expected.from && to === expected.to) {
      return applyRange(draftPreset.dates ? { ...range, preset: draftPreset.label } : 'all');
    }
  }
  return applyRange(range);
};

function isRunningAd(ad) {
  if (typeof ad.isRunning === 'boolean') return ad.isRunning;
  if (!summary?.refDate) return undefined;
  const first = dateInVietnam(ad.firstShown);
  const last = dateInVietnam(ad.lastShown);
  return Boolean(first && last && first <= summary.refDate && last >= summary.refDate);
}

function renderDetailRegions(ad) {
  const regions = ad.regions ?? [];
  detail.append(element('h3', 'Quốc gia hiển thị (' + regions.length + ')'));
  if (regions.length) {
    const cutoff = shiftDate(summary?.refDate || dateInVietnam(new Date()), -1);
    const countries = element('ul');
    countries.className = 'detail-regions';
    const rows = regions.map(region => {
      const lastDay = region.lastShown.slice(0, 10);
      return { ...region, ...regionLabel(region.iso), lastDay, running: lastDay >= cutoff };
    }).sort((a, b) => Number(b.running) - Number(a.running)
      || b.lastDay.localeCompare(a.lastDay) || a.name.localeCompare(b.name, 'vi'));
    for (const { flag, name, firstShown, lastShown, running } of rows) {
      const row = element('li');
      const country = element('span', flag + ' ' + name);
      country.className = 'detail-region-name';
      country.title = name;
      const dates = firstShown ? displayDate(firstShown) + ' → ' + displayDate(lastShown)
        : 'đến ' + displayDate(lastShown);
      const interval = element('span', dates);
      interval.className = 'detail-region-dates';
      const duration = firstShown ? (Date.parse(lastShown) - Date.parse(firstShown)) / dayMs + 1 : 0;
      const count = element('span', duration > 0 ? formatCount.format(duration) + ' ngày' : '');
      count.className = 'detail-region-days';
      const state = badge(running ? 'Đang chạy' : 'Đã dừng', running ? 'new' : 'steady');
      state.className += ' detail-region-status';
      row.append(country, interval, count, state);
      countries.append(row);
    }
    detail.append(countries);
    return;
  }

  const control = element('button', 'Lấy quốc gia');
  control.type = 'button';
  const message = element('p');
  message.className = 'region-lookup-message';
  message.setAttribute('role', 'status');
  const setPending = (active) => {
    control.disabled = active;
    control.textContent = active ? 'Đang lấy quốc gia…' : 'Lấy quốc gia';
    control.className = 'action region-lookup' + (active ? ' region-lookup-pending' : '');
  };
  setPending(regionLookup?.pid === profile.value && regionLookup?.creativeId === ad.creativeId);
  control.onclick = async () => {
    if (regionLookup) {
      message.textContent = 'Đang có lượt quét.';
      return;
    }
    const pid = profile.value;
    const creativeId = ad.creativeId;
    const path = profilePath(pid);
    const stillSelected = () => profile.value === pid && selectedAd?.creativeId === creativeId;
    const lookup = { pid, creativeId, setPending, message };
    regionLookup = lookup;
    setPending(true);
    message.textContent = '';
    try {
      await api(path + '/creatives/' + encodeURIComponent(creativeId) + '/regions', 'POST');
      let status;
      do {
        await new Promise(resolve => setTimeout(resolve, 3000));
        status = await refreshStatus();
      } while (!status || status.scanning);
      await loadProfileData({ refreshChart: false, reopenGroup: Boolean(stillSelected() && openGroup) });
      if (stillSelected()) {
        const matches = candidate => candidate.creativeId === creativeId;
        const updated = rangeAds.find(matches)
          ?? summary?.watches.flatMap(watch => (watch.groups ?? []).flatMap(group => group.sampleAds ?? [])).find(matches)
          ?? (await api(path + '/ads')).find(matches);
        if (stillSelected() && updated) {
          selectedAd = updated;
          regionLookup = undefined;
          showDetail(updated);
        }
      }
    } catch (error) {
      lookup.message.textContent = error.status ? error.message : 'Không tải được thông tin. Vui lòng thử lại.';
    } finally {
      regionLookup = undefined;
      lookup.setPending(false);
    }
  };
  if (control.disabled) Object.assign(regionLookup, { setPending, message });
  detail.append(element('p', 'Chưa có dữ liệu quốc gia cho mẫu này.'), control, message);
}

function showDetail(ad) {
  detail.replaceChildren();
  if (!ad) {
    if (mobilePanel === 'detail') setMobilePanel();
    detail.textContent = 'Chọn một mẫu quảng cáo để xem chi tiết.';
    return;
  }
  const duration = ad.firstShown && ad.lastShown
    ? Math.floor((Date.parse(ad.lastShown) - Date.parse(ad.firstShown)) / dayMs) + 1
    : NaN;
  const fields = element('dl');
  const running = isRunningAd(ad);
  fields.append(element('dt', 'Nhà quảng cáo'), element('dd', ad.advertiserName || 'Chưa rõ'),
    element('dt', 'Website'), domainLabel(ad, 'dd'));
  for (const [label, value] of [
    ['Định dạng', formats[ad.format] || 'Chưa rõ'],
    ['Bắt đầu chạy', displayDate(ad.firstShown)],
    ['Lần chạy gần nhất', displayDate(ad.lastShown)],
    ['Số ngày chạy', duration > 0 ? String(duration) : 'Chưa rõ'],
  ]) {
    fields.append(element('dt', label), element('dd', value));
  }
  const status = element('dd');
  status.append(badge(running === undefined ? 'Chưa rõ' : running ? 'Đang chạy' : 'Đã dừng',
    running === false ? 'stopped' : 'steady'));
  fields.append(element('dt', 'Trạng thái'), status);
  detail.append(preview(ad, false, true), fields);
  renderDetailRegions(ad);
  if (/^https:\/\/adstransparency\.google\.com\/advertiser\//.test(ad.detailsUrl || '')) {
    const actions = element('div');
    actions.className = 'detail-actions';
    const link = element('a', 'Mở trên ATC');
    link.className = 'action';
    link.href = ad.detailsUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const copy = element('button', 'Sao chép link');
    copy.className = 'action';
    copy.setAttribute('aria-live', 'polite');
    copy.onclick = async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(link.href);
        } else {
          // Clipboard access on the local network can be unavailable over HTTP.
          const input = element('textarea');
          input.className = 'copy-source';
          input.value = link.href;
          detail.append(input);
          try {
            input.select();
            if (!document.execCommand('copy')) throw new Error();
          } finally {
            input.remove();
            copy.focus();
          }
        }
        copy.textContent = 'Đã sao chép';
      } catch {
        copy.textContent = 'Không sao chép được';
      }
    };
    actions.append(link, copy);
    detail.append(actions);
  }
  const follow = element('div');
  follow.className = 'detail-follow';
  for (const [kind, value, label] of [
    ['project', ad.domain, ad.domain],
    ['competitor', ad.advertiserId, ad.advertiserName || ad.advertiserId],
  ]) {
    if (!profile.value) continue;
    if (!value) {
      // Mẫu chưa rõ tên miền: vẫn hiện chỗ theo dõi dự án để biết vì sao chưa bấm được.
      if (kind === 'project') {
        const missing = element('button', 'Chưa rõ tên miền — chưa theo dõi dự án được');
        missing.type = 'button';
        missing.className = 'kind-project';
        missing.disabled = true;
        follow.append(missing);
      }
      continue;
    }
    const normalized = (input) => (kind === 'project'
      ? input.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
      : input.toUpperCase());
    const followed = watches.some((watch) => kindOf(watch) === kind && watch.value
      && normalized(watch.value) === normalized(value));
    const noun = kind === 'project' ? 'dự án ' : 'nhà quảng cáo ';
    const action = (followed ? '✓ Đang theo dõi ' : '+ Theo dõi ') + noun + label;
    const add = async (groupId) => {
      await addWatch(value, kind, groupId, true);
    };
    const control = mutationButton(action, () => add(null), 'kind-' + kind);
    control.disabled = followed;
    if (followed) control.setAttribute('aria-label', 'Đang theo dõi ' + label);
    follow.append(control);
    if (!followed && watchGroups.some((group) => group.kind === kind)) {
      inlineActions(follow, control, 'Chọn nhóm cho ' + label, (close) => [
        ...groupChoices(kind, add), button('Huỷ', close),
      ]);
    }
  }
  if (follow.children.length) detail.append(follow);
}

function svgElement(tag, attributes = {}, label) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (label !== undefined) node.textContent = label;
  return node;
}

function sparkline(points) {
  const svg = svgElement('svg', { width: 96, height: 24, class: 'sparkline', role: 'img',
    'aria-label': 'Số ads đang chạy trong phạm vi ngày đã chọn' });
  const max = Math.max(1, ...points.map(({ running }) => running));
  if (points.length === 1) {
    svg.append(svgElement('circle', { cx: 48, cy: 22 - points[0].running * 20 / max, r: 2, class: 'chart-point' }));
  } else if (points.length > 1) {
    svg.append(svgElement('polyline', {
      points: points.map(({ running }, index) =>
        [2 + index * 92 / (points.length - 1), 22 - running * 20 / max].join(',')).join(' '),
    }));
  }
  return svg;
}

function axisScale(points, key, divisions = 4) {
  const max = Math.max(1, ...points.map((point) => point[key]));
  const rawStep = Math.max(1, max / divisions);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((value) => value * magnitude).find((value) => value >= rawStep);
  const ticks = Array.from({ length: Math.ceil(max / step) + 1 }, (_, index) => index * step);
  return { max: ticks.at(-1), ticks };
}

function renderChart(container, series, name) {
  const { points, bucket } = series;
  const range = { from: series.from ?? points[0]?.date, to: series.to ?? series.refDate };
  const header = element('div');
  header.className = 'chart-header';
  const title = [name, range.from && range.to ? rangeText(range) : ''].filter(Boolean).join(' · ');
  header.append(element('h3', title));
  if (bucket === 'week') header.append(element('span', 'theo tuần'));
  const reset = element('button', 'Đặt lại');
  reset.type = 'button';
  reset.disabled = rangeChoice === 'all' || (!rangeChoice && Boolean(watchId));
  reset.onclick = () => applyRange('all');
  header.append(reset);
  if (!points.length) {
    container.replaceChildren(header, element('p', 'Chưa có dữ liệu biểu đồ.'));
    return;
  }

  const labels = ['Ads đang chạy', 'Ads mới'];
  const plot = element('div');
  plot.className = 'chart-plot';
  const table = element('table');
  table.className = 'chart-table';
  const head = element('thead');
  const headings = element('tr');
  for (const label of [bucket === 'week' ? 'Tuần bắt đầu' : 'Ngày', ...labels]) {
    const cell = element('th', label);
    cell.setAttribute('scope', 'col');
    headings.append(cell);
  }
  head.append(headings);
  const body = element('tbody');
  table.append(head, body);
  table.hidden = true;
  const toggle = element('button', 'Xem bảng');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.onclick = () => {
    table.hidden = !table.hidden;
    plot.hidden = !table.hidden;
    toggle.textContent = table.hidden ? 'Xem bảng' : 'Xem biểu đồ';
    toggle.setAttribute('aria-pressed', String(!table.hidden));
  };
  header.append(toggle);

  for (const point of points) {
    const row = element('tr');
    row.append(element('td', displayDate(point.date)), ...['running', 'newAds'].map(
      (key) => element('td', formatCount.format(point[key])),
    ));
    body.append(row);
  }
  container.replaceChildren(header, plot, table);
  const draw = (width) => drawChart(plot, points, bucket, range, labels, width);
  draw(Math.round(plot.getBoundingClientRect().width));
  chartDraws.set(plot, draw);
  chartSizes?.observe(plot);
}

const chartDraws = new WeakMap();
const chartSizes = typeof ResizeObserver === 'function' ? new ResizeObserver((changes) => {
  for (const { target, contentRect } of changes) {
    const width = Math.round(contentRect.width);
    if (width > 0 && width !== Number(target.firstElementChild?.getAttribute('width'))) {
      chartDraws.get(target)?.(width);
    }
  }
}) : null;

if (chartSizes && typeof MutationObserver === 'function') {
  new MutationObserver((changes) => {
    for (const { removedNodes } of changes) {
      for (const node of removedNodes) {
        if (node.isConnected || node.nodeType !== 1) continue;
        if (chartDraws.has(node)) chartSizes.unobserve(node);
        for (const plot of node.querySelectorAll('.chart-plot')) chartSizes.unobserve(plot);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

let pinnedChart;
document.addEventListener?.('pointerdown', (event) => {
  if (pinnedChart && !event.composedPath().includes(pinnedChart.plot)) pinnedChart.clear();
}, true);

function drawChart(plot, points, bucket, range, labels, width) {
  if (width <= 0) return;
  if (pinnedChart?.plot === plot) pinnedChart.clear();
  const runningHeight = 180;
  const newHeight = 90;
  const runningBottom = runningHeight - 8;
  const newBottom = runningHeight + newHeight - 22;
  const left = 56;
  const right = Math.max(left + 1, width - 20);
  const step = (right - left) / points.length;
  const x = (index) => left + (index + .5) * step;
  const svg = svgElement('svg', { width, height: runningHeight + newHeight, class: 'series-chart',
    role: 'group', 'aria-label': labels.join(' và ') });
  const drawAxis = (key, label, top, bottom) => {
    const scale = axisScale(points, key, bottom - top < 80 ? 2 : 4);
    const y = (value) => bottom - value / scale.max * (bottom - top);
    svg.append(svgElement('text', { x: left, y: top - 12, class: 'chart-label' }, label));
    for (const tick of scale.ticks) {
      svg.append(svgElement('line', { x1: left, x2: right, y1: y(tick), y2: y(tick), class: 'axis' }),
        svgElement('text', { x: left - 8, y: y(tick) + 4, 'text-anchor': 'end' }, formatCount.format(tick)));
    }
    return y;
  };
  const runY = drawAxis('running', labels[0], 30, runningBottom);
  const runPoints = points.map(({ running }, index) => [x(index), runY(running)].join(','));
  if (points.length === 1) {
    svg.append(svgElement('circle', { cx: x(0), cy: runY(points[0].running), r: 3, class: 'chart-point' }));
  } else {
    svg.append(svgElement('polygon', { class: 'chart-area',
      points: [[x(0), runningBottom], ...runPoints, [x(points.length - 1), runningBottom]].join(' ') }),
    svgElement('polyline', { class: 'chart-line', points: runPoints.join(' ') }));
  }
  const barY = drawAxis('newAds', labels[1], runningHeight + 28, newBottom);
  const barWidth = Math.min(38, Math.max(1, step - 2));
  for (const [index, point] of points.entries()) {
    const y = barY(point.newAds);
    const barLeft = x(index) - barWidth / 2;
    const barRight = barLeft + barWidth;
    const radius = Math.min(2, barWidth / 2, newBottom - y);
    svg.append(svgElement('path', { class: 'chart-bar', d:
      `M ${barLeft} ${newBottom} V ${y + radius} Q ${barLeft} ${y} ${barLeft + radius} ${y}
       H ${barRight - radius} Q ${barRight} ${y} ${barRight} ${y + radius} V ${newBottom} Z` }));
  }

  const duration = (Date.parse(range.to) - Date.parse(range.from)) / dayMs;
  const tickCount = Math.min(points.length, 8, Math.max(1, Math.floor((right - left) / 65)));
  let previousLabel;
  for (let tick = 0; tick < tickCount; tick++) {
    const index = Math.round(tick * (points.length - 1) / Math.max(1, tickCount - 1));
    const date = points[index].date;
    const anchor = tick === 0 ? 'start' : tick === tickCount - 1 ? 'end' : 'middle';
    const label = duration > 60 ? date.slice(5, 7) + '/' + date.slice(0, 4) : displayDate(date, shortDate);
    if (label === previousLabel) continue;
    previousLabel = label;
    svg.append(svgElement('text', { x: x(index), y: runningHeight + newHeight - 5, 'text-anchor': anchor }, label));
  }

  const selection = svgElement('rect', { y: 30, height: newBottom - 30, class: 'chart-selection', visibility: 'hidden' });
  const highlight = svgElement('line', { y1: 30, y2: newBottom, class: 'chart-highlight', visibility: 'hidden' });
  const hit = svgElement('rect', { x: left, y: 30, width: right - left, height: newBottom - 30,
    class: 'chart-hit', tabindex: 0, 'aria-label': 'Dùng phím mũi tên để xem từng mốc ngày' });
  svg.append(selection, highlight, hit);
  const tooltip = element('div');
  tooltip.className = 'chart-tooltip';
  tooltip.setAttribute('role', 'status');
  tooltip.hidden = true;
  let dragStart;
  let contact;
  let cursor = 0;
  const read = (index) => {
    cursor = index;
    const point = points[index];
    tooltip.textContent = (bucket === 'week' ? 'Tuần từ ' : '') + displayDate(point.date)
      + '\n' + labels[0] + ': ' + formatCount.format(point.running)
      + '\n' + labels[1] + ': ' + formatCount.format(point.newAds);
    tooltip.style.left = x(index) + 'px';
    tooltip.hidden = false;
    tooltip.className = 'chart-tooltip' + (x(index) + tooltip.offsetWidth + 10 > width ? ' tooltip-left' : '');
    highlight.setAttribute('x1', x(index));
    highlight.setAttribute('x2', x(index));
    highlight.setAttribute('visibility', 'visible');
  };
  const clear = () => {
    tooltip.hidden = true;
    highlight.setAttribute('visibility', 'hidden');
    selection.setAttribute('visibility', 'hidden');
    dragStart = undefined;
    contact = undefined;
    if (pinnedChart?.clear === clear) pinnedChart = undefined;
  };
  const indexAt = (event) => {
    const box = svg.getBoundingClientRect();
    const position = event.clientX - box.left;
    return Math.max(0, Math.min(points.length - 1, Math.floor((position - left) / step)));
  };
  hit.onpointermove = (event) => {
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerId !== contact) return;
    const index = indexAt(event);
    read(index);
    if (event.pointerType !== 'mouse' || dragStart === undefined || index === dragStart) {
      selection.setAttribute('visibility', 'hidden');
      return;
    }
    selection.setAttribute('x', x(Math.min(index, dragStart)) - step / 2);
    selection.setAttribute('width', (Math.abs(index - dragStart) + 1) * step);
    selection.setAttribute('visibility', 'visible');
  };
  hit.onpointerdown = (event) => {
    if (event.button !== 0) return;
    pinnedChart?.clear();
    const index = indexAt(event);
    read(index);
    if (event.pointerType !== 'mouse') {
      contact = event.pointerId;
      pinnedChart = { plot, clear };
      return;
    }
    dragStart = index;
    hit.setPointerCapture(event.pointerId);
  };
  hit.onpointerup = (event) => {
    if (event.pointerType !== 'mouse') {
      if (contact !== undefined && event.pointerId === contact) {
        read(indexAt(event));
        contact = undefined;
      }
      return;
    }
    if (dragStart === undefined) return;
    const end = indexAt(event);
    if (end === dragStart) {
      dragStart = undefined;
      selection.setAttribute('visibility', 'hidden');
      return read(end);
    }
    const start = Math.min(dragStart, end);
    const finish = Math.max(dragStart, end);
    const first = points[start].date;
    const last = bucket !== 'week' ? points[finish].date
      : points[finish + 1] ? shiftDate(points[finish + 1].date, -1) : range.to;
    clear();
    return applyRange({ from: first < range.from ? range.from : first, to: last > range.to ? range.to : last });
  };
  hit.onpointerleave = () => {
    if (dragStart === undefined && pinnedChart?.clear !== clear) clear();
  };
  hit.onfocus = () => read(cursor);
  hit.onblur = () => { if (pinnedChart?.clear !== clear) clear(); };
  hit.onpointercancel = hit.onlostpointercapture = (event) => {
    if (event.pointerType === 'mouse' && dragStart !== undefined) clear();
    else if (event.pointerId === contact) contact = undefined;
  };
  hit.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    read(Math.max(0, Math.min(points.length - 1, cursor + (event.key === 'ArrowLeft' ? -1 : 1))));
  };
  plot.replaceChildren(svg, tooltip);
}

function loadSeries(path, id, group, range) {
  const params = withRange(new URLSearchParams({ watchId: id }), range);
  if (group !== undefined) params.set('group', group);
  return api(path + '/series?' + params);
}

function scanButton(label, id, fullLabel) {
  const button = element('button', label);
  button.type = 'button';
  button.setAttribute('aria-label', fullLabel);
  button.setAttribute('data-scan', id ?? '');
  button.title = fullLabel;
  button.disabled = scanning || startingScan;
  const current = scanStatus?.scanningWatchId;
  button.classList?.toggle('is-scanning', Boolean(button.disabled && (current ? id === current : true)));
  button.onclick = () => startScan(id);
  return button;
}

function renderScanStatus() {
  const { last, scanningWatchId } = scanStatus ?? {};
  const label = watches.find(({ id }) => id === scanningWatchId)?.label
    ?? watchCounts.get(scanningWatchId)?.label;
  const labels = { ok: 'Hoàn tất', blocked: 'Bị Google chặn', error: 'Gặp lỗi' };
  let message = labels[last?.status] ?? 'Chưa có lượt quét.';
  const at = (value) => displayDate(value, vietnamTime);
  const resting = last?.resumeAt && Date.parse(last.resumeAt) > Date.now();
  if (last?.status === 'blocked' || last?.status === 'cooldown' || resting) {
    // App tự gửi 1 lần hỏi nhẹ khi hết giờ nghỉ để biết Google đã bỏ chặn chưa.
    message = 'Google đang chặn' + (last.resumeAt ? ' · tự kiểm tra lại lúc ' + at(last.resumeAt) : '');
  } else if (last?.status === 'ok' && last.probe) {
    message = 'Google đã bỏ chặn · kiểm tra lúc ' + at(last.at);
  }
  if (scanning || startingScan) {
    message = scanningWatchId === 'regions' ? 'Đang lấy quốc gia…'
      : 'Đang quét ' + (label || (scanningWatchId ? 'một mục' : 'tất cả')) + '…';
  }
  const active = scanning || startingScan;
  const progress = scanStatus?.progress;
  const states = progress?.watches ?? {};
  const order = progress?.order ?? [];
  if (active && order.length > 1) {
    const done = order.filter(id => ['done', 'blocked', 'error', 'skipped'].includes(states[id]?.state)).length;
    const current = order.find(id => states[id]?.state === 'scanning');
    const name = watches.find(({ id }) => id === current)?.label ?? watchCounts.get(current)?.label;
    message = 'Đang quét ' + (name ? name + ' · ' : '') + done + '/' + order.length + ' mục xong';
  }
  const status = byId('status');
  status.textContent = message;
  status.classList?.toggle('is-scanning', active);
  for (const button of [scan, byId('scan-watch'), ...document.querySelectorAll('[data-scan]')]) {
    if (!button) continue;
    button.disabled = active;
    const target = button === scan ? '' : button === byId('scan-watch') ? watchId : button.getAttribute?.('data-scan');
    // Có tiến độ thì chỉ mục đang quét mới xoay; chưa có thì theo mục được yêu cầu (hoặc tất cả).
    const itemState = target ? states[target]?.state : null;
    const mine = active && target != null && (button === scan ? !scanningWatchId
      : progress ? itemState === 'scanning' : scanningWatchId ? target === scanningWatchId : true);
    button.classList?.toggle('is-scanning', Boolean(mine));
    const row = button.closest?.('.watch-item, .overview-card');
    if (!row || button === scan) continue;
    row.classList?.toggle('row-scanning', Boolean(mine));
    renderItemProgress(row, target ? states[target] : null, active || Boolean(progress));
  }
}

// Dòng tiến độ nhỏ trong từng mục: chờ tới lượt · trang x/y · quốc gia · xong.
function renderItemProgress(row, state, show) {
  // Trong bảng: đặt ngay dưới tên mục (ô đầu tiên), không thêm ô lạ vào cuối hàng.
  const host = row.querySelector?.('.overview-name-cell') ?? row.querySelector?.('.watch-meta') ?? row;
  let box = host.querySelector?.(':scope > .scan-progress');
  if (!show || !state) {
    box?.remove();
    return;
  }
  if (!box) {
    box = element('div');
    box.className = 'scan-progress';
    const bar = element('span');
    bar.className = 'scan-progress-bar';
    bar.append(element('i'));
    box.append(element('small'), bar);
    host.append(box);
  }
  const [text, bar] = box.children;
  let percent = 0;
  let label = '';
  switch (state.state) {
    case 'queued': label = 'Chờ tới lượt'; break;
    case 'scanning':
      if (state.step === 'regions') {
        percent = 70 + 30 * (state.regionsDone ?? 0) / Math.max(1, state.regionsTotal ?? 1);
        label = 'Đang lấy quốc gia ' + (state.regionsDone ?? 0) + '/' + (state.regionsTotal ?? 0);
      } else if (state.step === 'saved') {
        percent = 70;
        label = 'Đang lưu · ' + formatCount.format(state.ads ?? 0) + ' ads';
      } else {
        percent = 70 * (state.page ?? 0) / Math.max(1, state.maxPages ?? 1);
        label = state.page ? 'Trang ' + state.page + ' · ' + formatCount.format(state.ads ?? 0) + ' ads' : 'Đang mở ATC…';
      }
      break;
    case 'done':
      percent = 100;
      label = '✓ Xong' + (state.newAds ? ' · ' + formatCount.format(state.newAds) + ' ads mới' : '');
      break;
    case 'blocked': label = 'Google chặn — dừng quét'; break;
    case 'error': label = 'Gặp lỗi'; break;
    case 'skipped': label = 'Chưa quét lượt này'; break;
  }
  box.dataset.state = state.state;
  bar.children[0].style.width = Math.round(percent) + '%';
  text.textContent = label;
}

function renderLanUrls(urls = []) {
  const box = document.getElementById?.('lan-urls');
  if (!box) return;
  const local = /^(127\.|localhost$|\[::1\]$)/.test(globalThis.location?.hostname ?? '');
  box.hidden = !local || !urls.length;
  box.textContent = urls.length ? 'Máy khác mở: ' + urls.join('  ·  ') : '';
}

function finishedCount(progress) {
  return Object.values(progress?.watches ?? {}).filter(item => item.state === 'done').length;
}

async function refreshStatus(reload = false) {
  clearTimeout(pollTimer);
  const version = ++statusVersion;
  try {
    const result = await api('status');
    if (version !== statusVersion) return;
    const doneBefore = finishedCount(scanStatus?.progress);
    scanStatus = result;
    scanning = result.scanning;
    if (!regionLookup && scanning && finishedCount(result.progress) > doneBefore) await loadProfileData().catch(() => {});
    renderLanUrls(result.lanUrls);
    if (reload) startingScan = false;
    renderScanStatus();
    if (reload && !scanning && !regionLookup) {
      await loadProfileData();
    }
    return result;
  } finally {
    if (version === statusVersion) {
      pollTimer = setTimeout(() => refreshStatus(scanning).catch(report), 5000);
    }
  }
}

function startScan(id) {
  if (scanning || startingScan) return;
  startingScan = true;
  ++statusVersion;
  clearTimeout(pollTimer);
  scanStatus = { ...scanStatus, scanningWatchId: id };
  renderScanStatus();
  return run(async () => {
    try {
      await api('scan', 'POST', id ? { watchId: id } : {});
    } catch (error) {
      if (error.status !== 409) {
        startingScan = false;
        renderScanStatus();
        refreshStatus().catch(report);
        throw error;
      }
    }
    try {
      await refreshStatus(true);
    } catch (error) {
      startingScan = false;
      renderScanStatus();
      throw error;
    }
  });
}

const watchInput = watchForm.elements.input;
function clearSuggestions() {
  clearTimeout(suggestionTimer);
  const list = byId('suggestions');
  list.hidden = true;
  list.replaceChildren();
  return ++suggestionVersion;
}

async function addWatch(input, kind, groupId, keepDetail = false) {
  const id = profile.value;
  if (!id || !input.trim()) return;
  const group = openGroup;
  const ad = selectedAd;
  await api(profilePath(id) + '/watchlist', 'POST', { input: input.trim(), region: null, kind, groupId });
  if (profile.value !== id) return;
  const keep = keepDetail && ad && selectedAd === ad && group === openGroup;
  await loadProfileData({ refreshChart: false, reopenGroup: keep });
  if (keep && group && profile.value === id && openGroup?.watchId === group.watchId && openGroup?.key === group.key) {
    selectedAd = ad;
    showDetail(ad);
  }
}

const watchTypeHint = byId('watch-type-hint');
const suggestionGroups = [
  { type: 'advertiser', kind: 'competitor', title: 'Nhà quảng cáo' },
  { type: 'domain', kind: 'project', title: 'Dự án (tên miền)' },
];

function watchInputType(input) {
  if (/^AR\d+$/i.test(input)) return { type: 'advertiser', value: input.toUpperCase() };
  const address = input.replace(/^\/\//, '');
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : 'https://' + address);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    const domain = url.hostname.replace(/^www\./, '').replace(/\.$/, '');
    const advertiser = url.pathname.match(/\/advertiser\/(AR\d+)(?:\/|$)/i);
    if (domain === 'adstransparency.google.com' && advertiser) {
      return { type: 'advertiser', value: advertiser[1].toUpperCase() };
    }
    if (/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z][a-z\d-]{0,62}$/i.test(domain)) {
      return { type: 'domain', value: domain };
    }
  } catch {}
}

function showWatchType(candidate) {
  const group = suggestionGroups.find(({ type }) => type === candidate?.type);
  watchTypeHint.hidden = !group;
  watchTypeHint.className = group ? 'kind-' + group.kind : '';
  watchTypeHint.textContent = group
    ? 'Sẽ thêm vào ' + kindLabels[group.kind] + ': ' + (candidate.name || candidate.value)
    : '';
}

function renderSuggestions(candidates) {
  const list = byId('suggestions');
  for (const { type, kind, title } of suggestionGroups) {
    if (suggestionKind && suggestionKind !== kind) continue;
    const matches = candidates.filter((candidate) => candidate.type === type);
    if (!matches.length) continue;
    const section = element('section');
    section.className = 'kind-' + kind;
    section.append(element('h2', title));
    for (const candidate of matches) {
      const chip = element('span', kindLabels[kind]);
      chip.className = 'kind-chip';
      const count = element('span', formatCount.format(candidate.ads) + ' mẫu');
      count.className = 'suggestion-count';
      const choice = button('', () => {
        watchInput.value = candidate.value;
        watchInput.focus();
        showWatchType(candidate);
        clearSuggestions();
      });
      choice.append(element('strong', candidate.name || candidate.value), chip, count);
      section.append(choice);
    }
    list.append(section);
  }
  list.hidden = !list.children.length;
}

watchInput.oninput = () => {
  const version = clearSuggestions();
  const input = watchInput.value.trim();
  showWatchType(watchInputType(input));
  if (!input || !profile.value) return;
  suggestionTimer = setTimeout(async () => {
    try {
      const candidates = await api('suggest?' + new URLSearchParams({ q: input }));
      if (version === suggestionVersion) renderSuggestions(candidates);
    } catch {
      if (version === suggestionVersion) clearSuggestions();
    }
  }, 250);
};
watchInput.onfocus = () => showWatchType(watchInputType(watchInput.value.trim()));
watchForm.onkeydown = (event) => {
  if (event.key === 'Escape') {
    clearSuggestions();
    watchInput.focus();
  }
};
watchForm.onfocusout = (event) => {
  if (!watchForm.contains(event.relatedTarget)) {
    suggestionKind = undefined;
    clearSuggestions();
    watchTypeHint.hidden = true;
  }
};

profile.onchange = () => run(selectProfile);
filter.onchange = format.onchange = query.oninput = () => run(() => loadProfileData({ refreshChart: false }));
byId('group-sort').onchange = () => {
  closeGroup();
  showDetail();
  renderWatchGroups();
};
for (const view of ['groups', 'grid']) {
  byId('mode-' + view).onclick = () => {
    if (mode === view) return;
    mode = view;
    ads = [];
    selectedAd = undefined;
    renderAds();
    if (view === 'grid') return run(() => loadProfileData({ refreshChart: false }));
  };
}

byId('profile-form').onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(async () => {
    const { id } = await api('profiles', 'POST', { name: form.elements.name.value });
    form.reset();
    form.parentElement.open = false;
    await loadProfiles(id);
  });
};

byId('trash-open').onclick = () => run(async () => {
  setMobilePanel();
  const id = profile.value;
  const items = await api(profilePath(id) + '/trash');
  if (profile.value !== id || byId('trash-dialog').open) return;
  trashedWatches = items;
  byId('trash-open').className = items.length ? 'has-trash' : '';
  byId('trash-count').textContent = formatCount.format(items.length);
  trashSelection.clear();
  renderTrash();
  byId('trash-dialog').showModal();
});
byId('trash-close').onclick = () => byId('trash-dialog').close();

function setupGroupEditor(kind) {
  const host = byId('group-editor-' + kind);
  host.replaceChildren();
  groupEditor(host, byId('new-group-' + kind), kind, undefined, () => setupGroupEditor(kind));
}

byId('home').onclick = () => chooseWatch('');
for (const kind of Object.keys(kindLabels)) {
  byId('select-' + kind).onclick = () => {
    watchSelection = watchSelection?.kind === kind ? undefined : { kind, ids: new Set() };
    renderWatches();
  };
  byId('add-' + kind).onclick = () => {
    suggestionKind = kind;
    watchInput.focus();
    watchInput.oninput();
  };
}

watchForm.onsubmit = (event) => {
  event.preventDefault();
  const input = watchInput.value;
  clearSuggestions();
  return run(async () => {
    await addWatch(input);
    if (watchInput.value === input) {
      watchInput.value = '';
      suggestionKind = undefined;
      showWatchType();
    }
  });
};

scan.onclick = () => startScan();

try {
  const saved = JSON.parse(localStorage.getItem(rangeStorage));
  if (saved === 'all' || (validDate(saved?.from) && validDate(saved?.to) && saved.from <= saved.to)) {
    rangeChoice = saved;
  }
} catch {}

let preferred;
try { preferred = localStorage.getItem('atc-iso-profile'); } catch {}
run(() => Promise.all([loadProfiles(preferred), refreshStatus()]));
