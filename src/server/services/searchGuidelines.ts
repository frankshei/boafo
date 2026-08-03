import { openai } from "./clients";
import { searchGuidelineChunksQuery } from "../db/operations/guidelines";
import type { Finding } from "../../types";

const EMBEDDING_CACHE_MAX = 500;
const embeddingCache = new Map<string, number[]>();

const embedQuery = async (text: string): Promise<number[]> => {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  const embedding = res.data[0].embedding;

  // Evict oldest entry if cache is full
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const firstKey = embeddingCache.keys().next().value!;
    embeddingCache.delete(firstKey);
  }
  embeddingCache.set(text, embedding);

  return embedding;
};

const embedBatch = async (texts: string[]): Promise<number[][]> => {
  // Separate cached vs uncached
  const results: (number[] | null)[] = texts.map((t) => embeddingCache.get(t) || null);
  const uncached = texts.filter((_, i) => !results[i]);

  if (uncached.length > 0) {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: uncached,
    });
    // OpenAI may return embeddings out of order — sort by index
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((d) => d.embedding);

    // Cache and fill results
    let j = 0;
    for (let i = 0; i < texts.length; i++) {
      if (!results[i]) {
        results[i] = embeddings[j];
        if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
          const firstKey = embeddingCache.keys().next().value!;
          embeddingCache.delete(firstKey);
        }
        embeddingCache.set(texts[i], embeddings[j]);
        j++;
      }
    }
  }

  return results as number[][];
};

const MIN_SIMILARITY = 0.50;

const RESULT_CACHE_MAX = 200;
const RESULT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
type CachedResult = { data: ReturnType<typeof Array.from<any>>; expiry: number };
const resultCache = new Map<string, CachedResult>();

const getResultCacheKey = (condition: string, findings: Finding[], limit: number) =>
  `${condition}::${findings.map((f) => `${f.category}:${f.value}`).join("|")}::${limit}`;

const searchGuidelines = async (
  condition: string,
  findings: Finding[],
  limit: number = 5,
) => {
  // Check result cache
  const cacheKey = getResultCacheKey(condition, findings, limit);
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }
  if (cached) resultCache.delete(cacheKey); // expired

  // Build both queries upfront
  const findingsQuery = [
    condition,
    ...findings.map((f) => `${f.category}: ${f.value}`),
  ].join(". ");

  // Parallelize both embedding calls
  const [conditionEmbedding, findingsEmbedding] = await Promise.all([
    embedQuery(condition),
    embedQuery(findingsQuery),
  ]);

  // Parallelize both DB searches
  const [conditionChunks, findingsChunks] = await Promise.all([
    searchGuidelineChunksQuery(conditionEmbedding, limit),
    searchGuidelineChunksQuery(findingsEmbedding, limit),
  ]);

  // Dedupe by chunkid, keep highest similarity
  const seen = new Map<string, typeof conditionChunks[0]>();
  for (const chunk of [...conditionChunks, ...findingsChunks]) {
    const existing = seen.get(chunk.chunkid);
    if (!existing || chunk.similarity > existing.similarity) {
      seen.set(chunk.chunkid, chunk);
    }
  }

  // Re-rank: boost similarity for chunks containing finding keywords
  const findingTerms = findings.map((f) => f.value.toLowerCase());
  const reranked = Array.from(seen.values()).map((chunk) => {
    const lower = chunk.content.toLowerCase();
    const matches = findingTerms.filter((term) => lower.includes(term)).length;
    const boost = matches * 0.01;
    return { ...chunk, similarity: chunk.similarity + boost };
  });

  const sorted = reranked.sort((a, b) => b.similarity - a.similarity);
  console.log(`\n[searchGuidelines] condition: "${condition}"`);
  console.log(`[searchGuidelines] top scores (before filter):`, sorted.slice(0, 5).map((c) => ({ similarity: c.similarity.toFixed(4), section: c.section?.substring(0, 80) })));
  console.log(`[searchGuidelines] passed ${MIN_SIMILARITY} threshold: ${sorted.filter((c) => c.similarity >= MIN_SIMILARITY).length}/${sorted.length}`);

  const results = sorted
    .filter((c) => c.similarity >= MIN_SIMILARITY)
    .slice(0, limit);

  // Cache the results
  if (resultCache.size >= RESULT_CACHE_MAX) {
    const firstKey = resultCache.keys().next().value!;
    resultCache.delete(firstKey);
  }
  resultCache.set(cacheKey, { data: results, expiry: Date.now() + RESULT_CACHE_TTL });

  return results;
};

// Cap concurrent guideline searches below the pg pool size (db max: 10) so a
// large differential fan-out can't exhaust the connection pool.
const GUIDELINE_SEARCH_CONCURRENCY = 6;

async function mapWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  );
  return results;
};

const searchGuidelinesAll = async (
  diagnoses: { condition: string }[],
  findings: Finding[],
  limit: number = 5,
) => {
  // Build all query texts upfront (2 per diagnosis: condition, condition+findings)
  const queryTexts: string[] = [];
  for (const d of diagnoses) {
    queryTexts.push(d.condition);
    queryTexts.push(
      [d.condition, ...findings.map((f) => `${f.category}: ${f.value}`)].join(". "),
    );
  }

  // Single batched embedding call for all texts
  const allEmbeddings = await embedBatch(queryTexts);

  // Run DB searches with bounded concurrency. An unbounded Promise.all here
  // fanned out 2 queries per diagnosis into a 5-connection pool, starving it and
  // causing "timeout exceeded when trying to connect" -> hung assessments.
  const searchTasks: Array<() => Promise<any[]>> = [];
  for (let i = 0; i < diagnoses.length; i++) {
    searchTasks.push(() => searchGuidelineChunksQuery(allEmbeddings[i * 2], limit));
    searchTasks.push(() => searchGuidelineChunksQuery(allEmbeddings[i * 2 + 1], limit));
  }
  const allChunks = await mapWithConcurrency(searchTasks, GUIDELINE_SEARCH_CONCURRENCY);

  // Process results per diagnosis (same dedupe/rerank logic as searchGuidelines)
  const findingTerms = findings.map((f) => f.value.toLowerCase());
  const results = diagnoses.map((d, i) => {
    const cacheKey = getResultCacheKey(d.condition, findings, limit);
    const cached = resultCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) return cached.data;

    const conditionChunks = allChunks[i * 2];
    const findingsChunks = allChunks[i * 2 + 1];

    const seen = new Map<string, typeof conditionChunks[0]>();
    for (const chunk of [...conditionChunks, ...findingsChunks]) {
      const existing = seen.get(chunk.chunkid);
      if (!existing || chunk.similarity > existing.similarity) {
        seen.set(chunk.chunkid, chunk);
      }
    }

    const reranked = Array.from(seen.values()).map((chunk) => {
      const lower = chunk.content.toLowerCase();
      const matches = findingTerms.filter((term) => lower.includes(term)).length;
      return { ...chunk, similarity: chunk.similarity + matches * 0.01 };
    });

    const sorted = reranked.sort((a, b) => b.similarity - a.similarity);
    const filtered = sorted.filter((c) => c.similarity >= MIN_SIMILARITY).slice(0, limit);

    if (resultCache.size >= RESULT_CACHE_MAX) {
      const firstKey = resultCache.keys().next().value!;
      resultCache.delete(firstKey);
    }
    resultCache.set(cacheKey, { data: filtered, expiry: Date.now() + RESULT_CACHE_TTL });

    return filtered;
  });

  return results;
};

export { embedQuery, searchGuidelines, searchGuidelinesAll };
