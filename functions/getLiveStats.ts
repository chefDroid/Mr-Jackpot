// functions/getLiveStats.ts
import { fetchWithBdlRotation } from './api/bdlPool.ts';

const ACTIVE_SPORTS = [
  { key: 'basketball_nba', label: 'NBA', season: true },
  { key: 'basketball_wnba', label: 'WNBA', season: true },
  { key: 'baseball_mlb', label: 'MLB', season: true },
  { key: 'soccer_usa_mls', label: 'MLS', season: true },
  { key: 'mma_mixed_martial_arts', label: 'MMA', season: true },
  { key: 'icehockey_nhl', label: 'NHL Playoffs', season: true },
];

// Cleaned up for secure internal routing on Cloudflare Workers
export async function getLiveStatsInternal(request: Request, env: any, overrideAction?: string) {
  const url = new URL(request.url);
  let action = overrideAction || url.searchParams.get("action");

  if (!action && request.method === "POST" && !overrideAction) {
    const payload = await request.json().catch(() => ({}));
    action = payload.action;
  }

  // Fallback if no specific action matches
  action = action || 'nba_players';
  
  // Aligned to look up the precise variable tied to your configuration
  const rapidKey = env.RAPID_API_KEY;

  // --- TRACK 1: NBA LIVE SCOREBOARD ENGINE ---
  if (action === 'nba_scoreboard') {
    try {
      const res = await fetch('https://tank01-fantasy-stats-live-feeds-the-odds-api.p.rapidapi.com/getNBAScoresOnly?gameDate=20240515', {
        headers: {
          'X-RapidAPI-Key': rapidKey || '',
          'X-RapidAPI-Host': 'tank01-fantasy-stats-live-feeds-the-odds-api.p.rapidapi.com'
        }
      });
      if (!res.ok) throw new Error(`Scoreboard API down with status ${res.status}`);
      const data = await res.json();
      return { games: data.body || [], source: 'rapid_live_tank01' };
    } catch (e: any) {
      console.error("Scoreboard baseline fetch failed, running fallback structure:", e.message);
      return { games: [], error: true, fallback: true };
    }
  }

  // --- TRACK 2: NBA PLAYER TREND ANALYSIS ---
  if (action === 'nba_players') {
    try {
      const res = await fetch('https://tank01-fantasy-stats-live-feeds-the-odds-api.p.rapidapi.com/getNBABettingTrends?type=player', {
        headers: {
          'X-RapidAPI-Key': rapidKey || '',
          'X-RapidAPI-Host': 'tank01-fantasy-stats-live-feeds-the-odds-api.p.rapidapi.com'
        }
      });
      if (!res.ok) throw new Error(`Trends API returned status ${res.status}`);
      const data = await res.json();
      return { trends: data.body || [], source: 'rapid_trends_tank01' };
    } catch (e: any) {
      // Fallback directly to alternative bdl player profiles if Rapid limits exhaust
      try {
        const targetUrl = 'https://api.balldontlie.io/v1/players?per_page=20';
        const bdlFallbackData = await fetchWithBdlRotation(targetUrl, env);
        return { trends: bdlFallbackData.data || [], source: 'balldontlie_rotated_fallback' };
      } catch (err: any) {
        return { trends: [], error: e.message };
      }
    }
  }

  // --- TRACK 3: MLB LIVE RUNLINE INDEX ---
  if (action === 'mlb_scoreboard') {
    try {
      const todayFmt = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const res = await fetch(`https://tank01-fantasy-stats-live-feeds-the-odds-api.p.rapidapi.com/getMLBScoresOnly?gameDate=${todayFmt}`, {
        headers: {
          'X-RapidAPI-Key': rapidKey || '',
          'X-RapidAPI-Host': 'tank01-fantasy-stats-live-feeds-the-odds-api.p.rapidapi.com'
        }
      });
      if (!res.ok) throw new Error(`MLB API down: ${res.status}`);
      const data = await res.json();
      return { games: data.body || [], source: 'rapid_mlb_tank01' };
    } catch (e: any) {
      return { games: [], error: e.message };
    }
  }

  // --- TRACK 4: LIVE ROTATED STAT PROJECTIONS (BallDontLie Custom Sync) ---
  if (action === 'balldontlie_live') {
    const bdlRes = await fetchWithBdlRotation('https://api.balldontlie.io/v1/stats?per_page=25', env);
    const dataArray = bdlRes?.data || [];

    const projections = dataArray.map((s: any) => {
      const stats = [];
      if (s.pts !== undefined) stats.push({ type: 'Points', value: s.pts, line: Math.round(s.pts * 0.9 + 0.5), trend: s.pts > 15 ? 'up' : 'neutral' });
      if (s.reb !== undefined) stats.push({ type: 'Rebounds', value: s.reb, line: Math.round(s.reb * 0.9 + 0.5), trend: s.reb > 5 ? 'up' : 'neutral' });
      if (s.ast !== undefined) stats.push({ type: 'Assists', value: s.ast, line: Math.round(s.ast * 0.9 + 0.5), trend: s.ast > 4 ? 'up' : 'neutral' });
      return {
        player: `${s.player?.first_name} ${s.player?.last_name}`,
        team: s.team?.abbreviation,
        game: s.game?.id ? `Game ${s.game.id}` : 'TBD',
        stats,
        sport: 'NBA',
      };
    }).filter((p: any) => p.stats.length > 0).slice(0, 20);

    return { projections, source: 'balldontlie_live_rotated' };
  }

  // --- TRACK 5: CALENDAR ACTIVATION ---
  if (action === 'active_sports') {
    return { sports: ACTIVE_SPORTS };
  }

  throw new Error(`Unknown live stats action target: ${action}`);
}

// ============================================================
// 🌐 CLOUDFLARE PAGES ROUTE ENTRY POINT
// ============================================================
export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const responseData = await getLiveStatsInternal(request, env);
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error: any) {
    console.error("Unhandled termination error inside live stats function:", error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Live Engine Error' }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}