const byId = (id) => document.getElementById(id);
const profile = byId('profile');
const filter = byId('filter');
const query = byId('query');
const format = byId('format');
const scan = byId('scan');
const errorMessage = byId('error');
const adsGrid = byId('ads');
const detail = byId('detail');
const dateFormat = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh',
});
const timeFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });
const formats = { image: 'Hình ảnh', text: 'Chữ', video: 'Video' };
let watchId = '';
let selectedAd;
let ads = [];
let allAds = [];
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
  byId('watch-form').querySelectorAll('input, button').forEach((node) => {
    node.disabled = !profiles.length;
  });
  await selectProfile();
}

async function selectProfile() {
  watchId = '';
  selectedAd = undefined;
  watches = [];
  ads = [];
  allAds = [];
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
  const unfiltered = api(path + '/ads');
  const [watchlist, results, totals] = await Promise.all([
    api(path + '/watchlist'),
    filter.value === 'all' && !query.value.trim() && !format.value
      ? unfiltered : api(path + '/ads?' + filters),
    unfiltered,
  ]);
  if (version !== loadVersion) return;
  watches = watchlist;
  ads = results;
  allAds = totals;
  if (!watches.some((watch) => watch.id === watchId)) watchId = '';
  renderWatches();
  renderAds();
}

function belongsTo(ad, id) {
  return !id || ad.watchId === id || ad.watchIds?.includes(id);
}

function renderWatches() {
  byId('watches').replaceChildren(...[{ id: '', label: 'Tất cả đối thủ' }, ...watches].map((watch) => {
    const item = element('li');
    const choose = element('button');
    choose.className = 'watch-choice';
    choose.setAttribute('aria-pressed', String(watchId === watch.id));
    const matching = allAds.filter((ad) => belongsTo(ad, watch.id));
    const newCount = matching.filter((ad) => ad.isNew).length;
    const counts = element('span', matching.length + ' mẫu');
    counts.className = 'watch-counts';
    if (newCount) counts.append(badge(newCount + ' mới', true));
    choose.append(element('strong', watch.label), counts);
    choose.onclick = () => {
      watchId = watch.id;
      for (const row of byId('watches').children) {
        row.children[0].setAttribute('aria-pressed', String(row === item));
      }
      renderAds();
    };
    item.append(choose);
    if (watch.id) {
      const remove = element('button', '×');
      remove.className = 'remove-watch';
      remove.setAttribute('aria-label', 'Xoá ' + watch.label);
      remove.title = 'Xoá ' + watch.label;
      remove.onclick = () => run(async () => {
        const id = profile.value;
        await api(profilePath(id) + '/watchlist/' + encodeURIComponent(watch.id), 'DELETE');
        if (profile.value === id) await loadProfileData();
      });
      item.append(remove);
    }
    return item;
  }));
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
  const visible = ads.filter((ad) => belongsTo(ad, watchId));
  const watch = watches.find(({ id }) => id === watchId);
  const matching = allAds.filter((ad) => belongsTo(ad, watchId));
  const domain = watch?.type === 'domain' ? watch.value : matching.find((ad) => ad.domain)?.domain;
  byId('gallery-heading').textContent = watch?.label || 'Tất cả đối thủ';
  byId('gallery-summary').textContent = [
    watch && domain,
    matching.length.toLocaleString('vi-VN') + ' mẫu quảng cáo',
  ].filter(Boolean).join(' · ');
  const empty = byId('empty');
  empty.hidden = visible.length > 0;
  empty.textContent = profile.value ? 'Chưa có mẫu phù hợp.' : 'Thêm hồ sơ để bắt đầu theo dõi.';
  selectedAd = visible.find((ad) => ad.creativeId === selectedAd?.creativeId);
  adsGrid.replaceChildren(...visible.map((ad) => {
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
    if (!ad.isRunning) badges.append(badge('Đã dừng'));
    info.append(badges);
    button.append(preview(ad), info);
    button.setAttribute('aria-pressed', String(ad === selectedAd));
    button.onclick = () => {
      adsGrid.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      selectedAd = ad;
      showDetail(ad);
      detail.parentElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    return button;
  }));
  showDetail(selectedAd);
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
    ['Trạng thái', ad.isRunning ? 'Đang chạy' : 'Đã dừng'],
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

byId('watch-form').onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = profile.value;
  run(async () => {
    await api(profilePath(id) + '/watchlist', 'POST', { input: form.elements.input.value });
    form.reset();
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
