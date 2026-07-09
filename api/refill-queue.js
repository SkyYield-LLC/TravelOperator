import { requirePublishSecret } from './_lib/auth.js';

const GITHUB_REPO = 'smcatl/OperatorStack';
const GITHUB_BRANCH = 'main';
const MIN_QUEUED = 8;
const NEW_TOPICS_COUNT = 10;

const AFFILIATE_PROGRAMS = {
  gohighlevel: {
    name: 'GoHighLevel',
    commission: '40% lifetime recurring',
    primaryLink: 'https://www.gohighlevel.com/?fp_ref=stosh61',
  },
  aweber: {
    name: 'AWeber',
    commission: '30% lifetime recurring',
    note: 'Promotes both Free and Plus plans',
    primaryLink: 'https://www.aweber.com/easy-email.htm?id=560455',
  },
  cloudways: {
    name: 'Cloudways',
    commission: '$30 + 7% lifetime recurring',
    primaryLink: 'https://www.cloudways.com/en/?id=2108276',
  },
  moosend: {
    name: 'Moosend',
    commission: '30% lifetime recurring',
    primaryLink: 'https://trymoo.moosend.com/68v8v144fh7a',
  },
  profitbooks: {
    name: 'ProfitBooks',
    commission: '30% recurring for 3 years',
    primaryLink: 'https://www.profitbookshq.com/users/sign_up?partner=DZvqxdd4t0vk',
  },
  esignly: {
    name: 'Esignly',
    commission: '10% recurring',
    primaryLink: 'https://www.esignly.com/?via=stosh',
  },
  docparser: {
    name: 'Docparser',
    commission: 'recurring — 30 day cookie',
    primaryLink: 'https://docparser.com/?ref=efhmj',
  },
};

export default async function handler(req, res) {
  if (!requirePublishSecret(req, res)) return;
  const githubToken = process.env.OSGIT_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!githubToken || !anthropicKey) {
    return res.status(500).json({ error: 'Missing OSGIT_TOKEN or ANTHROPIC_API_KEY' });
  }

  // ── Step 1: Fetch current queue.json ──
  let queueData, queueSha;
  try {
    const queueRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/queue.json?ref=${GITHUB_BRANCH}`,
      { headers: ghHeaders(githubToken) }
    );
    if (!queueRes.ok) {
      return res.status(500).json({ error: 'Failed to read queue.json' });
    }
    const queueFile = await queueRes.json();
    queueSha = queueFile.sha;
    queueData = JSON.parse(Buffer.from(queueFile.content, 'base64').toString('utf-8'));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to parse queue.json', detail: err.message });
  }

  const queuedCount = queueData.articles.filter((a) => a.status === 'queued').length;

  // ── Step 2: Check if queue is healthy ──
  if (queuedCount >= MIN_QUEUED) {
    return res.status(200).json({
      refilled: false,
      message: `Queue healthy: ${queuedCount} articles queued`,
      totalQueued: queuedCount,
    });
  }

  // ── Step 3: Fetch published file list to avoid duplicates ──
  let publishedSlugs = [];
  try {
    const dirs = ['src/pages/reviews', 'src/pages/comparisons', 'src/pages/guides'];
    for (const dir of dirs) {
      const dirRes = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${dir}?ref=${GITHUB_BRANCH}`,
        { headers: ghHeaders(githubToken) }
      );
      if (dirRes.ok) {
        const files = await dirRes.json();
        for (const f of files) {
          if (f.name.endsWith('.astro') && f.name !== 'index.astro') {
            publishedSlugs.push(f.name.replace('.astro', ''));
          }
        }
      }
    }
  } catch (_) {
    // Non-critical — proceed with what we have
  }

  // Also include all slugs already in queue (queued or published)
  const allKnownSlugs = [
    ...publishedSlugs,
    ...queueData.articles.map((a) => a.slug),
  ];

  // ── Step 3b: Fetch trending data and Search Console keywords ──
  const trendingTopics = await fetchGoogleTrends();
  const searchConsoleKeywords = await fetchSearchConsoleKeywords();

  // ── Step 4: Call Claude to generate new topics ──
  let newArticles;
  try {
    newArticles = await generateTopics(anthropicKey, allKnownSlugs, trendingTopics, searchConsoleKeywords);
  } catch (err) {
    return res.status(500).json({ error: 'Claude topic generation failed', detail: err.message });
  }

  if (!newArticles || newArticles.length === 0) {
    return res.status(500).json({ error: 'No topics generated' });
  }

  // ── Step 5: Append to queue and commit ──
  queueData.articles.push(...newArticles);

  try {
    // Re-fetch for fresh SHA
    const freshRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/queue.json?ref=${GITHUB_BRANCH}`,
      { headers: ghHeaders(githubToken) }
    );
    if (!freshRes.ok) {
      return res.status(500).json({ error: 'Failed to re-fetch queue.json SHA' });
    }
    const freshFile = await freshRes.json();

    const updateRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/queue.json`,
      {
        method: 'PUT',
        headers: ghHeaders(githubToken),
        body: JSON.stringify({
          message: `auto: refill content queue with ${newArticles.length} new articles`,
          content: Buffer.from(JSON.stringify(queueData, null, 2) + '\n', 'utf-8').toString('base64'),
          sha: freshFile.sha,
          branch: GITHUB_BRANCH,
        }),
      }
    );
    if (!updateRes.ok) {
      const err = await updateRes.text();
      return res.status(500).json({ error: 'Failed to update queue.json', detail: err });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Queue commit failed', detail: err.message });
  }

  const totalQueued = queueData.articles.filter((a) => a.status === 'queued').length;

  return res.status(200).json({
    refilled: true,
    added: newArticles.length,
    totalQueued,
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

// ── Helper: Fetch Search Console top keywords ──
async function fetchSearchConsoleKeywords() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.log('GOOGLE_SERVICE_ACCOUNT_KEY not set, skipping Search Console');
    return [];
  }

  try {
    const serviceAccount = JSON.parse(keyJson);

    // Generate JWT
    const crypto = await import('node:crypto');
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };
    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${b64url(header)}.${b64url(payload)}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign.sign(serviceAccount.private_key, 'base64url');
    const jwt = `${unsigned}.${signature}`;

    // Exchange JWT for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    if (!tokenRes.ok) {
      console.log('Google token exchange failed:', tokenRes.status);
      return [];
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Query Search Console for top keywords by impressions (last 30 days)
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const endDate = today.toISOString().split('T')[0];
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];

    const siteUrl = encodeURIComponent('https://operatorstack.tech/');
    const scRes = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate,
          endDate,
          dimensions: ['query'],
          rowLimit: 25,
          orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
        }),
      }
    );

    if (!scRes.ok) {
      console.log('Search Console API returned:', scRes.status);
      return [];
    }

    const scData = await scRes.json();
    if (!scData.rows || scData.rows.length === 0) {
      console.log('Search Console API returned no data, using fallback');
      return [];
    }

    return scData.rows.map((row) => row.keys[0]);
  } catch (err) {
    console.log('Search Console integration failed:', err.message);
    return [];
  }
}

// ── Helper: Fetch Google Trends trending searches ──
async function fetchGoogleTrends() {
  const trends = [];
  try {
    const url = 'https://trends.google.com/trends/trendingsearches/daily/rss?geo=US';
    const response = await fetch(url);
    const text = await response.text();
    const matches = text.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g);
    if (matches) {
      matches.slice(0, 10).forEach((match) => {
        const title = match.replace(/<title><!\[CDATA\[/, '').replace(/\]\]><\/title>/, '');
        trends.push(title);
      });
    }
  } catch (e) {
    // Non-critical — proceed without trends
  }
  return trends;
}

// ── Helper: Generate topics via Claude ──
async function generateTopics(apiKey, existingSlugs, trendingTopics, searchConsoleKeywords) {
  // Build affiliate program list from constant
  const programList = Object.values(AFFILIATE_PROGRAMS)
    .map((p) => `- ${p.name}: ${p.commission} — ${p.primaryLink}`)
    .join('\n');

  const trendsSection = trendingTopics.length > 0
    ? `\n\nCurrent trending searches in business software: ${trendingTopics.join(', ')}\n\nUse these trends to inform topic selection where relevant — if a trending term maps to an affiliate program or operator need, prioritize it.`
    : '';

  const scSection = searchConsoleKeywords.length > 0
    ? `\n\nKeywords our site is already getting impressions for in Google (prioritize writing more content on these topics): ${searchConsoleKeywords.join(', ')}`
    : '';

  const systemPrompt = `You are the content strategist for OperatorStack.tech, a software review site for multi-location business operators. The site earns revenue through these recurring affiliate programs:
${programList}

Target audience: business owners running 3-50+ locations (restaurants, gyms, salons, retail, service businesses). They search for software reviews, comparisons, and best-of guides before buying.${trendsSection}${scSection}

Generate article topics that:
- Target high buying-intent keywords operators actually search
- Match one of these content types: Review, Comparison, or Guide
- Naturally feature one of the above affiliate programs
- Use the EXACT tracking URLs listed above in the affiliateLinks field — never use placeholder URLs
- Are NOT duplicates of the already-published articles listed below

Already published: ${existingSlugs.join(', ')}`;

  const userPrompt = `Generate exactly ${NEW_TOPICS_COUNT} new article ideas for OperatorStack. Return ONLY a valid JSON array with no explanation, no markdown, no preamble:

[
  {
    "title": "full article title with year",
    "keyword": "primary target keyword",
    "category": "one of: CRM Review, Email Marketing Review, Hosting Review, Accounting Review, Invoicing Review, Payment Processing Review, SEO Review, CRM Guide, Email Marketing Guide, Hosting Guide, Comparison",
    "slug": "url-friendly-slug",
    "affiliateLinks": "Program name — commission% — exact tracking URL from the list above",
    "status": "queued",
    "publishedDate": null
  }
]

Make titles specific and operator-focused. Target keywords with clear commercial intent. Cover a mix of reviews, comparisons, and guides across different affiliate programs.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = (data.content?.[0]?.text || '').trim();

  // Parse JSON — handle potential markdown fences
  let jsonStr = text;
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const articles = JSON.parse(jsonStr);

  if (!Array.isArray(articles)) {
    throw new Error('Claude response is not a JSON array');
  }

  // Ensure all articles have required fields and correct status
  return articles.map((a) => ({
    title: a.title,
    keyword: a.keyword,
    category: a.category,
    slug: a.slug,
    affiliateLinks: a.affiliateLinks,
    status: 'queued',
    publishedDate: null,
  }));
}
