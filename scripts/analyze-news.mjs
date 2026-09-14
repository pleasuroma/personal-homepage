#!/usr/bin/env node
// Enriches news.json with a Korean summary and a conflict analysis for each
// headline, using the Claude API with the server-side web search tool.
//
// scripts/fetch-news.mjs only gets titles and links out of the RSS feed, so
// Claude researches each headline itself before writing. Run it after the
// fetch step (see .github/workflows/daily-news.yml).
//
// Requires ANTHROPIC_API_KEY. Without it the script exits 0 without touching
// news.json, so a missing key degrades the page to headlines only rather than
// failing the daily run.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const NEWS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "news.json"
);

const MODEL = "claude-sonnet-5";

const AnalysisSchema = z.object({
  analyses: z.array(
    z.object({
      index: z
        .number()
        .describe("분석 대상 기사의 0-based 인덱스. 입력 순서와 같아야 한다."),
      summary: z
        .string()
        .describe(
          "기사 내용 요약. 공백 포함 500자 이내의 한국어. 확인된 사실만 쓰고 추측은 넣지 않는다."
        ),
      hasConflict: z
        .boolean()
        .describe("이해관계가 충돌하는 사안이면 true, 아니면 false."),
      surfaceClaims: z
        .array(
          z.object({
            party: z.string().describe("당사자 이름 (예: 정부, 대한수의사회)"),
            claim: z.string().describe("그 당사자가 공개적으로 내세우는 주장"),
          })
        )
        .describe(
          "각 당사자의 표면적 주장. 갈등이 없는 사안이면 빈 배열."
        ),
      hiddenMotives: z
        .array(
          z.object({
            party: z.string().describe("당사자 이름"),
            motive: z
              .string()
              .describe(
                "공개적으로 내세우지 않지만 이해관계 구조상 작동할 수 있는 동기. 확인된 사실이 아니라 추론임이 드러나게 쓴다."
              ),
          })
        )
        .describe(
          "드러나지 않는 동기에 대한 구조적 추론. 갈등이 없는 사안이면 빈 배열이거나, 사안을 둘러싼 이해구조에 대한 분석."
        ),
    })
  ),
});

const SYSTEM_PROMPT = `당신은 한국 보건의료 정책을 오래 취재한 분석가다. 수의사·의사·약사·치과의사 직역의 현안을 다룬다.

작업 순서:
1. 주어진 각 기사 제목을 web_search로 조사한다. 제목만 보고 내용을 추측하지 말고 반드시 검색해서 확인한다.
2. 확인된 내용으로 500자 이내 요약을 쓴다.
3. 이해관계 충돌이 있으면 각 당사자의 표면적 주장과, 드러나지 않는 동기를 분석한다.

드러나지 않는 동기를 쓸 때 지켜야 할 원칙:
- 검증 가능한 구조적 사실(경제적 유인, 제도의 역사, 유사 선례, 소관 부처)에 근거해야 한다. 근거 없는 억측은 쓰지 않는다.
- 당사자가 실제로 그렇게 생각한다고 단정하지 않는다. "~구조다", "~로 읽힌다", "~할 유인이 있다"처럼 추론임이 드러나게 쓴다.
- 어느 한쪽 편을 들지 않는다. 갈등의 모든 당사자(정부·직역단체·기업·소비자)를 같은 기준으로 본다.
- 사적 이해를 공적 명분으로 번역한 지점이 있으면 짚되, 그 명분 자체가 타당할 수 있다는 점도 함께 밝힌다.
- 조사해도 근거를 못 찾으면 빈 배열을 반환한다. 채우기 위해 지어내지 않는다.

갈등이 드러나지 않는 기사라도, 그 사안을 둘러싼 이해구조가 있으면 hiddenMotives에 담는다.

모든 출력은 한국어로 쓴다.`;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY not set — skipping analysis.");
    return;
  }

  const news = JSON.parse(await readFile(NEWS_PATH, "utf8"));
  const items = news.items || [];
  if (!items.length) {
    console.log("No items in news.json — nothing to analyze.");
    return;
  }

  const headlines = items
    .map(
      (item, i) =>
        `[${i}] 직역: ${item.professionLabel} / 제목: ${item.title} / 매체: ${item.source || "미상"} / 보도일: ${item.publishedAt}`
    )
    .join("\n");

  // 10분 기본 타임아웃으로는 웹 검색 + 분석이 잘릴 수 있어 20분으로 늘린다.
  const client = new Anthropic({ timeout: 20 * 60 * 1000 });

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: zodOutputFormat(AnalysisSchema),
    },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 16 }],
    messages: [
      {
        role: "user",
        content: `오늘 날짜는 ${new Date().toISOString().slice(0, 10)}이다. 아래 ${items.length}건의 기사를 각각 조사해 분석하라.\n\n${headlines}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Model refused: ${response.stop_details?.category ?? "unknown"}`
    );
  }

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("Structured output could not be parsed.");
  }

  let applied = 0;
  for (const analysis of parsed.analyses) {
    const item = items[analysis.index];
    if (!item) {
      console.error(`Skipping out-of-range index ${analysis.index}.`);
      continue;
    }
    item.summary = analysis.summary;
    item.analysis = {
      hasConflict: analysis.hasConflict,
      surfaceClaims: analysis.surfaceClaims,
      hiddenMotives: analysis.hiddenMotives,
    };
    applied += 1;
  }

  news.analyzedAt = new Date().toISOString();
  news.analysisModel = MODEL;

  await writeFile(NEWS_PATH, JSON.stringify(news, null, 2) + "\n");

  const usage = response.usage;
  console.log(
    `Analyzed ${applied}/${items.length} item(s). ` +
      `Tokens in/out: ${usage.input_tokens}/${usage.output_tokens}`
  );
}

main().catch((err) => {
  if (err instanceof Anthropic.APIError) {
    console.error(`Claude API error ${err.status}: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
