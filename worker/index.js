/**
 * Cloudflare Worker - Binance Proxy + AI endpoint for Listing Scout
 * Routes:
 *   /fapi/*       -> https://fapi.binance.com/fapi/*
 *   /futures/*    -> https://fapi.binance.com/futures/*
 *   /bapi/*       -> https://www.binance.com/bapi/*
 *   /ai/analyze   -> OpenAI-backed listing analysis
 */
const FUTURES_BASE = 'https://fapi.binance.com';
const WEB_BASE = 'https://www.binance.com';
const OPENAI_BASE = 'https://api.openai.com/v1/responses';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS }
  });
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty AI response');
  try { return JSON.parse(raw); } catch (_) {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return JSON.parse(fenced[1].trim());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('AI response was not valid JSON');
}

function normalizeAnalysis(parsed, fallbackVerdict = 'neutral', fallbackProbability = 50) {
  const verdictRaw = String((parsed && parsed.verdict) || fallbackVerdict || 'neutral').toLowerCase();
  const verdict = verdictRaw === 'pump' || verdictRaw === 'dump' || verdictRaw === 'neutral' ? verdictRaw : 'neutral';
  const continuation = Math.max(0, Math.min(100, Math.round(safeNum(parsed && parsed.continuation_probability, fallbackProbability))));
  return {
    verdict,
    continuation_probability: continuation,
    reasoning: String((parsed && parsed.reasoning) || 'No reasoning returned.').trim(),
    bull_case: String((parsed && parsed.bull_case) || '').trim(),
    bear_case: String((parsed && parsed.bear_case) || '').trim(),
    trade_angle: String((parsed && parsed.trade_angle) || '').trim(),
    source: 'openai'
  };
}

async function handleAiAnalyze(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.OPENAI_API_KEY) return jsonResponse({ error: 'Missing OPENAI_API_KEY in Worker env' }, 500);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const coin = (body && body.coin) || {};
  const symbol = String(coin.symbol || '').trim();
  if (!symbol) return jsonResponse({ error: 'Missing coin.symbol' }, 400);

  const prompt = [
    'You are Listing Scout AI, a direct crypto futures analyst focused on freshly listed Binance perpetuals.',
    'Your job is to judge whether the move is more likely to continue upward, continue downward, or stall/turn neutral.',
    'Be concise, practical, and trader-oriented. Do not hype. Do not add disclaimers. Output JSON only.',
    '',
    'Return exactly this JSON shape:',
    '{"verdict":"pump|dump|neutral","continuation_probability":0-100,"reasoning":"2-3 direct sentences","bull_case":"one sentence","bear_case":"one sentence","trade_angle":"one practical scenario-based trade idea"}',
    '',
    'Coin snapshot:',
    JSON.stringify({
      symbol,
      price: safeNum(coin.price),
      change_24h_pct: safeNum(coin.change_24h_pct),
      futures_volume_24h_usd: safeNum(coin.futures_volume_24h_usd),
      funding_rate_pct: safeNum(coin.funding_rate_pct),
      age_days: safeNum(coin.age_days),
      technical_score: safeNum(coin.technical_score),
      momentum_score: safeNum(coin.momentum_score),
      trend_score: safeNum(coin.trend_score),
      volume_score: safeNum(coin.volume_score),
      activity_score: safeNum(coin.activity_score),
      heuristic_verdict: String(coin.heuristic_verdict || 'neutral'),
      heuristic_confidence: safeNum(coin.heuristic_confidence),
      open_interest: safeNum(coin.open_interest),
      volume_trend: String(coin.volume_trend || 'unknown'),
      has_spot_pair: !!coin.has_spot_pair,
      spot_change_24h_pct: safeNum(coin.spot_change_24h_pct),
      spot_volume_24h_usd: safeNum(coin.spot_volume_24h_usd),
      flags: Array.isArray(coin.flags) ? coin.flags.slice(0, 12) : []
    })
  ].join('\n');

  const openaiResp = await fetch(OPENAI_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5-mini',
      input: prompt,
      max_output_tokens: 350
    })
  });

  if (!openaiResp.ok) {
    const detail = await openaiResp.text();
    return jsonResponse({ error: 'OpenAI request failed', detail }, 502);
  }

  const openaiJson = await openaiResp.json();
  const text = String(openaiJson.output_text || '').trim();

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (err) {
    return jsonResponse({ error: err.message, raw: text }, 502);
  }

  return jsonResponse(normalizeAnalysis(parsed, coin.heuristic_verdict, coin.heuristic_confidence));
}

async function handleProxy(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  let base = null;
  if (path.startsWith('/fapi/') || path.startsWith('/futures/')) base = FUTURES_BASE;
  else if (path.startsWith('/bapi/')) base = WEB_BASE;
  else return jsonResponse({ status: 'Listing Scout Proxy OK' });

  try {
    const resp = await fetch(base + path + url.search, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ListingScout/1.0)', 'Accept': 'application/json' }
    });
    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-cache',
        ...CORS
      }
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/ai/analyze') return handleAiAnalyze(request, env);
    return handleProxy(request);
  }
};
