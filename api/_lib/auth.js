import { timingSafeEqual } from 'crypto';

// Shared secret guard for admin/internal API endpoints on the site
// (generate-article, publish-next, refill-queue). Fails CLOSED — if
// PUBLISH_SECRET is not set, every request is rejected.
//
// Callers must send: `Authorization: Bearer <PUBLISH_SECRET>`.
//
// Returns true if the caller may proceed; otherwise writes 401/503 and
// returns false.
export function requirePublishSecret(req, res) {
  const expected = process.env.PUBLISH_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'PUBLISH_SECRET not configured' });
    return false;
  }

  const raw = req.headers['authorization'] || req.headers['Authorization'];
  if (!raw) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return false;
  }

  const provided = String(raw).replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const equal = a.length === b.length && timingSafeEqual(a, b);
  if (!equal) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  return true;
}
