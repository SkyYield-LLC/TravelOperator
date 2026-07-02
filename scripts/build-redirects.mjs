/**
 * Generates vercel.json redirects from src/data/affiliates.json.
 * Runs automatically before every `npm run build` via the prebuild script,
 * so deploys always have the latest cloak map. Each affiliate becomes:
 *
 *   /recommends/<slug> -> <real url + per-site sub-id>  (302)
 *
 * Per-site attribution: each network gets its own sub-id query param
 * appended so postbacks can be routed back to the origin site.
 *
 *   impact       → ?SubId1=<site>
 *   partnerstack → ?xref=<site>
 *   rewardful    → ?ref=<site>
 *   firstpromoter/tapfiliate → ?xref=<site>
 *   cj/shareasale/awin/refersion → their respective sub-id params
 *   direct/other → no sub-id (partner has no tracking layer)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const affiliates = JSON.parse(
  await readFile(resolve(root, 'src/data/affiliates.json'), 'utf8')
);

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const siteSlug = pkg.name;

const SUB_ID_PARAM_BY_NETWORK = {
  impact: 'SubId1',
  partnerstack: 'xref',
  rewardful: 'ref',
  firstpromoter: 'xref',
  tapfiliate: 'xref',
  cj: 'sid',
  shareasale: 'afftrack',
  awin: 'clickref',
  refersion: 'afftrack',
};

function withSubId(url, network) {
  const param = SUB_ID_PARAM_BY_NETWORK[network];
  if (!param) return url;
  try {
    const u = new URL(url);
    // Don't overwrite if already set (e.g. partner supplied a specific tracking link)
    if (u.searchParams.has(param)) return url;
    u.searchParams.set(param, siteSlug);
    return u.toString();
  } catch {
    // Non-parseable URL — leave alone
    return url;
  }
}

const vercelPath = resolve(root, 'vercel.json');
const vercel = JSON.parse(await readFile(vercelPath, 'utf8'));

vercel.redirects = affiliates.map((a) => ({
  source: `/recommends/${a.slug}`,
  destination: withSubId(a.url, a.network),
  permanent: false,
}));

await writeFile(vercelPath, JSON.stringify(vercel, null, 2) + '\n', 'utf8');

console.log(`build-redirects: wrote ${vercel.redirects.length} affiliate redirects for site=${siteSlug}`);
