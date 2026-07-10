# Stackbase

Template repo for env-driven affiliate review sites built on Astro. Clone, set environment variables, deploy.

Originally extracted from [OperatorStack](https://operatorstack.tech). Powers OperatorStack, STRStack, ContractorEdge, RestaurantStack, and any future vertical.

## Why this exists

Each affiliate site we run shares ~95% of its layout, components, SEO scaffolding, content pipeline, and infra. The other 5% is brand identity (name, color, niche, copy) and the article queue. This repo captures the 95% once. To launch a new vertical: clone, set env vars, deploy.

## What you get out of the box

- **Astro 6** + MDX content collections, sitemap, RSS, view transitions, prefetch on hover
- **Env-driven brand identity** — every brand string, color, footer link, and verification code lives in env vars (`src/config/site.ts`)
- **Affiliate registry** (`src/data/affiliates.ts`) — single source of truth, generates `/recommends/<slug>` redirects via `npm run build:redirects`, automatic `rel="sponsored nofollow"` + Plausible click tracking
- **SEO**: Organization, WebSite (with SearchAction), Article, BreadcrumbList, Review/Product, FAQPage JSON-LD baked in
- **Article components**: `<AffiliateLink>`, `<CtaCard>`, `<ProsCons>`, `<ComparisonTable>`, `<StarRating>`, `<Callout>`, `<Disclosure>`, `<RelatedArticles>`, `<FaqSchema>`, `<ReadingProgress>`, auto Table of Contents in sidebar
- **Article generator** (`api/generate-article.js`) — Anthropic-powered, persona/niche from env, emits MDX into content collections
- **Vercel cron pipeline**: publishes Mon–Thu, refills queue Sun

## Spinning up a new vertical

```bash
# 1. Create a new GitHub repo (e.g. SkyYield-LLC/newstack)
gh repo create SkyYield-LLC/newstack --public

# 2. Clone stackbase as the starting point
git clone https://github.com/SkyYield-LLC/stackbase.git newstack
cd newstack
git remote set-url origin https://github.com/SkyYield-LLC/newstack.git
git push -u origin main

# 3. Configure
cp .env.example .env
$EDITOR .env   # set PUBLIC_SITE_NAME, PUBLIC_SITE_URL, PUBLIC_BRAND_ACCENT, etc.

# 4. Install + dev
npm install
npm run dev

# 5. Deploy
vercel link
vercel env pull   # or add the same vars in Vercel dashboard
vercel --prod
```

Total time from clone to live deployment: under an hour. Most of that is filling in `.env` and pointing DNS.

## Required env vars

See `.env.example` for the complete list with comments. The minimum to boot:

| Var | Example |
|---|---|
| `PUBLIC_SITE_NAME` | `STRStack` |
| `PUBLIC_BRAND_WORD_1` | `STR` |
| `PUBLIC_BRAND_WORD_2` | `Stack` |
| `PUBLIC_SITE_URL` | `https://strstack.io` |
| `PUBLIC_SITE_DESCRIPTION` | `Software reviews for short-term rental operators...` |
| `PUBLIC_BRAND_ACCENT` | `#0EA5E9` |
| `PUBLIC_BRAND_ACCENT_LIGHT` | `#7DD3FC` |

Server-only (only used by `api/`):

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Article generator |
| `EDITORIAL_PERSONA` | System prompt persona |
| `EDITORIAL_NICHE` | Audience description |
| `OSGIT_TOKEN` | GitHub commit-back from publish-next |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Search Console (optional) |

## Adding an affiliate

1. Add to `src/data/affiliates.ts`:
   ```ts
   { slug: 'newpartner', name: 'NewPartner', url: 'https://...', status: 'active', commission: '...', network: 'impact' }
   ```
2. `npm run build:redirects` (also runs automatically on `npm run build`)
3. Reference in MDX: `<AffiliateLink slug="newpartner" cta />`

Changing the destination URL? Edit `affiliates.ts`, rebuild redirects, redeploy. No article edits needed.

## Writing articles

New articles go in `src/content/<collection>/<slug>.mdx` where `<collection>` is `reviews`, `comparisons`, `guides`, or `blog`. Frontmatter is validated by `src/content/config.ts`.

Existing `.astro` files under `src/pages/reviews/` etc. continue to work — they coexist with the content collections. Migrate them lazily as you touch each one.

## Project structure

```
src/
  config/site.ts        env-driven config — single source of truth
  content/config.ts     content collection schemas (zod)
  data/affiliates.ts    affiliate registry
  layouts/              Base.astro (env-driven), Article.astro
  components/           AffiliateLink, CtaCard, ProsCons, etc.
  pages/                home, about, etc. + legacy .astro articles
  styles/global.css     design system, brand color via CSS vars
api/                    Vercel functions: generate-article, publish-next, refill-queue
scripts/
  build-redirects.mjs   generates vercel.json redirects from affiliate registry
vercel.json             build + cron + redirects (redirects auto-generated)
.env.example            full env var reference
```
