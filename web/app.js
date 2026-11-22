const byId = (id) => document.getElementById(id);
const profile = byId('profile');
const filter = byId('filter');
const query = byId('query');
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
];
const watchColors = [
  '#00796b', '#3949ab', '#ad1457', '#8d6e00', '#6a1b9a',
  '#0069a6', '#bf360c', '#33691e', '#455a64', '#c21824',
];
const regionNames = new Intl.DisplayNames('vi', { type: 'region', fallback: 'none' });
const dayMs = 86_400_000;
let overviewFilter = '';
let openGroup;
let period = 'day';
let mode = 'groups';
const expandedWatches = new Set();
const expandedLists = new Set();
let seriesVersion = 0;
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
  ++seriesVersion;
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

async function loadProfileData() {
  const version = ++loadVersion;
  const id = profile.value;
  if (!id) return;
  const currentWatch = watchId;
  const filters = new URLSearchParams({ filter: filter.value, q: query.value, format: format.value, watchId: currentWatch });
  const path = profilePath(id);
  const [watchlist, results, overview] = await Promise.all([
    api(path + '/watchlist'),
    currentWatch && mode === 'grid' ? api(path + '/ads?' + filters) : [],
    api(path + '/summary?' + new URLSearchParams({ window: period })),
  ]);
  if (version !== loadVersion) return;
  watches = watchlist;
  ads = results.filter((ad) => ad.platform === 'search');
  summary = overview;
  watchCounts = new Map(summary.watches.map((watch) => [watch.watchId, watch]));
  if (!watches.some((watch) => watch.id === watchId)) watchId = '';
  renderWatches();
  renderAds();
  renderScanStatus();
}

function chooseWatch(id) {
  ++loadVersion;
  ++seriesVersion;
  mode = 'groups';
  watchId = id;
  ads = [];
  selectedAd = undefined;
  if (id) {
    const watch = watches.find((watch) => watch.id === id);
    if (watch) byId('group-' + kindOf(watch)).open = true;
  }
  renderWatches();
  renderAds();
  byId('gallery-heading').focus({ preventScroll: true });
  if (id) return run(() => loadWatchSeries(id));
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
      const counts = element('span', formatCount.format(runningNow) + ' mẫu đang chạy');
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
    const visible = ads;
    const status = watchCounts.get(watchId);
    selectedAd = visible.find((ad) => ad.creativeId === selectedAd?.creativeId);
    const domain = watch.type === 'domain' ? watch.value : visible.find((ad) => ad.domain)?.domain;
    byId('gallery-heading').textContent = watch.label;
    byId('gallery-summary').textContent = [
      domain,
      formatCount.format(status?.runningNow ?? 0) + ' mẫu đang chạy',
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
  byId('totals').replaceChildren(...overviewTotals.map(([key, label, tone]) => {
    const button = element('button');
    button.type = 'button';
    button.className = 'total tone-' + tone;
    button.append(element('span', label),
      element('strong', summary?.totals[key] != null ? formatCount.format(summary.totals[key]) : '—'));
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
    default: return true;
  }
}

function renderOverviewWatches() {
  const table = element('table');
  table.className = 'overview-table';
  const heading = element('tr');
  heading.append(...['Mục theo dõi', 'Loại', 'Đang chạy (±)', 'Mới', '30 ngày', 'Quét'].map((label) => {
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
    panel.setAttribute('colspan', '6');
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
      toggle, kindLabels[watch.kind], formatCount.format(watch.runningNow) + ' (' + signed(watch.delta) + ')',
      formatCount.format(watch.newAds), sparkline(watch.spark), scanButton('Quét', watch.watchId, 'Quét ' + watch.label),
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
  const key = byId('group-sort').value || 'runningNow';
  const groups = [...(watch?.groups ?? [])].sort((a, b) =>
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
  const heading = element('span');
  heading.className = 'group-heading';
  heading.append(badge(group.status === 'new' ? (group.groupType === 'advertiser' ? 'Nhà QC mới' : 'Dự án mới') : groupLabels[group.status], group.status), element('strong', group.name));
  const counts = element('span');
  counts.className = 'group-counts';
  counts.append(element('span', formatCount.format(group.runningPrev) + ' → ' + formatCount.format(group.runningNow)),
    badge(signed(group.delta), group.delta > 0 ? 'increase' : group.delta < 0 ? group.status : 'steady'),
    element('span', formatCount.format(group.newAds) + ' mẫu mới'));
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
    const request = { row, panel };
    openGroup = request;
    row.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    const message = element('p', 'Đang tải mẫu…');
    message.setAttribute('role', 'status');
    panel.append(message);
    return loadGroupAds(request, watch.watchId, group.key, message);
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

async function loadGroupAds(request, id, key, message) {
  const params = new URLSearchParams({ filter: 'all', q: '', format: '', watchId: id, group: key });
  const path = profilePath(profile.value);
  const chart = element('div', 'Đang tải biểu đồ…');
  request.panel.replaceChildren(chart, message);
  const graph = loadSeries(path, id, key).then((series) => {
    if (openGroup === request) renderChart(chart, series.points);
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
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const parts = dateFormat.formatToParts(new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return [part('year'), part('month'), part('day')].join('-');
}

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
    'aria-label': 'Số mẫu đang chạy trong 30 ngày' });
  const max = Math.max(1, ...points.map(({ running }) => running));
  svg.append(svgElement('polyline', {
    points: points.map(({ running }, index) =>
      [2 + index * 92 / Math.max(1, points.length - 1), 22 - running * 20 / max].join(',')).join(' '),
  }));
  return svg;
}

function renderChart(container, points) {
  container.textContent = '';
  if (!points.length) {
    container.textContent = 'Chưa có dữ liệu biểu đồ.';
    return;
  }
  const chart = svgElement('svg', { viewBox: '0 0 600 166', class: 'series-chart',
    role: 'group', 'aria-label': 'Số mẫu đang chạy và mẫu mới theo ngày trong 90 ngày' });
  const readout = element('div');
  readout.className = 'chart-readout';
  const baseline = 140;
  const max = Math.max(1, ...points.map(({ running, newAds }) => Math.max(running, newAds)));
  const step = 544 / points.length;
  const x = (index) => 39 + step * (index + .5);
  const y = (count) => baseline - count * 118 / max;
  for (const count of [...new Set([0, Math.round(max / 2), max])]) {
    chart.append(svgElement('line', { x1: 39, x2: 583, y1: y(count), y2: y(count), class: 'axis' }),
      svgElement('text', { x: 35, y: y(count) + 4, 'text-anchor': 'end' }, formatCount.format(count)));
  }
  for (const [index, point] of points.entries()) {
    chart.append(svgElement('rect', { x: x(index) - step * .36, y: y(point.newAds),
      width: step * .72, height: baseline - y(point.newAds), class: 'chart-bar' }));
  }
  chart.append(svgElement('polyline', { class: 'chart-line',
    points: points.map(({ running }, index) => [x(index), y(running)].join(',')).join(' ') }));
  const tickCount = Math.min(5, points.length);
  for (let tick = 0; tick < tickCount; tick++) {
    const index = Math.round(tick * (points.length - 1) / Math.max(1, tickCount - 1));
    const anchor = tick === 0 ? 'start' : tick === tickCount - 1 ? 'end' : 'middle';
    chart.append(svgElement('text', { x: x(index), y: 158, 'text-anchor': anchor },
      displayDate(points[index].date, shortDate)));
  }
  const highlight = svgElement('line', { y1: 19, y2: baseline, class: 'chart-highlight' });
  chart.append(highlight);
  for (const [index, point] of points.entries()) {
    const label = displayDate(point.date, shortDate) + ' · ' + formatCount.format(point.running)
      + ' đang chạy · ' + formatCount.format(point.newAds) + ' mẫu mới';
    const hit = svgElement('rect', { x: x(index) - step / 2, y: 16, width: step, height: 126,
      class: 'chart-hit', tabindex: 0, 'aria-label': label });
    hit.onmouseenter = hit.onfocus = () => {
      readout.textContent = label;
      highlight.setAttribute('x1', x(index));
      highlight.setAttribute('x2', x(index));
    };
    chart.append(hit);
  }
  const legend = element('div');
  legend.className = 'chart-legend';
  legend.append(element('span', 'Đang chạy'), element('span', 'Mẫu mới'));
  container.replaceChildren(legend, chart, readout);
}

function loadSeries(path, id, group) {
  const params = new URLSearchParams({ watchId: id, days: '90' });
  if (group !== undefined) params.set('group', group);
  return api(path + '/series?' + params);
}

async function loadWatchSeries(id) {
  const version = ++seriesVersion;
  const chart = byId('watch-chart');
  chart.replaceChildren(element('p', 'Đang tải biểu đồ…'));
  try {
    const { points } = await loadSeries(profilePath(profile.value), id);
    if (version === seriesVersion) renderChart(chart, points);
  } catch {
    if (version === seriesVersion) chart.replaceChildren(element('p', 'Không tải được biểu đồ.'));
  }
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
      await Promise.all([loadProfileData(), watchId && loadWatchSeries(watchId)]);
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
byId('period').onchange = (event) => {
  period = event.currentTarget.value;
  return run(loadProfileData);
};
filter.onchange = format.onchange = query.oninput = () => run(loadProfileData);
byId('group-sort').onchange = () => {
  closeGroup();
  showDetail();
  renderWatchGroups();
};
for (const view of ['groups', 'grid']) {
  byId('mode-' + view).onclick = () => {
    if (mode === view) return;
    mode = view;
    ++loadVersion;
    selectedAd = undefined;
    renderAds();
    if (view === 'grid') return run(loadProfileData);
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

let preferred;
try { preferred = localStorage.getItem('atc-iso-profile'); } catch {}
run(() => Promise.all([loadProfiles(preferred), refreshStatus()]));
