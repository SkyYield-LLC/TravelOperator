import { requirePublishSecret } from './_lib/auth.js';

/**
 * Article generator — env-driven, emits MDX targeting content collections.
 *
 * Persona and niche come from server env vars (EDITORIAL_PERSONA, EDITORIAL_NICHE)
 * so the same template repo can power any vertical without code changes.
 *
 * Output: MDX with strict frontmatter matching src/content/config.ts schema.
 * publish-next.js writes the file to src/content/<category>/<slug>.mdx.
 */
export default async function handler(req, res) {
  if (!requirePublishSecret(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const persona = process.env.EDITORIAL_PERSONA || 'You are an experienced editorial team writing honest software reviews.';
  const niche = process.env.EDITORIAL_NICHE || 'business operators';
  const siteName = process.env.PUBLIC_SITE_NAME || 'this site';
  const siteUrl = process.env.PUBLIC_SITE_URL || '';

  const {
    title,
    keyword,
    category,
    slug,
    affiliateLinks,
    /** Array of affiliate slugs from src/data/affiliates.ts that should be referenced. */
    affiliateSlugs = [],
    /** 'reviews' | 'guides' | 'comparisons' | 'blog' — controls schema fields. */
    collection = 'reviews',
    /** For review collection: the product being reviewed. */
    productName,
  } = req.body || {};

  if (!title || !keyword || !category || !slug) {
    return res.status(400).json({
      error: 'Missing required fields: title, keyword, category, slug',
    });
  }

  const today = new Date().toISOString().split('T')[0];

  const reviewExtraFields = collection === 'reviews'
    ? `productName: "${productName || title}"
rating: [number 1.0–5.0]
pros:
  - [pro 1]
  - [pro 2]
  - [pro 3]
cons:
  - [con 1]
  - [con 2]
verdict: "[one-sentence verdict]"`
    : '';

  const systemPrompt = `${persona} You write for ${siteName}, serving ${niche}. Always include real-world context: what breaks at scale, true cost at multiple deployments, who it's for. Never use filler phrases.`;

  const userPrompt = `Write a complete SEO-optimized MDX article for ${siteName}${siteUrl ? ` (${siteUrl})` : ''}.

Title: ${title}
Target keyword: ${keyword}
Category: ${category}
Collection: ${collection}
Affiliate links to reference (max 3 CTAs): ${affiliateLinks || 'none'}
${affiliateSlugs.length ? `Affiliate slugs (use <AffiliateLink slug="..." cta />): ${affiliateSlugs.join(', ')}` : ''}

Output a COMPLETE .mdx file using this exact structure — no markdown fences, no explanation, raw file content only:

---
title: "${title}"
description: "[150-160 char meta description with the target keyword]"
publishDate: ${today}
category: "${category}"
readTime: "[X] min read"
tags: [tag1, tag2, tag3]
affiliateSlugs: [${affiliateSlugs.map((s) => `"${s}"`).join(', ')}]
${reviewExtraFields}
---

import AffiliateLink from '../../components/AffiliateLink.astro';
import CtaCard from '../../components/CtaCard.astro';
import ProsCons from '../../components/ProsCons.astro';
import Callout from '../../components/Callout.astro';
import ComparisonTable from '../../components/ComparisonTable.astro';
import StarRating from '../../components/StarRating.astro';
import FaqSchema from '../../components/FaqSchema.astro';
import RelatedArticles from '../../components/RelatedArticles.astro';

[Opening — bottom-line-up-front verdict in 2-3 sentences]

## What Is [Tool] {#what-is}

[2-3 paragraphs of context]

## Our Experience {#experience}

[Reference real deployment experience for the niche: ${niche}]

## Key Features {#features}

### [Feature 1]
[paragraph]

### [Feature 2]
[paragraph]

## Pricing {#pricing}

[HTML table or paragraph with exact prices and what gets expensive at scale]

<ProsCons pros={[...]} cons={[...]} />

## Who It's For {#who}

[paragraph]

<CtaCard slug="[slug]" title="[product]" rating={[n]} bestFor="[scenario]" price="[price]">
[Why we recommend it]
</CtaCard>

## Final Verdict {#verdict}

[paragraph]

<FaqSchema faqs={[
  { question: "[question 1]", answer: "[answer 1]" },
  { question: "[question 2]", answer: "[answer 2]" },
  { question: "[question 3]", answer: "[answer 3]" }
]} />

<RelatedArticles currentSlug="${slug}" tags={["tag1", "tag2"]} collection="${collection}" />

Requirements:
1. 1,800–2,400 words total
2. Use <AffiliateLink slug="..." cta /> for CTAs (max 3) — never raw URLs
3. At least 3 internal links to other ${collection} pages
4. Every H2 has an explicit {#anchor-id}
5. At least 2 <Callout> blocks (type="tip", "warning", or "info")
6. FAQ block with 3-5 questions specific to ${niche}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return res.status(response.status).json({
        error: 'Anthropic API error',
        status: response.status,
        detail: errorBody,
      });
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    if (!content) {
      return res.status(500).json({ error: 'Empty response from Anthropic API' });
    }

    return res.status(200).json({ content, slug, category, collection });
  } catch (err) {
    return res.status(500).json({
      error: 'Internal server error',
      detail: err.message,
    });
  }
}
