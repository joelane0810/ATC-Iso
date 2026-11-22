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
const timeFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });
const formats = { image: 'Hình ảnh', text: 'Chữ', video: 'Video' };
let watchId = '';
let selectedAd;
let ads = [];
const kindLabels = { competitor: 'Đối thủ', project: 'Dự án' };
const groupLabels = {
  new: 'Dự án mới', increase: 'Chạy thêm ads', decrease: 'Giảm ads', stopped: 'Đã dừng', steady: 'Ổn định',
};
const overviewTotals = [
  ['new', 'newGroups'], ['increase', 'increased'], ['decrease', 'decreased'],
  ['stopped', 'stopped'], ['running', 'runningAds'],
];
const watchColors = [
  '#00796b', '#3949ab', '#ad1457', '#8d6e00', '#6a1b9a',
  '#0069a6', '#bf360c', '#33691e', '#455a64', '#c21824',
];
const regionNames = new Intl.DisplayNames('vi', { type: 'region', fallback: 'none' });
const dayMs = 86_400_000;
let overviewFilter = '';
let openGroup;
const formatCount = new Intl.NumberFormat('vi-VN');
const previousTime = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Ho_Chi_Minh',
});
const previousDay = new Intl.DateTimeFormat('en-GB', {
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
  if (response.status === 204) return;
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
    currentWatch ? api(path + '/ads?' + filters) : [],
    api(path + '/summary'),
  ]);
  if (version !== loadVersion) return;
  watches = watchlist;
  ads = results.filter((ad) => ad.platform === 'search');
  summary = overview;
  watchCounts = new Map(summary.watches.map((watch) => [watch.watchId, watch]));
  if (!watches.some((watch) => watch.id === watchId)) watchId = '';
  renderWatches();
  renderAds();
}

function chooseWatch(id) {
  ++loadVersion;
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
  if (id) return run(loadProfileData);
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
      item.append(choose, remove);
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
  const previous = summary?.previousScanAt;
  byId('gallery-summary').textContent = previous
    ? 'So với lượt quét trước lúc ' + displayDate(previous, previousTime) + ' ' + displayDate(previous, previousDay)
    : summary?.lastScan ? 'Lượt quét đầu tiên — chưa có so sánh' : 'Chưa có lượt quét.';
  byId('totals').replaceChildren(...overviewTotals.map(([status, key]) => {
    const button = element('button');
    button.type = 'button';
    button.className = 'total tone-' + (status === 'running' ? 'steady' : status);
    button.append(element('span', groupLabels[status] ?? 'Mẫu đang chạy'),
      element('strong', summary ? formatCount.format(summary.totals[key]) : '—'));
    button.setAttribute('aria-pressed', String(overviewFilter === status));
    button.onclick = () => {
      overviewFilter = overviewFilter === status ? '' : status;
      closeGroup();
      selectedAd = undefined;
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

function renderOverviewWatches() {
  const blocks = [];
  for (const watch of summary?.watches ?? []) {
    const groups = watch.groups.filter((group) => !overviewFilter ||
      (overviewFilter === 'running' ? group.runningNow > 0 : group.status === overviewFilter));
    if (!groups.length && overviewFilter) continue;
    const block = element('section');
    block.className = 'overview-watch';
    const header = element('header');
    const count = 'Đang chạy ' + formatCount.format(watch.runningNow) + ' mẫu';
    header.append(watchName('h3', watch.label, watch.watchId),
      element('span', summary.previousScanAt
        ? count + ' (' + signed(watch.runningNow - watch.runningBefore) + ' so với lượt trước)' : count));
    const label = element('p', watch.kind === 'project' ? 'Nhà quảng cáo' : 'Dự án');
    label.className = 'group-label';
    block.append(header, label, ...groups.map((group) => groupRow(watch, group)));
    if (!groups.length) block.append(element('p', 'Chưa có mẫu quảng cáo.'));
    blocks.push(block);
  }
  if (!blocks.length) {
    const message = overviewFilter ? 'Không có mục phù hợp.'
      : profile.value ? 'Chưa có mục theo dõi.' : 'Thêm hồ sơ để bắt đầu theo dõi.';
    blocks.push(element('p', message));
  }
  byId('overview-watches').replaceChildren(...blocks);
}

function groupRow(watch, group) {
  const row = element('button');
  row.type = 'button';
  row.className = 'group-row';
  row.setAttribute('aria-expanded', 'false');
  const heading = element('span');
  heading.className = 'group-heading';
  heading.append(badge(groupLabels[group.status], group.status), element('strong', group.name));
  const counts = element('span');
  counts.className = 'group-counts';
  counts.append(element('span', formatCount.format(group.runningBefore) + ' → ' + formatCount.format(group.runningNow)),
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
  wrapper.append(row, panel);
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
  openGroup.row.setAttribute('aria-expanded', 'false');
  openGroup.panel.hidden = true;
  openGroup.panel.replaceChildren();
  openGroup = undefined;
}

async function loadGroupAds(request, id, key, message) {
  const params = new URLSearchParams({ filter: 'all', watchId: id, group: key });
  try {
    const results = await api(profilePath(profile.value) + '/ads?' + params);
    if (openGroup !== request) return;
    const visible = results.filter((ad) => ad.platform === 'search');
    if (!visible.length) {
      message.textContent = 'Chưa có mẫu phù hợp.';
      return;
    }
    const grid = element('div');
    grid.className = 'ads';
    renderGrid(grid, visible);
    request.panel.replaceChildren(grid);
  } catch {
    if (openGroup === request) message.textContent = 'Không tải được mẫu. Đóng rồi mở lại để thử lại.';
  }
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
  const age = Date.parse(summary?.lastScan?.at) - Date.parse(ad.firstSeenByUs);
  return age >= 0 && age <= dayMs;
}

function isRunningAd(ad) {
  if (typeof ad.isRunning === 'boolean') return ad.isRunning;
  const cutoff = Date.parse(summary?.lastScan?.at) - 2 * dayMs;
  return Number.isFinite(cutoff) ? Date.parse(ad.lastShown) >= cutoff : undefined;
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

async function refreshStatus(wasScanning = false) {
  clearTimeout(pollTimer);
  const { scanning, last } = await api('status');
  scan.disabled = scanning;
  const labels = { ok: 'Hoàn tất', blocked: 'Bị chặn', error: 'Gặp lỗi' };
  const date = last?.at ?? last?.startedAt ?? last?.finishedAt ?? last?.time;
  byId('status').textContent = scanning ? 'Đang quét…' : last
    ? [labels[last.status], date && displayDate(date, timeFormat),
      Number.isFinite(last.newAds) && `${last.newAds} mẫu mới`].filter(Boolean).join(' · ')
    : 'Chưa có lượt quét.';
  if (scanning) {
    pollTimer = setTimeout(() => {
      refreshStatus(true).catch((error) => {
        scan.disabled = false;
        report(error);
      });
    }, 5000);
  } else if (wasScanning) {
    await loadProfileData();
  }
}

profile.onchange = () => run(selectProfile);
filter.onchange = format.onchange = query.oninput = () => run(loadProfileData);

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
  const form = event.currentTarget;
  const id = profile.value;
  if (!id) return;
  const input = form.elements.input.value;
  const kind = watchKind;
  return run(async () => {
    await api(profilePath(id) + '/watchlist', 'POST', { input, region: null, kind });
    if (form.elements.input.value === input) form.elements.input.value = '';
    if (profile.value === id) await loadProfileData();
  });
};

scan.onclick = () => run(async () => {
  scan.disabled = true;
  try {
    try {
      await api('scan', 'POST');
    } catch (error) {
      if (error.status !== 409) throw error;
    }
    await refreshStatus(true);
  } catch (error) {
    scan.disabled = false;
    throw error;
  }
});

let preferred;
try { preferred = localStorage.getItem('atc-iso-profile'); } catch {}
run(() => Promise.all([loadProfiles(preferred), refreshStatus()]));
