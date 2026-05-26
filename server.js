require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// ─── Clients ──────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
}

// ─── Middleware ────────────────────────────────────────────────────────────────

app.set('trust proxy', 1); // Required for Replit's HTTPS proxy

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,      // Replit proxies HTTPS → HTTP internally; keep false
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── OAuth Routes ──────────────────────────────────────────────────────────────

app.get('/auth', (req, res) => {
  const oauth2Client = createOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent'   // Always show consent to get a refresh token
  });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/?error=no_code');

  try {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    await new Promise((resolve, reject) =>
      req.session.save(err => err ? reject(err) : resolve())
    );
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── Status ────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({ authenticated: !!req.session.tokens });
});

// ─── Scoring system prompt ────────────────────────────────────────────────────

const SCORING_SYSTEM_PROMPT = `You are a job lead analyst for Wren Willett, a job seeker in New Braunfels, TX.

BACKGROUND: Office Administrator / Operations at KETOS Inc (Nov 2024 to Apr 2026, laid off). Support Operations Executive at Wagestream (fintech SaaS, remote). Fraud Support Supervisor at TaskUs (supervised 20-person team). Certified Pharmacy Technician Manager at CVS. Wedding officiant and small business owner (Wildstar Weddings). Skills include Google Workspace, QuickBooks, Zapier, Google Apps Script, Salesforce, Slack, HRIS exposure across roles (Trinet, ADP, Workday, Gusto), SQL familiarity, ServiceTitan, Sage. Certs: Intuit Bookkeeping Certificate / QBOA ProAdvisor, Texas Notary Public.

TARGET ROLES AND PAY: Local admin or front desk $17-20/hr. Operations coordinator local $40-50k/yr. Operations coordinator remote $50-65k/yr. EA remote tech $75-100k/yr. Customer Success remote $60-80k/yr. Clinical front desk $16-20/hr. Banking or teller $18-22/hr.

LOCATION: New Braunfels TX. Will commute to San Antonio, San Marcos, Seguin, Kyle, Buda. Remote is fine.

SKIP THESE: Commission-only sales, MLM-adjacent, door-to-door, staffing agency generic posts, roles requiring degrees she does not have (engineering, law, medicine), manufacturing floor roles, roles requiring 5+ years of specialized experience she lacks.

Extract all job listings from the email content provided and score each one. Return only valid JSON, no markdown, no explanation. Format:
{"listings":[{"title":"Job Title","company":"Company Name","location":"City ST or Remote","pay":"pay info if mentioned or null","score":"strong or maybe or skip","reason":"1-2 sentences why","applyUrl":"URL if present or null"}]}`;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 [URL: $1]')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeEmailBody(payload) {
  let textBody = '';
  let htmlBody = '';

  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) {
      textBody += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n';
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      htmlBody += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n';
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);

  const raw = textBody.trim() || stripHtml(htmlBody);
  return raw.substring(0, 9000); // Stay comfortably under token limits
}

async function scoreEmail(subject, body) {
  if (!body.trim()) return { listings: [] };

  const userPrompt = `Email Subject: ${subject}\n\nEmail Body:\n${body}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SCORING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content[0]?.text?.trim() || '';

    // Extract JSON robustly — strip any markdown fencing
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { listings: [] };

    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed.listings) ? parsed : { listings: [] };
  } catch (err) {
    console.error('Claude error:', err.message);
    return { listings: [] };
  }
}

function deduplicate(listings) {
  const seen = new Set();
  return listings.filter(l => {
    const key = `${(l.title || '').toLowerCase().trim()}|${(l.company || '').toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── SSE Scan Endpoint ─────────────────────────────────────────────────────────

app.get('/api/scan', async (req, res) => {
  if (!req.session.tokens) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Set up Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx/Replit buffering
  res.flushHeaders();

  // Keep-alive ping every 20s so Replit doesn't close idle connections
  const pingInterval = setInterval(() => {
    res.write(': ping\n\n');
  }, 20000);

  function send(payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function done(payload) {
    clearInterval(pingInterval);
    send({ ...payload, type: 'done' });
    res.end();
  }

  try {
    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials(req.session.tokens);

    // Auto-refresh tokens
    oauth2Client.on('tokens', newTokens => {
      req.session.tokens = { ...req.session.tokens, ...newTokens };
      req.session.save(() => {});
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    send({ type: 'status', message: 'Searching your inbox for job alert emails…' });

    // Build search: emails from any of the four job boards in the last 30 days
    const searchQuery = [
      'from:(indeed.com OR linkedin.com OR glassdoor.com OR ziprecruiter.com)',
      'newer_than:30d'
    ].join(' ');

    // Collect all matching message IDs (paginated)
    let allIds = [];
    let pageToken = undefined;

    do {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: searchQuery,
        maxResults: 100,
        ...(pageToken ? { pageToken } : {})
      });

      if (listRes.data.messages) {
        allIds = allIds.concat(listRes.data.messages);
      }
      pageToken = listRes.data.nextPageToken;
    } while (pageToken);

    if (allIds.length === 0) {
      send({ type: 'status', message: 'No job alert emails found in the last 30 days.' });
      done({ listings: [], stats: { emails: 0, listings: 0, strong: 0, maybe: 0, skip: 0 } });
      return;
    }

    send({
      type: 'status',
      message: `Found ${allIds.length} job alert email${allIds.length !== 1 ? 's' : ''}. Scoring listings…`,
      emailCount: allIds.length
    });

    let allListings = [];
    let processed = 0;
    const BATCH = 5;

    for (let i = 0; i < allIds.length; i += BATCH) {
      const batch = allIds.slice(i, i + BATCH);

      // Fetch full email bodies in parallel
      const fetched = await Promise.allSettled(
        batch.map(msg =>
          gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full'
          })
        )
      );

      // Score each email sequentially (avoids overloading Claude)
      for (const result of fetched) {
        if (result.status === 'rejected') {
          processed++;
          continue;
        }

        const email = result.value.data;
        const headers = email.payload?.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
        const body = decodeEmailBody(email.payload);

        send({
          type: 'progress',
          message: `Scoring: "${subject.substring(0, 70)}${subject.length > 70 ? '…' : ''}"`,
          processed: processed + 1,
          total: allIds.length,
          pct: Math.round(((processed + 1) / allIds.length) * 100)
        });

        const scored = await scoreEmail(subject, body);
        if (scored.listings?.length) {
          allListings = allListings.concat(scored.listings);
        }

        processed++;
      }

      // Send a live tally after each batch
      const current = deduplicate(allListings);
      send({
        type: 'tally',
        count: current.length,
        strong: current.filter(l => l.score === 'strong').length
      });
    }

    const final = deduplicate(allListings);
    const stats = {
      emails: allIds.length,
      listings: final.length,
      strong: final.filter(l => l.score === 'strong').length,
      maybe: final.filter(l => l.score === 'maybe').length,
      skip: final.filter(l => l.score === 'skip').length
    };

    done({ listings: final, stats });

  } catch (err) {
    console.error('Scan error:', err.message);
    clearInterval(pingInterval);
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Job Lead Scanner running on http://localhost:${PORT}`);
});
