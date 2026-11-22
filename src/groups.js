const DAY = 24 * 60 * 60 * 1000;

export const runningAt = (lastShown, at) => Date.parse(lastShown) >= at - 2 * DAY;
export const groupTypes = ['domain', 'advertiser'];

export function groupIdentity(ad, groupType) {
  if (groupType === 'advertiser') {
    return { key: ad.advertiserId || '', name: ad.advertiserName || ad.advertiserId || 'Chưa rõ nhà quảng cáo' };
  }
  const key = ad.domain?.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || '';
  return { key, name: key || 'Chưa rõ tên miền' };
}

export function groupAds(ads, groupType) {
  const groups = new Map();
  for (const ad of ads) {
    if (ad.platform !== 'search') continue;
    const { key, name } = groupIdentity(ad, groupType);
    if (!groups.has(key)) groups.set(key, { key, name, ads: [] });
    groups.get(key).ads.push(ad);
  }
  return groups;
}
