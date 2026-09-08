/**
 * Newsletter subscribe endpoint — provider-agnostic.
 *
 * Set NEWSLETTER_PROVIDER to one of:
 *   - convertkit (requires CONVERTKIT_API_KEY, CONVERTKIT_FORM_ID)
 *   - aweber     (requires AWEBER_LIST_ID, AWEBER_ACCESS_TOKEN)
 *   - resend     (requires RESEND_API_KEY, RESEND_AUDIENCE_ID)
 *
 * Adding a new provider: write a new adapter, add a case in the switch.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const provider = (process.env.NEWSLETTER_PROVIDER || '').toLowerCase();
  if (!provider) {
    return res.status(500).json({ error: 'NEWSLETTER_PROVIDER not configured' });
  }

  try {
    let result;
    switch (provider) {
      case 'convertkit':
        result = await convertkit(email);
        break;
      case 'aweber':
        result = await aweber(email);
        break;
      case 'resend':
        result = await resend(email);
        break;
      default:
        return res.status(500).json({ error: `Unknown NEWSLETTER_PROVIDER: ${provider}` });
    }
    return res.status(200).json({ ok: true, provider, result });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Subscribe failed' });
  }
}

async function convertkit(email) {
  const apiKey = required('CONVERTKIT_API_KEY');
  const formId = required('CONVERTKIT_FORM_ID');
  const r = await fetch(`https://api.convertkit.com/v3/forms/${formId}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, email }),
  });
  if (!r.ok) throw new Error(`ConvertKit ${r.status}`);
  return await r.json();
}

async function aweber(email) {
  const listId = required('AWEBER_LIST_ID');
  const token = required('AWEBER_ACCESS_TOKEN');
  const r = await fetch(`https://api.aweber.com/1.0/accounts/lists/${listId}/subscribers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ 'ws.op': 'create', email }),
  });
  if (!r.ok) throw new Error(`AWeber ${r.status}`);
  return await r.json();
}

async function resend(email) {
  const apiKey = required('RESEND_API_KEY');
  const audienceId = required('RESEND_AUDIENCE_ID');
  const siteName = process.env.PUBLIC_SITE_NAME || 'the team';
  const siteUrl = process.env.PUBLIC_SITE_URL || 'https://stackedoperator.com';
  const siteNiche = process.env.PUBLIC_SITE_NICHE || 'your industry';

  // 1) Add to audience
  const addRes = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ email, unsubscribed: false }),
  });
  if (!addRes.ok && addRes.status !== 409) throw new Error(`Resend add ${addRes.status}`);
  const contact = addRes.ok ? await addRes.json() : {};

  // 2) Fire welcome email (best-effort; log but don't fail subscription if this errors)
  try {
    const subject = `Welcome to ${siteName}`;
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;line-height:1.6;color:#111;">
      <p>Hi,</p>
      <p>Thanks for subscribing to <strong>${siteName}</strong>.</p>
      <p>You'll get one email a week: our team's take on the software ${siteNiche} actually use — no vendor fluff, no free-trial hot takes, no paid placements.</p>
      <p>What to expect:</p>
      <ul>
        <li>New reviews and comparisons as they land</li>
        <li>Occasional deep-dives on tools that are worth switching to</li>
        <li>Alerts when a tool we recommended drops in quality</li>
      </ul>
      <p>Start here → <a href="${siteUrl}">${siteUrl.replace(/^https?:\/\//,'')}</a></p>
      <p>— The ${siteName} Team</p>
      <hr style="border:none;border-top:1px solid #eee;margin:2rem 0 1rem;">
      <p style="font-size:0.8rem;color:#666;">You subscribed at ${siteUrl}. Reply to this email if you want off the list.</p>
    </div>`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: `${siteName} <hello@stackedoperator.com>`,
        to: [email],
        subject,
        html,
      }),
    });
  } catch (err) {
    console.warn('welcome email send failed:', err.message);
  }

  return contact;
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}
