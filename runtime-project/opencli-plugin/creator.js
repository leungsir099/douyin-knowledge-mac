import { cli, Strategy } from "@jackwener/opencli/registry";
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from "@jackwener/opencli/errors";
import {
  creatorLimits,
  extractCreatorSecUid,
  mergeCreatorPages,
  normalizeCreatorCandidates,
  normalizeCreatorLimit,
} from "./lib/creator-core.mjs";

function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}

function parseLimit(value) {
  try {
    return normalizeCreatorLimit(value);
  } catch (error) {
    throw new ArgumentError(`douyin creator-videos ${String(error?.message || error)}`);
  }
}

async function fetchCreatorPages(page, secUid, limit, includePlayUrl) {
  const payload = unwrapEvaluateResult(await page.evaluate(`
    (async () => {
      const secUid = ${JSON.stringify(secUid)};
      const limit = ${JSON.stringify(limit)};
      const pageSize = ${JSON.stringify(creatorLimits.pageSize)};
      const includePlayUrl = ${includePlayUrl ? "true" : "false"};
      const output = [];
      let cursor = '0';
      let pageNumber = 0;
      const urls = (value) => {
        const candidates = Array.isArray(value)
          ? value
          : Array.isArray(value?.url_list)
            ? value.url_list
            : Array.isArray(value?.urlList)
              ? value.urlList
              : [];
        return candidates
          .map(candidate => typeof candidate === 'string' ? candidate : candidate?.src)
          .filter(candidate => /^https?:\\/\\//i.test(String(candidate || '')))
          .map(String);
      };
      const sanitize = (aweme) => {
        const video = aweme?.video || {};
        const item = {
          aweme_id: String(aweme?.aweme_id || aweme?.awemeId || ''),
          desc: String(aweme?.desc || ''),
          create_time: Number(aweme?.create_time || aweme?.createTime || 0),
          author: {
            nickname: String(aweme?.author?.nickname || ''),
            sec_uid: String(aweme?.author?.sec_uid || aweme?.author?.secUid || '')
          },
          statistics: {
            digg_count: Number(aweme?.statistics?.digg_count || aweme?.statistics?.diggCount || 0),
            collect_count: Number(aweme?.statistics?.collect_count || aweme?.statistics?.collectCount || 0),
            comment_count: Number(aweme?.statistics?.comment_count || aweme?.statistics?.commentCount || 0),
            share_count: Number(aweme?.statistics?.share_count || aweme?.statistics?.shareCount || 0)
          },
          video: { duration: Number(video?.duration || 0) }
        };
        if (includePlayUrl) item.video.play_addr = { url_list: urls(video?.play_addr || video?.playAddr) };
        return item;
      };
      while (output.reduce((count, entry) => count + entry.items.length, 0) < limit && pageNumber < 10) {
        const params = new URLSearchParams({
          sec_user_id: secUid,
          max_cursor: cursor,
          count: String(Math.min(pageSize, limit)),
          aid: '6383'
        });
        const response = await fetch('/aweme/v1/web/aweme/post/?' + params.toString(), {
          credentials: 'include',
          headers: { accept: 'application/json, text/plain, */*' }
        });
        if (!response.ok) return { state: 'http_error', status: response.status, pages: output };
        const data = await response.json();
        const items = (Array.isArray(data?.aweme_list) ? data.aweme_list : [])
          .map(sanitize)
          .filter(item => item.aweme_id);
        output.push({ cursor, items });
        const next = String(data?.max_cursor ?? data?.cursor ?? '');
        const hasMore = Boolean(data?.has_more ?? data?.hasMore);
        if (!hasMore || !next || next === cursor || items.length === 0) break;
        cursor = next;
        pageNumber += 1;
      }
      return { state: 'ok', pages: output };
    })()
  `));
  if (!payload || typeof payload !== "object") {
    throw new CommandExecutionError("Douyin creator video request returned an unexpected payload");
  }
  if (payload.state === "http_error") {
    if (Number(payload.status) === 401 || Number(payload.status) === 403) {
      throw new AuthRequiredError("www.douyin.com", "Douyin creator videos require a logged-in browser session.");
    }
    throw new CommandExecutionError(`Douyin creator video request failed with HTTP ${payload.status}`);
  }
  return Array.isArray(payload.pages) ? payload.pages : [];
}

async function searchCreatorCandidates(page, query, limit) {
  let suppliedUrl = null;
  try {
    const parsed = new URL(query);
    if (/(^|\.)douyin\.com$/iu.test(parsed.hostname)) suppliedUrl = parsed.href;
  } catch {}
  if (suppliedUrl) {
    await page.goto(suppliedUrl);
    await page.wait(3);
    const resolved = unwrapEvaluateResult(await page.evaluate(`(() => ({
      profile_url: String(location.href || ''),
      nickname: String(document.title || '').replace(/[-_–—|].*$/, '').trim(),
      sample_title: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240)
    }))()`));
    const direct = normalizeCreatorCandidates([resolved], 1);
    if (direct.length) return direct;
    throw new EmptyResultError("douyin creator-search", "The supplied Douyin URL did not resolve to a creator profile.");
  }
  await page.goto(`https://www.douyin.com/search/${encodeURIComponent(query)}?type=user`);
  const payload = unwrapEvaluateResult(await page.evaluate(`
    new Promise((resolve) => {
      const collect = () => {
        const candidates = [];
        for (const link of document.querySelectorAll('a[href*="/user/"]')) {
          const href = String(link.href || link.getAttribute('href') || '');
          const match = href.match(/\\/user\\/([^/?#]+)/);
          if (!match) continue;
          const container = link.closest('li, [data-e2e], article, section, div');
          const text = String(container?.innerText || link.innerText || '').replace(/\\s+/g, ' ').trim();
          const leafTexts = Array.from(container?.querySelectorAll('*') || [])
            .filter(element => element.children.length === 0)
            .map(element => String(element.textContent || '').trim())
            .filter(Boolean);
          const douyinIdText = leafTexts.find(value => /抖音号[:：]/.test(value)) || '';
          const douyinId = douyinIdText.match(/抖音号[:：]\\s*([A-Za-z0-9._-]+)/)?.[1] || '';
          const nickname = String(link.innerText || link.getAttribute('title') || '')
            .replace(/\\s+/g, ' ').trim();
          candidates.push({
            sec_uid: decodeURIComponent(match[1]),
            nickname,
            douyin_id: douyinId,
            profile_url: 'https://www.douyin.com/user/' + decodeURIComponent(match[1]),
            sample_title: text.slice(0, 240)
          });
        }
        return candidates;
      };
      const detect = () => {
        const candidates = collect();
        if (candidates.length) return { state: 'ok', candidates };
        const text = String(document.body?.innerText || '');
        if (/登录后查看|请先登录|登录抖音|验证码|安全校验/.test(text)) return { state: 'login_wall', candidates: [] };
        if (/暂无相关搜索结果|没有找到相关结果|暂无结果/.test(text)) return { state: 'empty', candidates: [] };
        return null;
      };
      const first = detect();
      if (first) return resolve(first);
      const observer = new MutationObserver(() => {
        const result = detect();
        if (result) { observer.disconnect(); resolve(result); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(detect() || { state: 'timeout', candidates: [] });
      }, 15000);
    })
  `));
  if (payload?.state === "login_wall") {
    throw new AuthRequiredError("www.douyin.com", "Douyin creator search requires a logged-in browser session.");
  }
  if (payload?.state === "timeout") {
    throw new CommandExecutionError("Douyin creator search did not render user candidates within the timeout");
  }
  const candidates = normalizeCreatorCandidates(payload?.candidates, limit);
  if (!candidates.length) throw new EmptyResultError("douyin creator-search", `No creator matched "${query}".`);
  return candidates;
}

cli({
  site: "douyin",
  name: "creator-search",
  access: "read",
  description: "按名称或抖音号查找博主候选，供用户确认",
  domain: "www.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "query", required: true, positional: true, help: "博主名称或抖音号" },
    { name: "limit", type: "int", default: 8, help: "候选数量（最大 20）" },
  ],
  columns: ["rank", "nickname", "douyin_id", "sec_uid", "profile_url", "sample_title"],
  func: async (page, kwargs) => {
    const query = String(kwargs.query || "").trim();
    if (!query) throw new ArgumentError("douyin creator-search requires a name or Douyin id");
    const limit = Math.min(20, Math.max(1, Number(kwargs.limit || 8)));
    return searchCreatorCandidates(page, query, limit);
  },
});

cli({
  site: "douyin",
  name: "creator-videos",
  access: "read",
  description: "分页读取指定博主的公开作品",
  domain: "www.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "sec_uid", required: true, positional: true, help: "主页 URL 中的 sec_uid" },
    { name: "limit", type: "int", default: 30, help: "作品数量（1-100）" },
    { name: "include_play_url", type: "bool", default: false, help: "仅供立即冻结媒体的内部流程使用" },
  ],
  columns: [
    "rank", "aweme_id", "title", "author", "author_sec_uid", "duration", "create_time",
    "likes", "collects", "comments", "shares", "source_url", "profile_url", "play_url",
  ],
  func: async (page, kwargs) => {
    const secUid = extractCreatorSecUid(String(kwargs.sec_uid || ""));
    if (!secUid) throw new ArgumentError("douyin creator-videos requires a valid sec_uid or profile URL");
    const limit = parseLimit(kwargs.limit);
    const includePlayUrl = kwargs.include_play_url === true;
    await page.goto(`https://www.douyin.com/user/${secUid}`);
    await page.wait(2);
    const pages = await fetchCreatorPages(page, secUid, limit, includePlayUrl);
    const rows = mergeCreatorPages(pages, limit, { includePlayUrl, secUid });
    if (!rows.length) {
      throw new EmptyResultError(
        "douyin creator-videos",
        `No public videos were returned for ${secUid}. Confirm the profile and browser login.`,
      );
    }
    return rows;
  },
});
