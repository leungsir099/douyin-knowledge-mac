const PROFILE_HOSTS = new Set(["douyin.com", "www.douyin.com"]);

export const creatorLimits = Object.freeze({ min: 1, max: 100, pageSize: 20 });

export function normalizeCreatorLimit(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < creatorLimits.min || numeric > creatorLimits.max) {
    throw new Error(`limit must be an integer between ${creatorLimits.min} and ${creatorLimits.max}`);
  }
  return numeric;
}

export function extractCreatorSecUid(value) {
  const input = String(value || "").trim();
  if (/^MS4wLjAB[A-Za-z0-9_-]+$/u.test(input)) return input;
  let parsed;
  try {
    parsed = new URL(input.startsWith("http") ? input : `https://${input}`);
  } catch {
    return "";
  }
  if (!PROFILE_HOSTS.has(parsed.hostname.toLowerCase())) return "";
  const match = parsed.pathname.match(/^\/user\/([^/?#]+)/u);
  if (!match) return "";
  const secUid = decodeURIComponent(match[1]);
  return /^MS4wLjAB[A-Za-z0-9_-]+$/u.test(secUid) ? secUid : "";
}

function urls(value) {
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(value?.url_list)
      ? value.url_list
      : Array.isArray(value?.urlList)
        ? value.urlList
        : [];
  return candidates
    .map(candidate => typeof candidate === "string" ? candidate : candidate?.src)
    .filter(candidate => /^https?:\/\//iu.test(String(candidate || "")))
    .map(String);
}

export function mapCreatorAweme(aweme, rank, { includePlayUrl = false } = {}) {
  const video = aweme?.video || {};
  const statistics = aweme?.statistics || aweme?.stats || {};
  const author = aweme?.author || {};
  const awemeId = String(aweme?.aweme_id || aweme?.awemeId || "");
  const secUid = String(author?.sec_uid || author?.secUid || "");
  const row = {
    rank: Number(rank || 0),
    aweme_id: awemeId,
    title: String(aweme?.desc || "").trim(),
    author: String(author?.nickname || "").trim(),
    author_sec_uid: secUid,
    duration: Number(video?.duration || 0) / 1000,
    create_time: Number(aweme?.create_time || aweme?.createTime || 0),
    likes: Number(statistics?.digg_count || statistics?.diggCount || 0),
    collects: Number(statistics?.collect_count || statistics?.collectCount || 0),
    comments: Number(statistics?.comment_count || statistics?.commentCount || 0),
    shares: Number(statistics?.share_count || statistics?.shareCount || 0),
    source_url: awemeId ? `https://www.douyin.com/video/${awemeId}` : "",
    profile_url: secUid ? `https://www.douyin.com/user/${secUid}` : "",
  };
  if (includePlayUrl) row.play_url = urls(video?.play_addr || video?.playAddr)[0] || "";
  return row;
}

export function mergeCreatorPages(pages, limit, { includePlayUrl = false, secUid = "" } = {}) {
  const normalizedLimit = normalizeCreatorLimit(limit);
  const seen = new Set();
  const output = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    for (const item of Array.isArray(page?.items) ? page.items : []) {
      const mapped = mapCreatorAweme(item, output.length + 1, { includePlayUrl });
      if (!mapped.aweme_id || seen.has(mapped.aweme_id)) continue;
      if (secUid && mapped.author_sec_uid && mapped.author_sec_uid !== secUid) continue;
      seen.add(mapped.aweme_id);
      output.push(mapped);
      if (output.length >= normalizedLimit) return output;
    }
  }
  return output;
}

export function normalizeCreatorCandidates(candidates, limit = 8) {
  const seen = new Set();
  const output = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const secUid = extractCreatorSecUid(candidate?.profile_url || candidate?.sec_uid || "");
    if (!secUid || seen.has(secUid)) continue;
    seen.add(secUid);
    const rawNickname = String(candidate?.nickname || "").replace(/\s+/gu, " ").trim();
    const nickname = rawNickname.split(/\s*(?:关注|抖音号[:：])\s*/u)[0].trim();
    const rawSummary = String(candidate?.sample_title || "").replace(/\s+/gu, " ").trim();
    let douyinId = String(candidate?.douyin_id || rawSummary.match(/抖音号[:：]\s*([A-Za-z0-9._-]+)/u)?.[1] || "");
    if (/\d+\.\d+$/u.test(douyinId) && rawSummary.includes(`${douyinId}万获赞`)) douyinId = "";
    const summaryWithoutContacts = rawSummary
      .replace(/(?:商务合作|商业合作|合作请联系|微信|V信|vx)[:：]?[^。；;]*/giu, "[contact redacted]")
      .replace(/\b\d{6,}(?:\.\d+)?\b/gu, value => value === douyinId ? value : "[redacted-number]");
    output.push({
      rank: output.length + 1,
      sec_uid: secUid,
      nickname: (nickname || rawNickname).slice(0, 120),
      douyin_id: douyinId.slice(0, 80),
      profile_url: `https://www.douyin.com/user/${secUid}`,
      sample_title: summaryWithoutContacts.slice(0, 240),
    });
    if (output.length >= limit) break;
  }
  return output;
}
