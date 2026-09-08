import { requirePublishSecret } from './_lib/auth.js';

const GITHUB_REPO = process.env.PUBLISH_TARGET_REPO || (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}` : 'SkyYield-LLC/TravelOperator');
const GITHUB_BRANCH = 'main';

// dynamic-affiliates:auto-managed
// Load affiliate registry from src/data/affiliates.json via GitHub Contents API.
// Source of truth: stacksites-admin commits → next cron picks up new URLs.
async function loadAffiliatePrograms(githubToken) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/src/data/affiliates.json?ref=${GITHUB_BRANCH}`,
      { headers: ghHeaders(githubToken) }
    );
    if (!res.ok) return {};
    const file = await res.json();
    const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8'));
    const list = Array.isArray(data) ? data : (data.affiliates ?? []);
    const map = {};
    for (const a of list) {
      if (!a || !a.slug || !a.url) continue;
      map[a.slug] = {
        name: a.name || a.slug,
        primaryLink: a.url,
        commission: a.commission || '',
        network: a.network || 'direct',
      };
    }
    return map;
  } catch (_) {
    return {};
  }
}

// publish-gate:v1 — Product fallback registry + auto-heal
async function loadProductRegistry(githubToken) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/src/data/products.json?ref=${GITHUB_BRANCH}`,
      { headers: ghHeaders(githubToken) }
    );
    if (!res.ok) return {};
    const file = await res.json();
    const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8'));
    return (data && typeof data === 'object') ? data : {};
  } catch (_) { return {}; }
}

// Rewrites every /recommends/<slug> in the generated article:
//   - if slug is registered as an affiliate → normalize to relative /recommends/<slug>
//   - else if slug is in the product registry → replace with product homepage + rel="nofollow noopener sponsored"
//   - else → strip href (prevents 404s escaping into the article)
function autoHealRecommends(content, AFFILIATE_PROGRAMS, PRODUCT_REGISTRY) {
  const changes = [];
  const re = /(href=)(['"])([^'"]*\/recommends\/([a-z0-9-]+))(['"])/gi;
  const healed = content.replace(re, (m, attr, q, _url, slug, qq) => {
    if (AFFILIATE_PROGRAMS[slug]) {
      changes.push({ slug, action: 'ok' });
      return `${attr}${q}/recommends/${slug}${qq}`;
    }
    const product = PRODUCT_REGISTRY[slug];
    if (product) {
      changes.push({ slug, action: 'product-fallback' });
      return `${attr}${q}${product}${qq} rel=${q}nofollow noopener sponsored${qq}`;
    }
    changes.push({ slug, action: 'unknown' });
    return `${attr}${q}#${qq} data-fix=${q}unknown-slug-${slug}${qq}`;
  });
  return { healed, changes };
}
export default async function handler(req, res) {
  if (!requirePublishSecret(req, res)) return;
  const githubToken = process.env.GITHUB_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!githubToken || !anthropicKey) {
    return res.status(500).json({ error: 'Missing GITHUB_TOKEN or ANTHROPIC_API_KEY' });
  }

  // ── Step 0: Load latest affiliate registry from the repo ──
  const AFFILIATE_PROGRAMS = await loadAffiliatePrograms(githubToken);
  const PRODUCT_REGISTRY = await loadProductRegistry(githubToken);

  // ── Step 1: Read queue.json from GitHub ──
  let queueData, queueSha;
  try {
    const queueRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/queue.json?ref=${GITHUB_BRANCH}`,
      { headers: ghHeaders(githubToken) }
    );
    if (!queueRes.ok) {
      return res.status(500).json({ error: 'Failed to read queue.json', status: queueRes.status });
    }
    const queueFile = await queueRes.json();
    queueSha = queueFile.sha;
    queueData = JSON.parse(Buffer.from(queueFile.content, 'base64').toString('utf-8'));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to parse queue.json', detail: err.message });
  }

  // ── Step 2: Find next queued article ──
  const nextIndex = queueData.articles.findIndex((a) => a.status === 'queued');
  if (nextIndex === -1) {
    return res.status(200).json({ published: false, message: 'Queue empty' });
  }
  const article = queueData.articles[nextIndex];

  // ── Step 3: Generate article via Claude ──
  const today = new Date().toISOString().split('T')[0];
  let generatedContent;
  try {
    generatedContent = await callClaude(anthropicKey, article, today, AFFILIATE_PROGRAMS);
  } catch (err) {
    return res.status(500).json({ error: 'Claude API failed', detail: err.message });
  }

  if (!generatedContent) {
    return res.status(500).json({ error: 'Empty content from Claude' });
  }

  // publish-gate:v1 — auto-heal /recommends/ hrefs against registered affiliates + product fallbacks
  {
    const healResult = autoHealRecommends(generatedContent, AFFILIATE_PROGRAMS, PRODUCT_REGISTRY);
    generatedContent = healResult.healed;
    const counts = healResult.changes.reduce((acc, c) => (acc[c.action] = (acc[c.action] || 0) + 1, acc), {});
    console.log(`[publish-gate] ${article.slug}: ${JSON.stringify(counts)}`);
    const unknowns = [...new Set(healResult.changes.filter(c => c.action === 'unknown').map(c => c.slug))];
    if (unknowns.length) {
      console.warn(`[publish-gate] ${article.slug} unknown slugs (add to affiliates.json or products.json): ${unknowns.join(', ')}`);
    }
  }

  // ── Step 4: Determine file path ──
  const filePath = getFilePath(article.category, article.slug);

  // ── Step 5: Check if file already exists (need sha for update) ──
  let existingSha = null;
  try {
    const existingRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`,
      { headers: ghHeaders(githubToken) }
    );
    if (existingRes.ok) {
      const existing = await existingRes.json();
      existingSha = existing.sha;
    }
  } catch (_) {
    // File doesn't exist, that's fine
  }

  // ── Step 6: Commit the generated article ──
  try {
    const commitBody = {
      message: `publish: ${article.title}`,
      content: Buffer.from(generatedContent, 'utf-8').toString('base64'),
      branch: GITHUB_BRANCH,
    };
    if (existingSha) commitBody.sha = existingSha;

    const commitRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: ghHeaders(githubToken),
        body: JSON.stringify(commitBody),
      }
    );
    if (!commitRes.ok) {
      const err = await commitRes.text();
      return res.status(500).json({ error: 'Failed to commit article', detail: err });
    }
  } catch (err) {
    return res.status(500).json({ error: 'GitHub commit failed', detail: err.message });
  }

  // ── Step 7: Re-fetch queue.json for fresh SHA, then update ──
  queueData.articles[nextIndex].status = 'published';
  queueData.articles[nextIndex].publishedDate = today;

  try {
    const freshQueueRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/queue.json?ref=${GITHUB_BRANCH}`,
      { headers: ghHeaders(githubToken) }
    );
    if (!freshQueueRes.ok) {
      return res.status(500).json({ error: 'Failed to re-fetch queue.json for fresh SHA' });
    }
    const freshQueue = await freshQueueRes.json();
    const freshSha = freshQueue.sha;

    const updateRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/queue.json`,
      {
        method: 'PUT',
        headers: ghHeaders(githubToken),
        body: JSON.stringify({
          message: `queue: mark "${article.title}" as published`,
          content: Buffer.from(JSON.stringify(queueData, null, 2) + '\n', 'utf-8').toString('base64'),
          sha: freshSha,
          branch: GITHUB_BRANCH,
        }),
      }
    );
    if (!updateRes.ok) {
      const err = await updateRes.text();
      return res.status(500).json({ error: 'Failed to update queue.json', detail: err });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Queue update failed', detail: err.message });
  }

  // ── Step 8: Fire-and-forget queue refill check ──
  try {
    const host = req.headers.host || 'operatorstack.tech';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    fetch(`${protocol}://${host}/api/refill-queue`).catch(() => {});
  } catch (_) {
    // Non-critical — don't block the response
  }

  // ── Step 9: IndexNow — auto-submit new article URL to Bing/Yandex/Naver ──
  // Google deprecated /ping in 2023; IndexNow is the modern instant-index protocol.
  try {
    const articleUrl = `https://travel.stackedoperator.com${filePath.replace('src/pages', '').replace('.astro', '')}`;
    fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'travel.stackedoperator.com',
        key: '671555e770190687abbc407e41a239e0',
        keyLocation: 'https://travel.stackedoperator.com/671555e770190687abbc407e41a239e0.txt',
        urlList: [articleUrl],
      }),
    }).catch(() => {});
  } catch (_) {}

  // ── Step 10: Return success ──
  return res.status(200).json({
    published: true,
    title: article.title,
    slug: article.slug,
    path: filePath,
    date: today,
  });
}

// ── Helper: GitHub API headers ──
function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'OperatorStack-Publisher',
  };
}

// ── Helper: Determine file path from category ──
function getFilePath(category, slug) {
  const cat = (category || '').toLowerCase();
  if (cat.includes('review')) return `src/pages/reviews/${slug}.astro`;
  if (cat.includes('comparison')) return `src/pages/comparisons/${slug}.astro`;
  if (cat.includes('guide')) return `src/pages/guides/${slug}.astro`;
  return `src/pages/blog/${slug}.astro`;
}

// ── Helper: Resolve affiliate links from article data ──
function resolveAffiliateLinks(articleLinks, AFFILIATE_PROGRAMS) {
  if (!articleLinks) return 'none';
  // Replace any /recommends/slug patterns with real tracking URLs
  let resolved = articleLinks;
  for (const [slug, program] of Object.entries(AFFILIATE_PROGRAMS)) {
    resolved = resolved.replace(
      new RegExp(`/recommends/${slug}`, 'g'),
      program.primaryLink
    );
  }
  return resolved;
}

// ── Helper: Call Claude API ──
async function callClaude(apiKey, article, today, AFFILIATE_PROGRAMS) {
  const affiliateInfo = resolveAffiliateLinks(article.affiliateLinks, AFFILIATE_PROGRAMS);

  const systemPrompt = `You are a member of the OperatorStack editorial team. Your team has collectively managed thousands of business locations across restaurants, gyms, salons, retail, and service businesses, and evaluated thousands of software tools over your careers. Write from a team perspective using 'we' and 'our team' rather than 'I'. Voice is direct, experienced, and credible. Never use filler phrases. Always include real operator context — what breaks at scale, what the tool actually costs at 10+ locations, and who it's for.`;

  const userPrompt = `Write a complete SEO-optimized .astro article file for OperatorStack.tech.

Title: ${article.title}
Target keyword: ${article.keyword}
Category: ${article.category}
Affiliate links (max 3 CTAs): ${affiliateInfo}

Output a COMPLETE .astro file using this exact structure — no markdown fences, no explanation, raw file content only. Use the rich components (CtaCard, ComparisonTable, ProsCons, StarRating) instead of plain divs whenever possible — they emit better schema and drive higher CTR:

---
import Article from '../../layouts/Article.astro';
import CtaCard from '../../components/CtaCard.astro';
import ComparisonTable from '../../components/ComparisonTable.astro';
import ProsCons from '../../components/ProsCons.astro';
import StarRating from '../../components/StarRating.astro';
---
<Article
  title='${article.title}'
  description='[Write a 150-160 char meta description with the target keyword]'
  publishDate='${today}'
  category='${article.category}'
  readTime='[X] min read'
>

Article body requirements:

1. verdict-box div at top with bottom line up front (2-3 sentences, the honest verdict)

2. RIGHT AFTER the verdict-box, insert an "Our Pick" component using CtaCard:
   <CtaCard slug='[primary affiliate slug]' title='[Product name]' rating={[0-5 with .1 precision]} bestFor='[audience]' price='[price/mo or one-liner]' ctaLabel='Try [Product] →' />
   Only include this if the article is about ONE primary product (single-tool review). Skip for pure "best-of" listicles.

3. quick-stats div with 4 stats: rating, price, key metric, affiliate %

4. H2 headings with emoji and id attributes throughout

5. Sections in order: What Is [Tool], Our Experience (reference managing thousands of tour departures), Key Features (H3 for each), Pricing (HTML table), Pros & Cons (USE <ProsCons pros={[...]} cons={[...]} /> component — NOT plain divs), Who It's For, Final Verdict

6. IF the article is a "vs" comparison or "best-of" listicle: include a <ComparisonTable /> component near the top showing the products side-by-side on 5-8 features. Example:
   <ComparisonTable columns={['Product A', 'Product B']} rows={[
     { feature: 'Starting price', values: ['$29/mo', '$49/mo'] },
     { feature: 'Multi-location support', values: [true, false] },
   ]} />

7. At least 2 callout divs using classes: callout-blue (tips), callout-orange (warnings), callout-green (further reading)

8. Affiliate CTAs using the EXACT affiliate tracking URL provided above — never use placeholder URLs. Format:
   <a href='[EXACT TRACKING URL FROM ABOVE]' class='affiliate-cta'>
     [Specific CTA text] →
   </a>
   Do NOT add any disclaimer text after CTAs. Maximum 3 CTAs: after intro, mid-article, end

9. FAQPage JSON-LD script block at end with 3-5 tour operator Q&As

10. callout-green Further Reading div with 3 internal links to real existing pages on traveloperator.io

11. 1,800-2,400 words total

12. At least 3 internal links in body content

</Article>`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID,
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}
