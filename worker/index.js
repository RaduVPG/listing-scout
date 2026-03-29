/**
 * Cloudflare Worker - Binance Proxy for Listing Scout
 * Routes:
 *   /fapi/*  -> https://fapi.binance.com/fapi/*
 *   /futures/* -> https://fapi.binance.com/futures/*
 *   /bapi/*  -> https://www.binance.com/bapi/*
 */
const FUTURES_BASE = 'https://fapi.binance.com';
const WEB_BASE = 'https://www.binance.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    let base = null;
    if (path.startsWith('/fapi/') || path.startsWith('/futures/')) base = FUTURES_BASE;
    else if (path.startsWith('/bapi/')) base = WEB_BASE;
    else return new Response(JSON.stringify({ status: 'Listing Scout Proxy OK' }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    try {
      const resp = await fetch(base + path + url.search, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ListingScout/1.0)', 'Accept': 'application/json' }
      });
      const body = await resp.arrayBuffer();
      return new Response(body, {
        status: resp.status,
        headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-cache', ...CORS }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } });
    }
  }
};