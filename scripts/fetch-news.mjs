#!/usr/bin/env node
// Fetches the single most recent news item for each of four healthcare
// professions (veterinarian, doctor, pharmacist, dentist) from Google
// News RSS and writes the result to news.json at the repo root.
//
// Zero npm dependencies on purpose: uses Node's built-in fetch and a
// small regex-based RSS parser, so it runs unmodified on GitHub Actions
// runners (see .github/workflows/daily-news.yml, which runs this daily
// so news.json is refreshed before 8am KST).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROFESSIONS = [
  { key: "vet", label: "수의사", query: "수의사 정책 OR 수의사법 OR 동물병원 진료비" },
  { key: "doctor", label: "의사", query: "의사 파업 OR 의료개혁 OR 전공의 정책" },
  { key: "pharmacist", label: "약사", query: "약사 정책 OR 성분명처방 OR 약사회" },
  { key: "dentist", label: "치과의사", query: "치과의사 정책 OR 치과의사 국가시험" },
];

const FEED_BASE = "https://news.google.com/rss/search";
const OUTPUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "news.json"
);

function extractTag(block, tag) {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`,
    "i"
  );
  const match = block.match(re);
  return match ? match[1].trim() : "";
}

function parseItems(xml) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const items = [];
  for (const block of blocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const source = extractTag(block, "source");
    const pubDateRaw = extractTag(block, "pubDate");
    const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;
    if (!title || !link || !pubDate || Number.isNaN(pubDate.getTime())) continue;
    items.push({ title, link, source, pubDate });
  }
  return items;
}

async function fetchLatest(profession) {
  const url = `${FEED_BASE}?q=${encodeURIComponent(profession.query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; daily-healthcare-news-bot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`${profession.label} feed request failed: HTTP ${res.status}`);
  }
  const xml = await res.text();
  const items = parseItems(xml).sort((a, b) => b.pubDate - a.pubDate);
  const top = items[0];
  if (!top) return null;

  let title = top.title;
  if (top.source && title.endsWith(` - ${top.source}`)) {
    title = title.slice(0, -(top.source.length + 3)).trim();
  }

  return {
    profession: profession.key,
    professionLabel: profession.label,
    title,
    source: top.source || null,
    link: top.link,
    publishedAt: top.pubDate.toISOString(),
  };
}

async function main() {
  const results = await Promise.all(
    PROFESSIONS.map((profession) =>
      fetchLatest(profession).catch((err) => {
        console.error(`[${profession.label}] ${err.message}`);
        return null;
      })
    )
  );
  const items = results.filter(Boolean);

  if (!items.length) {
    console.error("No news items were fetched successfully; leaving news.json unchanged.");
    process.exit(1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    items,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${items.length} item(s) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
