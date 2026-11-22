const ATC = 'https://adstransparency.google.com';

export const RPC_BASE = `${ATC}/anji/_/rpc`;

export class BlockedError extends Error {
  constructor(message = 'Bị chặn') {
    super(message);
    this.name = 'BlockedError';
  }
}

function parseUrl(input) {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export function parseWatchInput(str) {
  const input = str.trim().replace(/^\/\//, '');
  if (/^AR\d+$/i.test(input)) {
    return { type: 'advertiser', value: input.toUpperCase() };
  }

  const url = parseUrl(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
    const domain = url.hostname.replace(/^www\./, '').replace(/\.$/, '');
    const advertiser = url.pathname.match(/\/advertiser\/(AR\d+)(?:\/|$)/i);
    if (domain === 'adstransparency.google.com' && advertiser) {
      return { type: 'advertiser', value: advertiser[1].toUpperCase() };
    }
    if (/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z][a-z\d-]{0,62}$/i.test(domain)) {
      return { type: 'domain', value: domain };
    }
  }
  throw new Error('Không nhận ra tên miền hoặc link nhà quảng cáo');
}

export function buildSearchCreativesReq({ watch, pageToken = null, pageSize = 40 }) {
  const selector = watch.type === 'domain'
    ? { 12: { 1: watch.value, 2: true } }
    : { 13: { 1: [watch.value] } };
  selector[14] = [3];
  if (watch.region != null) selector[8] = [watch.region];

  const request = { 2: pageSize, 3: selector, 7: { 1: 1, 2: 30, 3: 2840 } };
  if (pageToken != null) request[4] = pageToken;
  return request;
}

function timestampToIso(seconds) {
  if (seconds == null || seconds === '') return null;
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseCreatives(json) {
  const formats = { 1: 'text', 2: 'image', 3: 'video' };
  const ads = (json?.[1] ?? []).map((creative) => {
    const advertiserId = creative[1];
    const creativeId = creative[2];
    const previewHtml = creative[3]?.[3]?.[2];
    const image = previewHtml?.match(/<img\b[^>]*?\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return {
      creativeId,
      advertiserId,
      advertiserName: creative[12] ?? null,
      domain: creative[14] ?? null,
      format: formats[creative[4]] ?? null,
      previewUrl: creative[3]?.[1]?.[4] ?? null,
      imageUrl: image?.[1] ?? image?.[2] ?? image?.[3] ?? null,
      firstShown: timestampToIso(creative[6]?.[1]),
      lastShown: timestampToIso(creative[7]?.[1]),
      detailsUrl: `${ATC}/advertiser/${advertiserId}/creative/${creativeId}`,
    };
  });
  return { ads, nextToken: json?.[2] || null };
}

export function parseSuggestions(json) {
  const suggestions = [];
  for (const item of json?.[1] ?? []) {
    if (item[1]?.[2]) {
      suggestions.push({ type: 'advertiser', id: item[1][2], name: item[1][1], country: item[1][3] ?? null });
    } else if (item[2]?.[1]) {
      suggestions.push({ type: 'domain', value: item[2][1] });
    }
  }
  return suggestions;
}

export function isBlockedResponse({ status, url = '', text = '', contentType = '' }) {
  return status === 429
    || /^(?:https?:)?\/\/(?:[a-z\d-]+\.)*google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})\/sorry(?:[/?#]|$)/i.test(url)
    || /^(?:text\/html|application\/xhtml\+xml)(?:[;\s]|$)/i.test(contentType)
    || /^\s*<(?:!doctype\s+html\b|[a-z][a-z\d:-]*(?=[\s/>])|!--)/i.test(text);
}

export function slugify(str) {
  return str.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function buildCreativeDetailReq({ advertiserId, creativeId }) {
  return { 1: advertiserId, 2: creativeId, 5: { 1: 1, 2: 28, 3: 2704 } };
}

function calendarDateToIso(value) {
  const parts = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value));
  if (!parts) return null;
  const day = parts.slice(1).join('-');
  const date = new Date(day);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return iso.startsWith(day) ? iso : null;
}

export function parseCreativeRegions(json) {
  // Phản hồi thật đặt danh sách nơi hiển thị ở json["1"]["17"].
  const list = Array.isArray(json?.[1]?.[17]) ? json[1][17] : json?.[17];
  if (!Array.isArray(list)) return null;
  return list.flatMap(region => {
    const regionId = Number(region?.[1]);
    const lastShown = calendarDateToIso(region?.[5]);
    if (!Number.isSafeInteger(regionId) || regionId <= 0 || !lastShown) return [];
    return [{ regionId, firstShown: calendarDateToIso(region[4]), lastShown }];
  });
}

// ISO 3166-1 numeric to alpha-2, including territories.
const countryCodes = new Map(`
  004:AF 008:AL 010:AQ 012:DZ 016:AS 020:AD 024:AO 028:AG 031:AZ 032:AR 036:AU 040:AT
  044:BS 048:BH 050:BD 051:AM 052:BB 056:BE 060:BM 064:BT 068:BO 070:BA 072:BW 074:BV
  076:BR 084:BZ 086:IO 090:SB 092:VG 096:BN 100:BG 104:MM 108:BI 112:BY 116:KH 120:CM
  124:CA 132:CV 136:KY 140:CF 144:LK 148:TD 152:CL 156:CN 158:TW 162:CX 166:CC 170:CO
  174:KM 175:YT 178:CG 180:CD 184:CK 188:CR 191:HR 192:CU 196:CY 203:CZ 204:BJ 208:DK
  212:DM 214:DO 218:EC 222:SV 226:GQ 231:ET 232:ER 233:EE 234:FO 238:FK 239:GS 242:FJ
  246:FI 248:AX 250:FR 254:GF 258:PF 260:TF 262:DJ 266:GA 268:GE 270:GM 275:PS 276:DE
  288:GH 292:GI 296:KI 300:GR 304:GL 308:GD 312:GP 316:GU 320:GT 324:GN 328:GY 332:HT
  334:HM 336:VA 340:HN 344:HK 348:HU 352:IS 356:IN 360:ID 364:IR 368:IQ 372:IE 376:IL
  380:IT 384:CI 388:JM 392:JP 398:KZ 400:JO 404:KE 408:KP 410:KR 414:KW 417:KG 418:LA
  422:LB 426:LS 428:LV 430:LR 434:LY 438:LI 440:LT 442:LU 446:MO 450:MG 454:MW 458:MY
  462:MV 466:ML 470:MT 474:MQ 478:MR 480:MU 484:MX 492:MC 496:MN 498:MD 499:ME 500:MS
  504:MA 508:MZ 512:OM 516:NA 520:NR 524:NP 528:NL 531:CW 533:AW 534:SX 535:BQ 540:NC
  548:VU 554:NZ 558:NI 562:NE 566:NG 570:NU 574:NF 578:NO 580:MP 581:UM 583:FM 584:MH
  585:PW 586:PK 591:PA 598:PG 600:PY 604:PE 608:PH 612:PN 616:PL 620:PT 624:GW 626:TL
  630:PR 634:QA 638:RE 642:RO 643:RU 646:RW 652:BL 654:SH 659:KN 660:AI 662:LC 663:MF
  666:PM 670:VC 674:SM 678:ST 682:SA 686:SN 688:RS 690:SC 694:SL 702:SG 703:SK 704:VN
  705:SI 706:SO 710:ZA 716:ZW 724:ES 728:SS 729:SD 732:EH 740:SR 744:SJ 748:SZ 752:SE
  756:CH 760:SY 762:TJ 764:TH 768:TG 772:TK 776:TO 780:TT 784:AE 788:TN 792:TR 795:TM
  796:TC 798:TV 800:UG 804:UA 807:MK 818:EG 826:GB 831:GG 832:JE 833:IM 834:TZ 840:US
  850:VI 854:BF 858:UY 860:UZ 862:VE 876:WF 882:WS 887:YE 894:ZM
`.trim().split(/\s+/).map(entry => {
  const [numeric, alpha2] = entry.split(':');
  return [2000 + Number(numeric), alpha2];
}));

export function regionIdToIso(regionId) {
  return countryCodes.get(regionId) ?? null;
}
