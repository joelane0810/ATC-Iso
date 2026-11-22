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
const gallery = byId('gallery');
const watchForm = byId('watch-form');
const detail = byId('detail');
const dateFormat = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh',
});
const formats = { image: 'Hình ảnh', text: 'Chữ', video: 'Video' };
let watchId = '';
let selectedAd;
let ads = [];
const kindLabels = { competitor: 'Đối thủ', project: 'Dự án' };
const groupLabels = { increase: 'Tăng', decrease: 'Giảm', stopped: 'Đã dừng', steady: 'Ổn định' };
const overviewTotals = [
  ['newProjects', 'Dự án mới', 'new'], ['newAdvertisers', 'Nhà QC mới', 'new'],
  ['newAds', 'Ads mới', 'new'], ['increased', 'Tăng', 'increase'],
  ['decreased', 'Giảm', 'decrease'], ['stopped', 'Đã dừng', 'stopped'],
  ['runningAds', 'Ads đang chạy', 'steady'],
];
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
let watchKind = 'competitor';
let summary;
let watchCounts = new Map();
let watches = [];
let loadVersion = 0;
let pollTimer;

function element(tag, value) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
}

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

function report(error) {
  errorMessage.textContent = error.status ? error.message : 'Không tải được thông tin. Vui lòng thử lại.';
  errorMessage.hidden = false;
}

function run(action) {
  errorMessage.hidden = true;
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
  watchId = '';
  overviewFilter = '';
  expandedWatches.clear();
  expandedLists.clear();
  clearSuggestions();
  watchBounds = undefined;
  if (rangeDialog.open) rangeDialog.close();
  selectedAd = undefined;
  watches = [];
  ads = [];
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
  const filters = new URLSearchParams({
    filter: filter.value || 'all', q: query.value || '', format: format.value || '', watchId: currentWatch,
  });
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
  const [list, data] = await Promise.all([
    api(path + '/watchlist'), api(path + '/summary?' + withRange(new URLSearchParams(), range)),
  ]);
  if (version !== loadVersion) return;
  summary = data;
  const results = currentWatch && mode === 'grid'
    ? await api(path + '/ads?' + withRange(filters, range))
    : [];
  if (version !== loadVersion) return;
  watches = list;
  ads = results.filter((ad) => ad.platform === 'search');
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
  ++loadVersion;
  watchBounds = undefined;
  if (rangeDialog.open) rangeDialog.close();
  mode = 'groups';
  watchId = id;
  ads = [];
  selectedAd = undefined;
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

function setWatchKind(kind) {
  watchKind = kind;
  for (const value of Object.keys(kindLabels)) {
    byId('kind-' + value).setAttribute('aria-pressed', String(value === kind));
  }
}

function renderWatches() {
  byId('home').setAttribute('aria-pressed', String(!watchId));
  for (const kind of Object.keys(kindLabels)) {
    byId('watches-' + kind).replaceChildren(...watches.filter((watch) => kindOf(watch) === kind).map((watch) => {
      const item = element('li');
      const choose = element('button');
      choose.className = 'watch-choice';
      choose.setAttribute('aria-pressed', String(watchId === watch.id));
      const { runningNow = 0 } = watchCounts.get(watch.id) ?? {};
      const counts = element('span', formatCount.format(runningNow) + ' ads đang chạy');
      counts.className = 'watch-counts';
      choose.append(watchName('strong', watch.label, watch.id), counts);
      choose.onclick = () => chooseWatch(watch.id);
      const remove = element('button', '×');
      remove.className = 'remove-watch';
      remove.setAttribute('aria-label', 'Xoá ' + watch.label);
      remove.title = 'Xoá ' + watch.label;
      remove.onclick = () => run(async () => {
        const id = profile.value;
        await api(profilePath(id) + '/watchlist/' + encodeURIComponent(watch.id), 'DELETE');
        if (profile.value === id) await loadProfileData();
      });
      const scanWatch = scanButton('⟳', watch.id, 'Quét ' + watch.label);
      scanWatch.className = 'sidebar-scan';
      item.append(choose, scanWatch, remove);
      return item;
    }));
  }
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
  name.append(dot, element('span', label));
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

function previewFallback(ad) {
  const placeholder = element('span');
  placeholder.className = 'preview preview-empty';
  const icon = element('span', { text: '≡', image: '▧', video: '▷' }[ad.format] || '▧');
  icon.className = 'format-icon';
  icon.setAttribute('aria-hidden', 'true');
  placeholder.append(icon, element('span', 'Chưa có ảnh xem trước'));
  return placeholder;
}

function preview(ad, thumbnail = false) {
  const filename = /^(?:images\/)?([\w.-]+\.(?:png|jpe?g|webp|gif|avif))$/i.exec(ad.image || '')?.[1];
  const remote = /^https?:\/\//i.test(ad.imageUrl || '') ? ad.imageUrl : null;
  const source = filename ? '/images/' + encodeURIComponent(filename) : remote;
  const fallback = () => thumbnail ? element('span', '▧') : previewFallback(ad);
  if (!source) return fallback();

  const image = element('img');
  image.className = 'preview';
  image.alt = thumbnail ? '' : 'Ảnh mẫu quảng cáo';
  image.loading = 'lazy';
  image.onerror = () => {
    if (remote && image.src !== remote) { image.src = remote; return; }
    image.replaceWith(fallback());
  };
  image.src = source;
  return image;
}

function renderAds() {
  closeGroup();
  renderedGroups.clear();
  renderRangeControl();
  const watch = watches.find(({ id }) => id === watchId);
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
    const status = watchCounts.get(watchId);
    selectedAd = visible.find((ad) => ad.creativeId === selectedAd?.creativeId);
    const domain = watch.type === 'domain' ? watch.value : visible.find((ad) => ad.domain)?.domain;
    byId('gallery-heading').textContent = watch.label;
    byId('gallery-summary').textContent = [
      domain,
      formatCount.format(status?.runningNow ?? 0) + ' ads đang chạy',
    ].filter(Boolean).join(' · ');
    byId('empty').hidden = visible.length > 0;
    byId('empty').textContent = 'Chưa có mẫu phù hợp.';
    renderGrid(byId('ads'), visible);
  } else {
    selectedAd = undefined;
    renderOverview();
  }
  showDetail(selectedAd);
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
  if (allTime) {
    byId('totals').replaceChildren(...[
      ['Tổng ads trong dữ liệu', summary?.watches.reduce((sum, watch) => sum + totalWatchAds(watch), 0) ?? 0],
      ['Ads đang chạy (ngày dữ liệu mới nhất)', summary?.totals.runningAds ?? 0],
    ].map(([label, count]) => {
      const card = element('div');
      card.className = 'total tone-steady';
      card.append(element('span', label), element('strong', formatCount.format(count)));
      return card;
    }));
    renderOverviewWatches();
    return;
  }
  byId('totals').replaceChildren(...overviewTotals.map(([key, label, tone]) => {
    const button = element('button');
    button.type = 'button';
    button.className = 'total tone-' + tone;
    button.append(element('span', label),
      element('strong', summary?.totals[key] != null ? formatCount.format(summary.totals[key]) : '—'));
    if (key === 'runningAds') {
      button.title = 'Số mẫu quảng cáo có hiển thị trong phạm vi ngày đã chọn';
    }
    button.setAttribute('aria-pressed', String(overviewFilter === key));
    button.onclick = () => {
      overviewFilter = overviewFilter === key ? '' : key;
      closeGroup();
      showDetail();
      for (const [index, card] of byId('totals').children.entries()) {
        card.setAttribute('aria-pressed', String(overviewTotals[index][0] === overviewFilter));
      }
      renderOverviewWatches();
    };
    return button;
  }));
  renderOverviewWatches();
}

function matchesTotal(watch, group) {
  switch (overviewFilter) {
    case 'newProjects': return watch.kind === 'competitor' && group.status === 'new';
    case 'newAdvertisers': return watch.kind === 'project' && group.status === 'new';
    case 'newAds': return group.newAds > 0;
    case 'increased': return group.status === 'increase';
    case 'decreased': return group.status === 'decrease';
    case 'stopped': return group.status === 'stopped';
    case 'runningAds': return group.runningNow > 0;
    default: return true;
  }
}

function totalWatchAds(watch) {
  return watch.groups.reduce((sum, group) => sum + group.totalAds, 0);
}

function renderOverviewWatches() {
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
  for (const watch of summary?.watches ?? []) {
    const groups = watch.groups.filter((group) => matchesTotal(watch, group));
    if (overviewFilter && !groups.length) continue;
    const row = element('tr');
    const expansion = element('tr');
    const panel = element('td');
    panel.setAttribute('colspan', labels.length);
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
    const values = [
      toggle, kindLabels[watch.kind],
      ...(allTime ? [formatCount.format(totalWatchAds(watch)), formatCount.format(watch.runningNow)]
        : [formatCount.format(watch.runningNow) + ' (' + signed(watch.delta) + ')',
          formatCount.format(watch.newAds), sparkline(watch.spark)]),
      scanButton('Quét', watch.watchId, 'Quét ' + watch.label),
    ];
    for (const value of values) {
      const cell = element('td');
      if (typeof value === 'string') cell.textContent = value;
      else cell.append(value);
      row.append(cell);
    }
    if (open) fillOverviewGroups(panel, watch, groups);
    body.append(row, expansion);
  }
  const message = overviewFilter ? 'Không có mục phù hợp.'
    : profile.value ? 'Chưa có mục theo dõi.' : 'Thêm hồ sơ để bắt đầu theo dõi.';
  byId('overview-watches').replaceChildren(body.children.length ? table : element('p', message));
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
  groups.sort((a, b) =>
    (key === 'name' ? 0 : b[key] - a[key]) || a.name.localeCompare(b.name, 'vi'));
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
  if (!isAllTime()) heading.append(badge(group.status === 'new' ? (group.groupType === 'advertiser' ? 'Nhà QC mới' : 'Dự án mới') : groupLabels[group.status], group.status));
  heading.append(element('strong', group.name));
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
        await addWatch(input, group.groupType === 'advertiser' ? 'competitor' : 'project');
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
    selectedAd = undefined;
    showDetail();
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
      element('span', ad.domain || 'Chưa rõ tên miền'), dates);
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
      detail.parentElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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

function showDetail(ad) {
  detail.replaceChildren();
  if (!ad) {
    detail.textContent = 'Chọn một mẫu quảng cáo để xem chi tiết.';
    return;
  }
  const duration = ad.firstShown && ad.lastShown
    ? Math.floor((Date.parse(ad.lastShown) - Date.parse(ad.firstShown)) / dayMs) + 1
    : NaN;
  const fields = element('dl');
  const running = isRunningAd(ad);
  for (const [label, value] of [
    ['Nhà quảng cáo', ad.advertiserName || 'Chưa rõ'],
    ['Website', ad.domain || 'Chưa rõ'],
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
  detail.append(preview(ad), fields);
  if (ad.regions?.length) {
    const countries = element('ul');
    countries.className = 'detail-regions';
    for (const region of ad.regions) {
      const { flag, name } = regionLabel(region.iso);
      countries.append(element('li', flag + ' ' + name + ' · ' + displayDate(region.lastShown)));
    }
    detail.append(element('h3', 'Lần chạy gần nhất theo quốc gia'), countries);
  }
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
}

function svgElement(tag, attributes = {}, label) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (label !== undefined) node.textContent = label;
  return node;
}

function sparkline(points) {
  const svg = svgElement('svg', { viewBox: '0 0 96 24', class: 'sparkline', role: 'img',
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

function axisScale(points, key) {
  const max = Math.max(1, ...points.map((point) => point[key]));
  const rawStep = Math.max(1, max / 4);
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
  const width = 700;
  const height = 290;
  const left = 56;
  const right = 680;
  const step = (right - left) / points.length;
  const x = (index) => left + (index + .5) * step;
  const svg = svgElement('svg', { viewBox: [0, 0, width, height].join(' '), class: 'series-chart',
    role: 'group', 'aria-label': labels.join(' và ') });
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

  const drawAxis = (key, label, top, bottom) => {
    const scale = axisScale(points, key);
    const y = (value) => bottom - value / scale.max * (bottom - top);
    svg.append(svgElement('text', { x: left, y: top - 12, class: 'chart-label' }, label));
    for (const tick of scale.ticks) {
      svg.append(svgElement('line', { x1: left, x2: right, y1: y(tick), y2: y(tick), class: 'axis' }),
        svgElement('text', { x: left - 8, y: y(tick) + 4, 'text-anchor': 'end' }, formatCount.format(tick)));
    }
    return y;
  };
  const runY = drawAxis('running', labels[0], 30, 138);
  const runPoints = points.map(({ running }, index) => [x(index), runY(running)].join(','));
  if (points.length === 1) {
    svg.append(svgElement('circle', { cx: x(0), cy: runY(points[0].running), r: 3, class: 'chart-point' }));
  } else {
    svg.append(svgElement('polygon', { class: 'chart-area',
      points: [x(0) + ',138', ...runPoints, x(points.length - 1) + ',138'].join(' ') }),
    svgElement('polyline', { class: 'chart-line', points: runPoints.join(' ') }));
  }
  const barY = drawAxis('newAds', labels[1], 173, 263);
  const barWidth = Math.min(38, Math.max(1, step - 2));
  for (const [index, point] of points.entries()) {
    const y = barY(point.newAds);
    const barLeft = x(index) - barWidth / 2;
    const barRight = barLeft + barWidth;
    const radius = Math.min(2, barWidth / 2, 263 - y);
    svg.append(svgElement('path', { class: 'chart-bar', d:
      `M ${barLeft} 263 V ${y + radius} Q ${barLeft} ${y} ${barLeft + radius} ${y}
       H ${barRight - radius} Q ${barRight} ${y} ${barRight} ${y + radius} V 263 Z` }));
    const row = element('tr');
    row.append(element('td', displayDate(point.date)), ...['running', 'newAds'].map(
      (key) => element('td', formatCount.format(point[key])),
    ));
    body.append(row);
  }

  const duration = (Date.parse(range.to) - Date.parse(range.from)) / dayMs;
  const tickCount = Math.min(points.length, duration <= 10 ? 7 : 6);
  let previousLabel;
  for (let tick = 0; tick < tickCount; tick++) {
    const index = Math.round(tick * (points.length - 1) / Math.max(1, tickCount - 1));
    const date = points[index].date;
    const anchor = tick === 0 ? 'start' : tick === tickCount - 1 ? 'end' : 'middle';
    const label = duration > 60 ? date.slice(5, 7) + '/' + date.slice(0, 4) : displayDate(date, shortDate);
    if (label === previousLabel) continue;
    previousLabel = label;
    svg.append(svgElement('text', { x: x(index), y: 282, 'text-anchor': anchor }, label));
  }

  const selection = svgElement('rect', { y: 30, height: 233, class: 'chart-selection', visibility: 'hidden' });
  const highlight = svgElement('line', { y1: 30, y2: 263, class: 'chart-highlight', visibility: 'hidden' });
  const hit = svgElement('rect', { x: left, y: 30, width: right - left, height: 233,
    class: 'chart-hit', tabindex: 0, 'aria-label': 'Dùng phím mũi tên để xem từng mốc ngày' });
  svg.append(selection, highlight, hit);
  const tooltip = element('div');
  tooltip.className = 'chart-tooltip';
  tooltip.setAttribute('role', 'status');
  tooltip.hidden = true;
  let dragStart;
  let cursor = 0;
  const read = (index) => {
    cursor = index;
    const point = points[index];
    tooltip.textContent = (bucket === 'week' ? 'Tuần từ ' : '') + displayDate(point.date)
      + '\n' + labels[0] + ': ' + formatCount.format(point.running)
      + '\n' + labels[1] + ': ' + formatCount.format(point.newAds);
    tooltip.style.left = (x(index) / width * 100) + '%';
    tooltip.className = 'chart-tooltip' + (x(index) > width * .65 ? ' tooltip-left' : '');
    tooltip.hidden = false;
    highlight.setAttribute('x1', x(index));
    highlight.setAttribute('x2', x(index));
    highlight.setAttribute('visibility', 'visible');
  };
  const clear = () => {
    tooltip.hidden = true;
    highlight.setAttribute('visibility', 'hidden');
    selection.setAttribute('visibility', 'hidden');
    dragStart = undefined;
  };
  const indexAt = (event) => {
    const box = svg.getBoundingClientRect();
    const position = (event.clientX - box.left) * width / box.width;
    return Math.max(0, Math.min(points.length - 1, Math.floor((position - left) / step)));
  };
  hit.onpointermove = (event) => {
    const index = indexAt(event);
    read(index);
    if (dragStart === undefined) return;
    selection.setAttribute('x', x(Math.min(index, dragStart)) - step / 2);
    selection.setAttribute('width', (Math.abs(index - dragStart) + 1) * step);
    selection.setAttribute('visibility', 'visible');
  };
  hit.onpointerdown = (event) => {
    if (event.button !== 0 || dragStart !== undefined) return;
    dragStart = indexAt(event);
    hit.setPointerCapture(event.pointerId);
  };
  hit.onpointerup = (event) => {
    const end = indexAt(event);
    if (dragStart === undefined || end === dragStart) return clear();
    const start = Math.min(dragStart, end);
    const finish = Math.max(dragStart, end);
    const first = points[start].date;
    const last = bucket !== 'week' ? points[finish].date
      : points[finish + 1] ? shiftDate(points[finish + 1].date, -1) : range.to;
    clear();
    return applyRange({ from: first < range.from ? range.from : first, to: last > range.to ? range.to : last });
  };
  hit.onpointerleave = () => { if (dragStart === undefined) clear(); };
  hit.onfocus = () => read(cursor);
  hit.onblur = clear;
  hit.onpointercancel = hit.onlostpointercapture = clear;
  hit.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    read(Math.max(0, Math.min(points.length - 1, cursor + (event.key === 'ArrowLeft' ? -1 : 1))));
  };
  plot.append(svg, tooltip);
  container.replaceChildren(header, plot, table);
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
  button.setAttribute('data-scan', '');
  button.title = fullLabel;
  button.disabled = scanning || startingScan;
  button.onclick = () => startScan(id);
  return button;
}

function renderScanStatus() {
  const { last, scanningWatchId } = scanStatus ?? {};
  const label = watches.find(({ id }) => id === scanningWatchId)?.label
    ?? watchCounts.get(scanningWatchId)?.label;
  const labels = { ok: 'Hoàn tất', blocked: 'Bị Google chặn', error: 'Gặp lỗi' };
  let message = labels[last?.status] ?? 'Chưa có lượt quét.';
  if (last?.status === 'cooldown') {
    message = 'Đang nghỉ' + (last.resumeAt ? ' · quét lại lúc ' + displayDate(last.resumeAt, vietnamTime) : '');
  }
  if (scanning || startingScan) {
    message = 'Đang quét ' + (label || (scanningWatchId ? 'một mục' : 'tất cả')) + '…';
  }
  byId('status').textContent = message;
  for (const button of [scan, byId('scan-watch'), ...document.querySelectorAll('[data-scan]')]) {
    button.disabled = scanning || startingScan;
  }
}

async function refreshStatus(reload = false) {
  clearTimeout(pollTimer);
  const version = ++statusVersion;
  try {
    const result = await api('status');
    if (version !== statusVersion) return;
    scanStatus = result;
    scanning = result.scanning;
    if (reload) startingScan = false;
    renderScanStatus();
    if (reload && !scanning) {
      await loadProfileData();
    }
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

async function addWatch(input, kind) {
  const id = profile.value;
  if (!id || !input.trim()) return;
  await api(profilePath(id) + '/watchlist', 'POST', { input: input.trim(), region: null, kind });
  if (profile.value === id) await loadProfileData();
}

watchInput.oninput = () => {
  const version = clearSuggestions();
  const input = watchInput.value.trim();
  if (!input || !profile.value) return;
  suggestionTimer = setTimeout(async () => {
    try {
      const candidates = await api('suggest?' + new URLSearchParams({ q: input }));
      if (version !== suggestionVersion) return;
      const list = byId('suggestions');
      list.replaceChildren(...candidates.slice(0, 10).map((candidate) => {
        const text = candidate.name || candidate.value;
        const button = element('button');
        button.type = 'button';
        button.append(element('strong', text), element('span', formatCount.format(candidate.ads) + ' mẫu'));
        button.onclick = () => {
          const kind = watchKind;
          watchInput.value = candidate.value;
          clearSuggestions();
          watchInput.focus();
          return run(async () => {
            await addWatch(candidate.value, kind);
            if (watchInput.value === candidate.value) watchInput.value = '';
          });
        };
        return button;
      }));
      list.hidden = !candidates.length;
    } catch {
      if (version === suggestionVersion) clearSuggestions();
    }
  }, 250);
};
watchForm.onkeydown = (event) => {
  if (event.key === 'Escape') {
    clearSuggestions();
    watchInput.focus();
  }
};
watchForm.onfocusout = (event) => {
  if (!watchForm.contains(event.relatedTarget)) clearSuggestions();
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

byId('home').onclick = () => chooseWatch('');
for (const kind of Object.keys(kindLabels)) {
  byId('kind-' + kind).onclick = () => setWatchKind(kind);
  byId('add-' + kind).onclick = () => {
    setWatchKind(kind);
    watchForm.elements.input.focus();
  };
}

watchForm.onsubmit = (event) => {
  event.preventDefault();
  const input = watchInput.value;
  const kind = watchKind;
  clearSuggestions();
  return run(async () => {
    await addWatch(input, kind);
    if (watchInput.value === input) watchInput.value = '';
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
