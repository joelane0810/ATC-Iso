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
  byId('watches').replaceChildren();
  ads = [];
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
  const [watches, results, newest] = await Promise.all([
    api(path + '/watchlist'),
    api(path + '/ads?' + filters),
    api(path + '/ads?filter=new'),
  ]);
  if (version !== loadVersion) return;
  if (!watches.some((watch) => watch.id === watchId)) watchId = '';
  const counts = new Map();
  for (const ad of newest) {
    for (const id of ad.watchIds) counts.set(id, (counts.get(id) || 0) + 1);
  }
  ads = results;
  const renderWatches = () => {
    const buttons = watches.map((watch) => {
      const item = element('li');
      const choose = element('button', `${watch.label} · ${counts.get(watch.id) || 0} mới`);
      choose.setAttribute('aria-pressed', String(watchId === watch.id));
      choose.onclick = () => {
        watchId = watchId === watch.id ? '' : watch.id;
        renderWatches();
        renderAds();
      };
      const remove = element('button', 'Xoá');
      remove.setAttribute('aria-label', 'Xoá ' + watch.label);
      remove.onclick = () => run(async () => {
        await api(path + '/watchlist/' + encodeURIComponent(watch.id), 'DELETE');
        if (profile.value === id) await loadProfileData();
      });
      item.append(choose, remove);
      return item;
    });
    byId('watches').replaceChildren(...buttons);
  };
  renderWatches();
  renderAds();
}

function preview(ad) {
  const source = /^images\/[\w.-]+\.(png|jpe?g)$/i.test(ad.image || '') ? '/' + ad.image
    : /^https?:\/\//i.test(ad.imageUrl || '') ? ad.imageUrl : null;
  if (!source) {
    const placeholder = element('div', 'Chưa có ảnh');
    placeholder.className = 'preview';
    return placeholder;
  }
  const image = element('img');
  image.className = 'preview';
  image.alt = 'Ảnh mẫu quảng cáo';
  image.loading = 'lazy';
  image.src = source;
  return image;
}

function renderAds() {
  const visible = ads.filter((ad) => !watchId || ad.watchIds.includes(watchId));
  const empty = byId('empty');
  empty.hidden = visible.length > 0;
  empty.textContent = profile.value ? 'Chưa có mẫu phù hợp.' : 'Thêm hồ sơ để bắt đầu theo dõi.';
  selectedAd = visible.find((ad) => ad.creativeId === selectedAd?.creativeId);
  adsGrid.replaceChildren(...visible.map((ad) => {
    const button = element('button');
    button.className = 'ad';
    button.type = 'button';
    button.append(preview(ad), element('span', ad.domain || ad.advertiserName || 'Chưa rõ'),
      element('span', formats[ad.format] || 'Mẫu quảng cáo'),
      element('span', 'Bắt đầu ' + displayDate(ad.firstShown)),
      element('span', 'Gần nhất ' + displayDate(ad.lastShown)));
    if (ad.isNew) button.append(element('span', 'Mới'));
    if (!ad.isRunning) button.append(element('span', 'Đã dừng'));
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
    ['Website', ad.domain || ad.advertiserName || 'Chưa rõ'],
    ['Nhà quảng cáo', ad.advertiserName || 'Chưa rõ'],
    ['Ngày bắt đầu', displayDate(ad.firstShown)],
    ['Ngày chạy gần nhất', displayDate(ad.lastShown)],
    ['Số ngày chạy', duration > 0 ? String(duration) : 'Chưa rõ'],
  ]) {
    fields.append(element('dt', label), element('dd', value));
  }
  detail.append(preview(ad), fields);
  if (/^https:\/\/adstransparency\.google\.com\/advertiser\//.test(ad.detailsUrl || '')) {
    const link = element('a', 'Xem trên Google');
    link.href = ad.detailsUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    detail.append(link);
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
