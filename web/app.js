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
const countKeys = ['new', 'stopped', 'running'];
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
  const filters = new URLSearchParams({ filter: filter.value, q: query.value, format: format.value });
  const path = profilePath(id);
  const [watchlist, results, overview] = await Promise.all([
    api(path + '/watchlist'),
    api(path + '/ads?' + filters),
    api(path + '/summary'),
  ]);
  if (version !== loadVersion) return;
  watches = watchlist;
  ads = results.filter((ad) => ad.platform === 'search');
  summary = overview;
  watchCounts = new Map(summary.byWatch.map((row) => [row.watchId, row]));
  if (!watches.some((watch) => watch.id === watchId)) watchId = '';
  renderWatches();
  renderAds();
}

function chooseWatch(id) {
  watchId = id;
  selectedAd = undefined;
  if (id) {
    const watch = watches.find((watch) => watch.id === id);
    if (watch) byId('group-' + kindOf(watch)).open = true;
  }
  renderWatches();
  renderAds();
  byId('gallery-heading').focus({ preventScroll: true });
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
      const { total = 0, new: newCount = 0 } = watchCounts.get(watch.id) ?? {};
      const counts = element('span', formatCount.format(total) + ' mẫu');
      counts.className = 'watch-counts';
      if (newCount) counts.append(badge(formatCount.format(newCount) + ' mới', true));
      choose.append(element('strong', watch.label), counts);
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

function badge(label, highlighted = false) {
  const node = element('span', label);
  node.className = highlighted ? 'badge badge-new' : 'badge';
  return node;
}

function previewFallback(ad) {
  const placeholder = element('div');
  placeholder.className = 'preview preview-empty';
  const icon = element('span', { text: '≡', image: '▧', video: '▷' }[ad.format] || '▧');
  icon.className = 'format-icon';
  icon.setAttribute('aria-hidden', 'true');
  placeholder.append(icon, element('span', 'Chưa có ảnh xem trước'));
  return placeholder;
}

function preview(ad) {
  const filename = /^(?:images\/)?([\w.-]+\.(?:png|jpe?g|webp|gif|avif))$/i.exec(ad.image || '')?.[1];
  const remote = /^https?:\/\//i.test(ad.imageUrl || '') ? ad.imageUrl : null;
  const source = filename ? '/images/' + encodeURIComponent(filename) : remote;
  if (!source) return previewFallback(ad);

  const image = element('img');
  image.className = 'preview';
  image.alt = 'Ảnh mẫu quảng cáo';
  image.loading = 'lazy';
  image.onerror = () => image.replaceWith(previewFallback(ad));
  image.src = source;
  return image;
}

function renderAds() {
  const watch = watches.find(({ id }) => id === watchId);
  byId('overview').hidden = Boolean(watch);
  byId('watch-view').hidden = !watch;
  const newAds = (summary?.newAds ?? []).filter((ad) => ad.platform === 'search')
    .map((ad) => ({ ...ad, isNew: true }));
  const stoppedAds = (summary?.stoppedAds ?? []).filter((ad) => ad.platform === 'search')
    .map((ad) => ({ ...ad, isRunning: false }));
  const visible = watch ? ads.filter((ad) => ad.watchId === watchId || ad.watchIds?.includes(watchId)) : [];
  const candidates = watch ? visible : [...newAds, ...stoppedAds];
  selectedAd = candidates.find((ad) => ad.creativeId === selectedAd?.creativeId && ad.watchId === selectedAd?.watchId);
  if (watch) {
    const domain = watch.type === 'domain' ? watch.value : visible.find((ad) => ad.domain)?.domain;
    byId('gallery-heading').textContent = watch.label;
    byId('gallery-summary').textContent = [
      domain,
      formatCount.format(watchCounts.get(watchId)?.total ?? 0) + ' mẫu quảng cáo',
    ].filter(Boolean).join(' · ');
    byId('empty').hidden = visible.length > 0;
    byId('empty').textContent = 'Chưa có mẫu phù hợp.';
    renderGrid('ads', visible);
  } else {
    renderOverview(newAds, stoppedAds);
  }
  showDetail(selectedAd);
}

function renderOverview(newAds, stoppedAds) {
  byId('gallery-heading').textContent = 'Tổng quan thay đổi';
  const previous = summary?.previousScanAt;
  byId('gallery-summary').textContent = previous
    ? 'So với lượt quét trước lúc ' + displayDate(previous, previousTime) + ' ' + displayDate(previous, previousDay)
    : 'Chưa có lượt quét trước';
  for (const key of countKeys) {
    byId('total-' + key).textContent = summary ? formatCount.format(summary.totals[key]) : '—';
  }
  const rows = (summary?.byWatch ?? []).map((watch) => {
    const row = element('tr');
    const name = element('th');
    name.setAttribute('scope', 'row');
    const button = element('button', watch.label);
    button.type = 'button';
    name.append(button);
    row.onclick = () => chooseWatch(watch.watchId);
    row.append(name, element('td', kindLabels[kindOf(watch)]),
      ...[...countKeys, 'total'].map((key) => element('td', formatCount.format(watch[key]))));
    return row;
  });
  if (!rows.length) {
    const row = element('tr');
    const message = element('td', profile.value ? 'Chưa có mục theo dõi.' : 'Thêm hồ sơ để bắt đầu theo dõi.');
    message.colSpan = 6;
    row.append(message);
    rows.push(row);
  }
  byId('changes').replaceChildren(...rows);
  byId('new-empty').hidden = newAds.length > 0;
  byId('stopped-empty').hidden = stoppedAds.length > 0;
  renderGrid('new-ads', newAds);
  renderGrid('stopped-ads', stoppedAds);
}

function renderGrid(id, visible) {
  byId(id).replaceChildren(...visible.map((ad) => {
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
    if (ad.isNew) badges.append(badge('Mới', true));
    if (ad.isRunning === false) badges.append(badge('Đã dừng'));
    info.append(badges);
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

function showDetail(ad) {
  detail.replaceChildren();
  if (!ad) {
    detail.textContent = 'Chọn một mẫu quảng cáo để xem chi tiết.';
    return;
  }
  const duration = ad.firstShown && ad.lastShown
    ? Math.floor((Date.parse(ad.lastShown) - Date.parse(ad.firstShown)) / 86_400_000) + 1
    : NaN;
  const fields = element('dl');
  for (const [label, value] of [
    ['Nhà quảng cáo', ad.advertiserName || 'Chưa rõ'],
    ['Website', ad.domain || 'Chưa rõ'],
    ['Định dạng', formats[ad.format] || 'Chưa rõ'],
    ['Bắt đầu chạy', displayDate(ad.firstShown)],
    ['Lần chạy gần nhất', displayDate(ad.lastShown)],
    ['Số ngày chạy', duration > 0 ? String(duration) : 'Chưa rõ'],
    ['Trạng thái', ad.isRunning === undefined ? 'Chưa rõ' : ad.isRunning ? 'Đang chạy' : 'Đã dừng'],
  ]) {
    fields.append(element('dt', label), element('dd', value));
  }
  detail.append(preview(ad), fields);
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
