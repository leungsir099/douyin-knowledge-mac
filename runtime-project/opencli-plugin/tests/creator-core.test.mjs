import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCreatorSecUid,
  mapCreatorAweme,
  mergeCreatorPages,
  normalizeCreatorCandidates,
  normalizeCreatorLimit,
} from "../lib/creator-core.mjs";

test("extracts creator sec_uid only from supported profile inputs", () => {
  const secUid = "MS4wLjABAAAA-example_123";
  assert.equal(extractCreatorSecUid(secUid), secUid);
  assert.equal(extractCreatorSecUid(`https://www.douyin.com/user/${secUid}?from_tab_name=main`), secUid);
  assert.equal(extractCreatorSecUid(`www.douyin.com/user/${secUid}`), secUid);
  assert.equal(extractCreatorSecUid("https://www.douyin.com/user/self"), "");
  assert.equal(extractCreatorSecUid("https://example.com/user/MS4wLjABAAAA-bad"), "");
  assert.equal(extractCreatorSecUid("博主名称"), "");
});

test("normalizes creator limits and rejects unbounded collection", () => {
  assert.equal(normalizeCreatorLimit(30), 30);
  assert.throws(() => normalizeCreatorLimit(0), /between 1 and 100/u);
  assert.throws(() => normalizeCreatorLimit(101), /between 1 and 100/u);
});

test("maps creator videos without exposing transient media URLs by default", () => {
  const aweme = {
    aweme_id: "7000000000000000001",
    desc: "标题",
    create_time: 123,
    author: { nickname: "作者", sec_uid: "MS4wLjABAAAA-example_123" },
    statistics: { digg_count: 4, collect_count: 3, comment_count: 2, share_count: 1 },
    video: { duration: 12000, play_addr: { url_list: ["https://signed.example/video?token=secret"] } },
  };
  const safe = mapCreatorAweme(aweme, 1);
  assert.equal(safe.duration, 12);
  assert.equal("play_url" in safe, false);
  const downloadable = mapCreatorAweme(aweme, 1, { includePlayUrl: true });
  assert.match(downloadable.play_url, /^https:\/\//u);
});

test("merges paginated creator videos by aweme id and keeps requested author", () => {
  const author = { nickname: "作者", sec_uid: "MS4wLjABAAAA-example_123" };
  const pages = [
    { items: [{ aweme_id: "1", author }, { aweme_id: "2", author }] },
    { items: [{ aweme_id: "2", author }, { aweme_id: "3", author: { ...author, sec_uid: "MS4wLjABAAAA-other" } }] },
  ];
  assert.deepEqual(
    mergeCreatorPages(pages, 30, { secUid: author.sec_uid }).map(item => item.aweme_id),
    ["1", "2"],
  );
});

test("deduplicates creator search candidates", () => {
  const candidates = normalizeCreatorCandidates([
    { profile_url: "https://www.douyin.com/user/MS4wLjABAAAA-a", nickname: "A", sample_title: "一" },
    { sec_uid: "MS4wLjABAAAA-a", nickname: "A2", sample_title: "二" },
    { sec_uid: "MS4wLjABAAAA-b", nickname: "B", sample_title: "三" },
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].nickname, "A");
});

test("trims search-card metadata from creator nicknames", () => {
  const candidates = normalizeCreatorCandidates([
    {
      sec_uid: "MS4wLjABAAAA-a",
      douyin_id: "demo_creator_001",
      nickname: "示例博主 关注 抖音号: demo_creator_001 47.4万获赞",
      sample_title: "示例博主 关注 抖音号: demo_creator_00147.4万获赞2.3万粉丝",
    },
  ]);
  assert.equal(candidates[0].nickname, "示例博主");
  assert.equal(candidates[0].douyin_id, "demo_creator_001");
});

test("redacts contact-like candidate metadata while preserving the Douyin id", () => {
  const candidates = normalizeCreatorCandidates([{
    sec_uid: "MS4wLjABAAAA-a",
    nickname: "作者 关注 抖音号: creator_1",
    sample_title: "作者 抖音号: creator_1 商务合作：L1213812131",
  }]);
  assert.equal(candidates[0].douyin_id, "creator_1");
  assert.doesNotMatch(candidates[0].sample_title, /1213812131/u);
});

test("drops a Douyin id when the rendered card fused it with the likes count", () => {
  const candidates = normalizeCreatorCandidates([{
    sec_uid: "MS4wLjABAAAA-a",
    nickname: "作者 关注 抖音号: 12345678947.4万获赞",
    douyin_id: "12345678947.4",
    sample_title: "作者 关注 抖音号: 12345678947.4万获赞",
  }]);
  assert.equal(candidates[0].douyin_id, "");
});
