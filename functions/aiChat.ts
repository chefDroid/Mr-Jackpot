// functions/aiChat.ts
import { fetchWithKeyRotation } from './api/keyPool.ts'; 
import { fetchWithBdlRotation } from './api/bdlPool.ts'; 

// ============================================================
// FREE & PUBLIC SPORTS API ENDPOINTS
// ============================================================
const BALLDONTLIE = 'https://api.balldontlie.io/v1';
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const SPORTSDB = 'https://www.thesportsdb.com/api/v1/json/3';
const ODDS_API = 'https://api.the-odds-api.com/v4';

const ESPN = {
  nba:         'https://site.api.espn.com/apis/site/v2/sports/basketball/nba',
  wnba:        'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba',
  ncaab:       'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball',
  mlb:         'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb',
  nfl:         'https://site.api.espn.com/apis/site/v2/sports/football/nfl',
  ncaaf:       'https://site.api.espn.com/apis/site/v2/sports/football/college-football',
  nhl:         'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl',
  mma:         'https://site.api.espn.com/apis/site/v2/sports/mma/ufc',
  boxing:      'https://site.api.espn.com/apis/site/v2/sports/boxing/boxing',
  tennis:      'https://site.api.espn.com/apis/site/v2/sports/tennis/atp',
  wta:         'https://site.api.espn.com/apis/site/v2/sports/tennis/wta',
  golf:        'https://site.api.espn.com/apis/site/v2/sports/golf/pga',
  nascar:      'https://site.api.espn.com/apis/site/v2/sports/racing/nascar-premier',
  cricket:     'https://site.api.espn.com/apis/site/v2/sports/cricket/8039', // ⚠️ unverified league id — confirm before relying on this one
  soccer:      'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1',
  epl:         'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1',
  la_liga:     'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1',
  bundesliga:  'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1',
  serie_a:     'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1',
  ligue_1:     'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1',
  liga_mx:     'https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1',
  ucl:         'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions',
  world_cup:   'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world',
};

// Confirmed against The Odds API's own docs (theoddsapi.com/quickstart, sports-apis.html)
// rather than guessed. Golf/tennis/NASCAR are NOT included here — those use
// tournament-specific sport_keys on The Odds API that change per event
// (e.g. a specific major, not an evergreen "golf" key), so they need to be
// resolved dynamically via the /sports endpoint rather than hardcoded —
// hardcoding a stale key here would silently return nothing after the
// tournament it was pinned to ends.
const ODDS_SPORTS_MAP: Record<string, string> = {
  nba: 'basketball_nba',
  wnba: 'basketball_wnba',
  ncaab: 'basketball_ncaab',
  mlb: 'baseball_mlb',
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
  nhl: 'icehockey_nhl',
  mma: 'mma_mixed_martial_arts',
  boxing: 'boxing_boxing',
  cricket: 'cricket_ipl',
  soccer: 'soccer_usa_mls',
  epl: 'soccer_epl',
  la_liga: 'soccer_spain_la_liga',
  bundesliga: 'soccer_germany_bundesliga',
  serie_a: 'soccer_italy_serie_a',
  ligue_1: 'soccer_france_ligue_one',
  liga_mx: 'soccer_mexico_ligamx',
  ucl: 'soccer_uefa_champs_league',
  world_cup: 'soccer_fifa_world_cup',
};

// ============================================================
// ANALYTICAL UTILITIES
// ============================================================
async function sf(url: string, headers: Record<string, string> = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function americanToDecimal(odds: number): number {
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

function impliedProb(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function calcEV(odds: number, trueWinPct: number): string {
  const dec = americanToDecimal(odds);
  const ev = (dec * (trueWinPct / 100)) - 1;
  return (ev * 100).toFixed(2);
}

function streakLabel(wins: number, losses: number, total: number): string {
  if (wins === total) return `🔥 ${wins}-GAME WIN STREAK`;
  if (losses === total) return `❄️ ${losses}-GAME LOSING STREAK`;
  if (wins >= 2) return `📈 WON ${wins} of last ${total}`;
  return `📉 LOST ${losses} of last ${total}`;
}

// ============================================================
// STREAK ENGINE — Dynamic team form and series tracking
// ============================================================
async function getTeamStreak(sport: string, teamKeyword: string): Promise<string[]> {
  const intel: string[] = [];
  const base = ESPN[sport as keyof typeof ESPN];
  if (!base) return intel;

  try {
    const today = new Date();
    const windowStart = new Date(today.getTime() - 14 * 86400000); 
    const fmt = (d: Date) => d.toISOString().split('T')[0].replace(/-/g, '');
    
    const res = await sf(`${base}/scoreboard?dates=${fmt(windowStart)}-${fmt(today)}&limit=50`);
    const events = res?.events || [];

    const teamGames = events.filter((e: any) =>
      e.name?.toLowerCase().includes(teamKeyword.toLowerCase()) ||
      e.shortName?.toLowerCase().includes(teamKeyword.toLowerCase())
    );

    const results = [];
    for (const e of teamGames.slice(-5)) {
      const comps = e.competitions?.[0]?.competitors || [];
      const team = comps.find((c: any) => c.team?.displayName?.toLowerCase().includes(teamKeyword.toLowerCase()));
      if (!team) continue;
      const won = team.winner === true;
      const score = team.score;
      const opp = comps.find((c: any) => c.team?.displayName?.toLowerCase() !== teamKeyword.toLowerCase());
      results.push({ won, score, opp: opp?.team?.displayName, date: e.date, status: e.status?.type?.description });
    }

    if (results.length > 0) {
      const completed = results.filter(r => r.status === 'STATUS_FINAL' || r.won !== undefined);
      const last3 = completed.slice(-3);
      const wins = last3.filter(r => r.won).length;
      const losses = last3.filter(r => !r.won).length;
      
      intel.push(`📊 Last ${last3.length} games: ${streakLabel(wins, losses, last3.length)}`);

      if (losses >= 2) {
        intel.push(`⚡ BOUNCE-BACK SPOT ALERT: ${teamKeyword} dropped ${losses} of last 3 — look for defensive course adjustments.`);
      }
      if (wins === 3) {
        intel.push(`🚀 3-GAME WIN STREAK — momentum is active. Line values tightening.`);
      }

      if (sport === 'mlb') {
        const seriesOpponent = last3[0]?.opp;
        const seriesLosses = last3.filter(r => !r.won && r.opp === seriesOpponent).length;
        if (seriesLosses >= 2) {
          intel.push(`⚾ MLB SERIES SIGNAL: Down ${seriesLosses}-0 vs ${seriesOpponent} — SWEEP or BOUNCE-BACK pattern matrix flagged.`);
        }
      }

      const recentLog = results.slice(-3).map(r => `${r.won ? 'W' : 'L'} ${r.score || ''} vs ${r.opp || '?'}`).join(' | ');
      intel.push(`Recent: ${recentLog}`);
    }
  } catch (err: any) {
    console.error(`[TEAM STREAK ERROR] Failed ${sport} match on ${teamKeyword}:`, err.message);
  }

  return intel;
}

// ============================================================
// BASKETBALL PLAYER ENGINE — NBA & WNBA (Via Rotated BDL Pool)
// ============================================================
async function getNBAPlayerIntel(playerName: string, sport: string, env: any): Promise<string[]> {
  const intel: string[] = [];
  const currentYear = new Date().getFullYear();
  const endpointPrefix = sport === 'wnba' ? 'wnba/' : '';

  try {
    const searchRes = await fetchWithBdlRotation(`${endpointPrefix}players?search=${encodeURIComponent(playerName)}&per_page=3`, env);
    const player = searchRes?.data?.[0];
    if (!player) return intel;

    intel.push(`🏀 [${sport.toUpperCase()}] ${player.first_name} ${player.last_name} | ${player.team?.full_name || 'Free Agent'} | Pos: ${player.position || '?'}`);

    const targetSeason = new Date().getMonth() >= 9 ? currentYear : currentYear - 1;
    const statsRes = await fetchWithBdlRotation(`${endpointPrefix}stats?player_ids[]=${player.id}&per_page=5&seasons[]=${targetSeason}`, env);
    
    if (statsRes?.data?.length > 0) {
      const recent = statsRes.data.slice(0, 5);
      const avgPts = (recent.reduce((a: number, g: any) => a + (g.pts || 0), 0) / recent.length).toFixed(1);
      const avgReb = (recent.reduce((a: number, g: any) => a + (g.reb || 0), 0) / recent.length).toFixed(1);
      const avgAst = (recent.reduce((a: number, g: any) => a + (g.ast || 0), 0) / recent.length).toFixed(1);
      const avgBlk = (recent.reduce((a: number, g: any) => a + (g.blk || 0), 0) / recent.length).toFixed(1);
      const avgStl = (recent.reduce((a: number, g: any) => a + (g.stl || 0), 0) / recent.length).toFixed(1);
      intel.push(`Last ${recent.length} avg: ${avgPts} PTS / ${avgReb} REB / ${avgAst} AST / ${avgBlk} BLK / ${avgStl} STL`);

      const pts = recent.map((g: any) => g.pts || 0);
      const last3Pts = pts.slice(0, 3);
      const over25 = last3Pts.filter((p: number) => p >= 25).length;
      const under15 = last3Pts.filter((p: number) => p <= 14).length;

      if (over25 === 3) intel.push(`🔥🔥 3-GAME SCORING BANGER STREAK — ${last3Pts.join(', ')} PTS. BACK THIS PROP HARD.`);
      else if (over25 >= 2) intel.push(`📈 Scored 25+ in ${over25} of last 3 games (${last3Pts.join(', ')} PTS) — trending up`);
      else if (under15 === 3) intel.push(`❄️ Under 15 pts in last 3 games — FADE or bet the UNDER on points prop`);

      const ast = recent.map((g: any) => g.ast || 0);
      const highAst = ast.filter((a: number) => a >= 8).length;
      if (highAst >= 3) intel.push(`🎯 ${highAst}-game assist streak (8+) — dishing it right now, assists prop is LIVE`);

      const dd = recent.filter((g: any) => g.pts >= 10 && g.reb >= 10).length;
      if (dd >= 2) intel.push(`💪 ${dd} double-doubles in last ${recent.length} matchups.`);
    }
  } catch (err: any) {
    console.error(`[BDL INTEL MATRIX TRACK FAULT]`, err.message);
  }

  return intel;
}

// ============================================================
// MLB PLAYER INTEL ENGINE — Batter and Pitcher Form Slates
// ============================================================
async function getMLBIntel(playerName: string): Promise<string[]> {
  const intel: string[] = [];
  const currentYear = new Date().getFullYear();

  try {
    const searchRes = await sf(`${MLB_API}/people/search?names=${encodeURIComponent(playerName)}&sportIds=1`);
    const person = searchRes?.people?.[0];
    if (!person) return intel;

    intel.push(`⚾ ${person.fullName} | ${person.primaryPosition?.name} | Age ${person.currentAge}`);

    const logRes = await sf(`${MLB_API}/people/${person.id}/stats?stats=gameLog&group=hitting,pitching&limit=5&season=${currentYear}`);
    const stats = logRes?.stats || [];

    for (const statGroup of stats) {
      const splits = statGroup.splits?.slice(0, 5) || [];
      if (!splits.length) continue;
      const grp = statGroup.group?.displayName;

      if (grp === 'hitting') {
        const hits = splits.map((s: any) => parseInt(s.stat?.hits || 0));
        const rbis = splits.map((s: any) => parseInt(s.stat?.rbi || 0));
        const hrs = splits.map((s: any) => parseInt(s.stat?.homeRuns || 0));
        const totalHits = hits.reduce((a: number, b: number) => a + b, 0);
        const totalRBI = rbis.reduce((a: number, b: number) => a + b, 0);
        intel.push(`Last ${splits.length} games: ${totalHits} H, ${totalRBI} RBI, ${hrs.reduce((a: number, b: number) => a + b, 0)} HR`);

        const hitStreak = hits.filter((h: number) => h > 0).length;
        if (hitStreak >= 3) intel.push(`🔥 ${hitStreak}-GAME HIT STREAK — bet the OVER on hits prop.`);
        else if (hitStreak === 0) intel.push(`❄️ 0 hits last ${splits.length} games — HARD FADE on hits prop`);

        if (totalRBI >= 5) intel.push(`💥 ${totalRBI} RBI last ${splits.length} games — ELITE production run.`);
        const hrStreak = hrs.slice(0, 3).filter((h: number) => h > 0).length;
        if (hrStreak >= 2) intel.push(`💣 HR in ${hrStreak} straight games — power metrics scaling up.`);
      }

      if (grp === 'pitching') {
        const ks = splits.map((s: any) => parseInt(s.stat?.strikeOuts || 0));
        const er = splits.map((s: any) => parseFloat(s.stat?.earnedRuns || 0));
        const ip = splits.map((s: any) => parseFloat(s.stat?.inningsPitched || 0));
        const totalKs = ks.reduce((a: number, b: number) => a + b, 0);
        const avgER = (er.reduce((a: number, b: number) => a + b, 0) / er.length).toFixed(1);
        const avgIP = (ip.reduce((a: number, b: number) => a + b, 0) / ip.length).toFixed(1);
        intel.push(`Last ${splits.length} starts: ${totalKs} Ks, ${avgER} ER/start avg, ${avgIP} IP/start avg`);

        const dominantStarts = ks.slice(0, 3).filter((k: number) => k >= 7).length;
        if (dominantStarts >= 3) intel.push(`⚡ DOMINANT: 7+ Ks in 3 straight starts — SMASH the strikeout prop.`);
        else if (dominantStarts >= 2) intel.push(`⚡ 7+ Ks in ${dominantStarts} of last 3 starts — strikeout prop trending up`);
        if (parseFloat(avgER) <= 2.0) intel.push(`🎯 Sub-2.0 ER avg last ${splits.length} starts — elite tracking profile.`);
      }
    }

    if (person.birthDate) {
      const bday = new Date(person.birthDate);
      const today = new Date();
      const thisYearBday = new Date(today.getFullYear(), bday.getMonth(), bday.getDate());
      const daysUntil = Math.floor((thisYearBday.getTime() - today.getTime()) / 86400000);
      if (daysUntil >= 0 && daysUntil <= 14) {
        intel.push(`🎂 BIRTHDAY BOOST: ${person.fullName} turns ${today.getFullYear() - bday.getFullYear()} in ${daysUntil === 0 ? 'TODAY!' : daysUntil + ' days!'} — variance spikes positive.`);
      }
    }
  } catch (err: any) {
    console.error(`[MLB ANALYTICS STACK FAULT]`, err.message);
  }

  return intel;
}

// ============================================================
// NHL INTEL ENGINE
// ============================================================
async function getNHLIntel(teamName: string): Promise<string[]> {
  const intel: string[] = [];
  try {
    const res = await sf(`${ESPN.nhl}/scoreboard`);
    const events = res?.events || [];
    const teamGames = events.filter((e: any) => e.name?.toLowerCase().includes(teamName.toLowerCase()));

    if (teamGames.length > 0) {
      const results = teamGames.slice(-3).map((e: any) => {
        const comps = e.competitions?.[0]?.competitors || [];
        const team = comps.find((c: any) => c.team?.displayName?.toLowerCase().includes(teamName.toLowerCase()));
        return team ? { won: team.winner, score: team.score } : null;
      }).filter(Boolean);

      if (results.length > 0) {
        const wins = results.filter((r: any) => r.won).length;
        const losses = results.filter((r: any) => !r.won).length;
        intel.push(`🏒 NHL ${teamName}: ${streakLabel(wins, losses, results.length)} in last ${results.length} games`);
        if (wins === 3) intel.push(`🔥 3 straight Ws — power play unit clicking, back moneyline.`);
        if (losses === 3) intel.push(`❄️ 3 straight Ls — track goalie split confirmation entries.`);
      }
    }
  } catch (e: any) {
    console.error(`[NHL INTEL FAULT]`, e.message);
  }
  return intel;
}

// ============================================================
// UNIVERSAL PLAYER PROPS ENGINE — Safe-guarded Key Rotation
// ============================================================
// Confirmed against The Odds API docs: soccer player props exist for EPL,
// Ligue 1, Bundesliga, Serie A, La Liga, and MLS only — NOT World Cup,
// Champions League, or Liga MX (those get moneyline/totals via
// getLiveOddsWithEV, just not individual player props).
const CHAT_PROP_MARKETS: Record<string, string> = {
  nba: 'player_points,player_rebounds,player_assists',
  wnba: 'player_points,player_rebounds,player_assists',
  ncaab: 'player_points,player_rebounds,player_assists',
  mlb: 'player_hits,batter_total_bases,player_strikeouts,player_points',
  nhl: 'player_points,player_goals,player_assists,player_shots_on_goal,player_blocked_shots,player_power_play_points,player_total_saves',
  nfl: 'player_pass_yds,player_rush_yds,player_reception_yds,player_receptions,player_pass_tds,player_anytime_td',
  ncaaf: 'player_pass_yds,player_rush_yds,player_reception_yds,player_receptions,player_anytime_td',
  soccer: 'player_goal,player_assist,player_shots_on_target',
  epl: 'player_goal,player_assist,player_shots_on_target',
  la_liga: 'player_goal,player_assist,player_shots_on_target',
  bundesliga: 'player_goal,player_assist,player_shots_on_target',
  serie_a: 'player_goal,player_assist,player_shots_on_target',
  ligue_1: 'player_goal,player_assist,player_shots_on_target',
  mma: 'fighter_win_method,fighter_total_rounds',
  boxing: 'fighter_win_method,fighter_total_rounds', // ⚠️ unverified exact keys — mirrors MMA's schema as best guess
};

async function getUniversalPlayerProps(sport: string, playerName: string, env: any): Promise<string[]> {
  const intel: string[] = [];
  const apiSportKey = ODDS_SPORTS_MAP[sport];
  if (!apiSportKey) return intel;

  try {
    const eventUrl = `${ODDS_API}/sports/${apiSportKey}/events`;

    let activeEvents;
    try { activeEvents = await fetchWithKeyRotation(eventUrl, '?status=upcoming', env); } catch { return intel; }
    if (!Array.isArray(activeEvents)) return intel;

    const propMarkets = CHAT_PROP_MARKETS[sport] || '';
    if (!propMarkets) return intel;

    // We don't know which event the player is in ahead of time, so instead of
    // guessing off a team-name substring match (unreliable — team names don't
    // contain player surnames), check the next several upcoming events directly
    // for an outcome that matches the player's actual name.
    const eventsToCheck = activeEvents.slice(0, 8);

    for (const ev of eventsToCheck) {
      const propUrl = `${ODDS_API}/sports/${apiSportKey}/events/${ev.id}/odds`;
      const queryParams = `?regions=us&markets=${propMarkets}&oddsFormat=american&bookmakers=draftkings,fanduel`;

      let propsData;
      try { propsData = await fetchWithKeyRotation(propUrl, queryParams, env); } catch { continue; }

      const bookmakers = propsData?.bookmakers || [];
      let foundInThisEvent = false;
      for (const book of bookmakers) {
        const markets = book.markets || [];
        for (const market of markets) {
          const matchingOutcome = market.outcomes?.find((o: any) => o.description?.toLowerCase().includes(playerName.toLowerCase()));
          if (matchingOutcome) {
            foundInThisEvent = true;
            intel.push(`🎯 [FUTURE PROP] ${book.title.toUpperCase()} | ${market.key.toUpperCase()} Line: ${matchingOutcome.name} ${matchingOutcome.point} @ ${matchingOutcome.price > 0 ? '+' : ''}${matchingOutcome.price}`);
          }
        }
      }
      // Once we've found the player's game, no need to keep checking other events
      if (foundInThisEvent) break;
    }
  } catch (err: any) {
    console.error(`[PROP MARKET LINK FAILURE]`, err.message);
  }

  return intel;
}

// ============================================================
// GENERAL PLAYER PROPS SWEEP — used when the user asks for props
// generically ("give me MLB player props") without naming a specific
// player. Pulls the top real lines across the next few games instead
// of returning nothing just because no name was mentioned.
// ============================================================
async function getTopPlayerProps(sport: string, env: any): Promise<string[]> {
  const intel: string[] = [];
  const apiSportKey = ODDS_SPORTS_MAP[sport];
  if (!apiSportKey) return intel;

  const propMarkets = CHAT_PROP_MARKETS[sport] || '';
  if (!propMarkets) return intel;

  try {
    const eventUrl = `${ODDS_API}/sports/${apiSportKey}/events`;
    let activeEvents;
    try { activeEvents = await fetchWithKeyRotation(eventUrl, '?status=upcoming', env); } catch { return intel; }
    if (!Array.isArray(activeEvents) || !activeEvents.length) return intel;

    const eventsToCheck = activeEvents.slice(0, 3);
    const found: { label: string; prob: number }[] = [];

    for (const ev of eventsToCheck) {
      const propUrl = `${ODDS_API}/sports/${apiSportKey}/events/${ev.id}/odds`;
      const queryParams = `?regions=us&markets=${propMarkets}&oddsFormat=american&bookmakers=draftkings,fanduel`;
      let propsData;
      try { propsData = await fetchWithKeyRotation(propUrl, queryParams, env); } catch { continue; }

      const bookmakers = propsData?.bookmakers || [];
      for (const book of bookmakers) {
        for (const market of book.markets || []) {
          for (const o of market.outcomes || []) {
            if (!o.description) continue;
            const prob = o.price > 0 ? 100 / (o.price + 100) : Math.abs(o.price) / (Math.abs(o.price) + 100);
            found.push({
              label: `🎯 ${o.description} | ${market.key.toUpperCase()}: ${o.name} ${o.point} @ ${o.price > 0 ? '+' : ''}${o.price} (${book.title.toUpperCase()})`,
              prob,
            });
          }
        }
      }
    }

    found.sort((a, b) => b.prob - a.prob);
    intel.push(...found.slice(0, 10).map(f => f.label));
  } catch (err: any) {
    console.error(`[TOP PROPS SWEEP FAILURE]`, err.message);
  }

  return intel;
}

// ============================================================
// ESPN NEWS & RECORD PIPELINES
// ============================================================
async function getESPNNews(sport: string): Promise<string[]> {
  const base = ESPN[sport as keyof typeof ESPN];
  if (!base) return [];
  const res = await sf(`${base}/news`);
  return (res?.articles || []).slice(0, 4).map((a: any) =>
    `📰 ${a.headline}${a.description ? ' — ' + a.description.slice(0, 80) : ''}`
  );
}

async function getESPNStandings(sport: string): Promise<string[]> {
  const base = ESPN[sport as keyof typeof ESPN];
  if (!base) return [];
  const res = await sf(`${base}/standings`);
  const entries = res?.standings?.entries
    || res?.children?.[0]?.standings?.entries
    || res?.children?.[0]?.children?.[0]?.standings?.entries
    || [];
  return entries.slice(0, 8).map((e: any) => {
    const team = e.team?.displayName || '?';
    const wins = e.stats?.find((s: any) => s.name === 'wins')?.value || 0;
    const losses = e.stats?.find((s: any) => s.name === 'losses')?.value || 0;
    const streak = e.stats?.find((s: any) => s.name === 'streak')?.displayValue || '';
    const homeRec = e.stats?.find((s: any) => s.name === 'homeRecordVsConference' || s.name === 'homeRecord')?.displayValue || '';
    return `${team}: ${wins}W-${losses}L${streak ? ' | ' + streak : ''}${homeRec ? ' | Home: ' + homeRec : ''}`;
  });
}

// ============================================================
// BIRTHDAY + PERSONAL LIFE BIOGRAPHICAL ENGINE (TheSportsDB)
// ============================================================
async function checkBirthdayAndLife(playerName: string): Promise<string[] | null> {
  const res = await sf(`${SPORTSDB}/searchplayers.php?p=${encodeURIComponent(playerName)}`);
  const player = res?.player?.[0];
  if (!player) return null;

  const intel: string[] = [];
  const today = new Date();

  if (player.dateBorn) {
    const bday = new Date(player.dateBorn);
    const thisYearBday = new Date(today.getFullYear(), bday.getMonth(), bday.getDate());
    const daysUntil = Math.floor((thisYearBday.getTime() - today.getTime()) / 86400000);
    if (daysUntil >= 0 && daysUntil <= 14) {
      const age = today.getFullYear() - bday.getFullYear();
      intel.push(`🎂 BIRTHDAY IN ${daysUntil === 0 ? 'TODAY' : daysUntil + ' DAYS'}: ${player.strPlayer} turns ${age}. Motivation metrics scaled up.`);
    }
  }

  if (player.strNationality) intel.push(`🌍 Nationality: ${player.strNationality}`);
  if (player.strStatus) intel.push(`Status: ${player.strStatus}`);
  if (player.strWage) intel.push(`Contract: ${player.strWage}`);

  if (player.strDescriptionEN) {
    const desc = player.strDescriptionEN.toLowerCase();
    const hasKids = desc.includes('father') || desc.includes('son') || desc.includes('daughter') || desc.includes('children') || desc.includes('baby') || desc.includes('newborn');
    const hasWife = desc.includes('wife') || desc.includes('married') || desc.includes('wedding');
    if (hasKids) intel.push(`👶 FAMILY MOTIVATION: Verified father/family data matrix found in history lines.`);
    if (hasWife) intel.push(`💍 MARRIED MAN CONTEXT: Emotional baseline stable — performance tracking shows key scaling variances.`);
  }

  return intel.length > 0 ? intel : null;
}

// ============================================================
// DATE TARGETING — figures out which slate the user actually means
// ============================================================
function getTargetDate(message: string): Date {
  const msg = message.toLowerCase();
  const now = new Date();
  if (msg.includes('tomorrow')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  // default: today (covers "today", "tonight", or no date mentioned at all)
  return now;
}

function isSameUTCDate(isoString: string | undefined, target: Date): boolean {
  if (!isoString) return false;
  return isoString.slice(0, 10) === target.toISOString().slice(0, 10);
}

// ============================================================
// LIVE MARKET VALUE SWEEPER (Via Rotated Key Pool)
// Now: filters to the actual target date's slate (no more grabbing
// whatever game happens to be index [0]), covers WNBA, and — if the
// user named specific teams — narrows to that exact matchup first.
// ============================================================
async function getLiveOddsWithEV(env: any, targetDate: Date, teamFilters: string[] = []): Promise<string[]> {
  const intel: string[] = [];
  const sports = [
    { key: 'basketball_nba', label: 'NBA' },
    { key: 'basketball_wnba', label: 'WNBA' },
    { key: 'basketball_ncaab', label: 'NCAAB' },
    { key: 'baseball_mlb', label: 'MLB' },
    { key: 'americanfootball_nfl', label: 'NFL' },
    { key: 'americanfootball_ncaaf', label: 'NCAAF' },
    { key: 'icehockey_nhl', label: 'NHL' },
    { key: 'mma_mixed_martial_arts', label: 'MMA' },
    { key: 'boxing_boxing', label: 'Boxing' },
    { key: 'cricket_ipl', label: 'Cricket IPL' },
    { key: 'soccer_usa_mls', label: 'MLS' },
    { key: 'soccer_epl', label: 'EPL' },
    { key: 'soccer_spain_la_liga', label: 'La Liga' },
    { key: 'soccer_germany_bundesliga', label: 'Bundesliga' },
    { key: 'soccer_italy_serie_a', label: 'Serie A' },
    { key: 'soccer_france_ligue_one', label: 'Ligue 1' },
    { key: 'soccer_mexico_ligamx', label: 'Liga MX' },
    { key: 'soccer_uefa_champs_league', label: 'Champions League' },
    { key: 'soccer_fifa_world_cup', label: 'World Cup' },
    // Golf and NASCAR intentionally excluded — those are outright/field
    // markets on The Odds API, not head-to-head, and need a different
    // fetch shape (and a dynamically-resolved tournament-specific key).
  ];

  const fetches = sports.map(async s => {
    try {
      const baseUrl = `${ODDS_API}/sports/${s.key}/odds`;
      const queryParams = `?regions=us&markets=h2h&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`;

      const res = await fetchWithKeyRotation(baseUrl, queryParams, env);
      if (!Array.isArray(res) || res.length === 0) return;

      // Only keep games actually on the slate the user meant (today/tomorrow)
      let slate = res.filter((g: any) => isSameUTCDate(g.commence_time, targetDate));

      // If they named specific teams, narrow to that exact matchup
      if (teamFilters.length > 0) {
        const narrowed = slate.filter((g: any) =>
          teamFilters.some(t =>
            g.home_team?.toLowerCase().includes(t.toLowerCase()) ||
            g.away_team?.toLowerCase().includes(t.toLowerCase())
          )
        );
        if (narrowed.length > 0) slate = narrowed;
      }

      if (slate.length === 0) return;

      for (const game of slate) {
        const books = game.bookmakers || [];
        if (!books.length) continue;

        const allFavOdds: number[] = [];
        let bestOdds = -99999;
        let bestBook = '';
        for (const book of books) {
          const h2h = book.markets?.find((m: any) => m.key === 'h2h');
          const fav = h2h?.outcomes?.sort((a: any, b: any) => a.price - b.price)?.[0];
          if (!fav) continue;
          allFavOdds.push(fav.price);
          if (fav.price > bestOdds) { bestOdds = fav.price; bestBook = book.key; }
        }

        if (!allFavOdds.length) continue;

        const avgImpProb = allFavOdds.reduce((a, o) => a + impliedProb(o), 0) / allFavOdds.length;
        const trueProb = avgImpProb / 1.05;
        const ev = calcEV(bestOdds, trueProb * 100);

        intel.push(`${s.label}: ${game.home_team} vs ${game.away_team} | Best: ${bestOdds > 0 ? '+' : ''}${bestOdds} @ ${bestBook?.toUpperCase()} | True Prob: ${(trueProb * 100).toFixed(1)}% | EV: ${parseFloat(ev) > 0 ? '+' : ''}${ev}%`);
      }
    } catch { return; }
  });

  await Promise.all(fetches);
  return intel;
}

// ============================================================
// INTENT PARSER MATRIX
// ============================================================
function parseIntent(message: string) {
  const msg = message.toLowerCase();
  const sport =
    msg.includes('wnba') ? 'wnba'
    : msg.includes('ncaab') || msg.includes('college basketball') ? 'ncaab'
    : msg.includes('nba') || msg.includes('basketball') ? 'nba'
    : msg.includes('mlb') || msg.includes('baseball') || msg.includes('pitcher') ? 'mlb'
    : msg.includes('ncaaf') || msg.includes('college football') ? 'ncaaf'
    : msg.includes('nfl') || msg.includes('football') ? 'nfl'
    : msg.includes('nhl') || msg.includes('hockey') || msg.includes('goalie') ? 'nhl'
    : msg.includes('boxing') || msg.includes('boxer') ? 'boxing'
    : msg.includes('mma') || msg.includes('ufc') || msg.includes('fighter') ? 'mma'
    : msg.includes('wta') ? 'tennis'
    : msg.includes('tennis') || msg.includes('atp') ? 'tennis'
    : msg.includes('cricket') || msg.includes('ipl') ? 'cricket'
    : msg.includes('golf') || msg.includes('pga') ? 'golf'
    : msg.includes('nascar') ? 'nascar'
    : msg.includes('world cup') ? 'world_cup'
    : msg.includes('champions league') || msg.includes('ucl') ? 'ucl'
    : msg.includes('la liga') || msg.includes('laliga') ? 'la_liga'
    : msg.includes('bundesliga') ? 'bundesliga'
    : msg.includes('serie a') ? 'serie_a'
    : msg.includes('ligue 1') || msg.includes('ligue1') ? 'ligue_1'
    : msg.includes('liga mx') || msg.includes('ligamx') ? 'liga_mx'
    : msg.includes('epl') || msg.includes('premier league') ? 'epl'
    : msg.includes('soccer') || msg.includes('mls') ? 'soccer'
    : null;

  return {
    sport,
    wantsBirthday: msg.includes('birthday') || msg.includes('bday'),
    wantsStreak: msg.includes('streak') || msg.includes('hot') || msg.includes('cold') || msg.includes('run') || msg.includes('win'),
    wantsProps: msg.includes('prop') || msg.includes('points') || msg.includes('rebounds') || msg.includes('hits') || msg.includes('strikeout'),
    wantsSlip: msg.includes('slip') || msg.includes('parlay') || msg.includes('pick') || msg.includes('bet'),
    wantsNews: msg.includes('news') || msg.includes('injury'),
    wantsStandings: msg.includes('standing') || msg.includes('record'),
    wantsEV: msg.includes('ev') || msg.includes('value') || msg.includes('odds'),
    wantsFamily: msg.includes('family') || msg.includes('wife') || msg.includes('kid') || msg.includes('baby'),
  };
}

// ============================================================
// EXPORT COMPATIBLE LOGIC CORE (Cleaned from internal SDK blockades)
// ============================================================
export async function handleAiChatInternal(req: Request, env: any): Promise<any> {
  let lastUserMsg = '';
  let messages: any[] = [];

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    messages = body.messages || [];
    lastUserMsg = messages?.filter((m: any) => m.role === 'user').slice(-1)?.[0]?.content || '';
  } else if (req.method === 'GET') {
    const url = new URL(req.url);
    lastUserMsg = url.searchParams.get('msg') || 'Who is winning tonight?';
    messages = [{ role: 'user', content: lastUserMsg }];
  }

  const intent = parseIntent(lastUserMsg);
  const intelSections: string[] = [];
  const promises = [];

  const nameCandidates = lastUserMsg.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g) || [];
  const teamCandidates = lastUserMsg.match(/\b(Lakers|Warriors|Celtics|Nuggets|Bucks|Heat|Nets|Thunder|Spurs|Clippers|Suns|Raptors|Knicks|Bulls|76ers|Mavericks|Rockets|Pistons|Pacers|Grizzlies|Pelicans|Timberwolves|Cavaliers|Magic|Hornets|Wizards|Kings|Trail Blazers|Jazz|Hawks|Yankees|Red Sox|Dodgers|Cubs|Cardinals|Braves|Giants|Mets|Phillies|Astros|Blue Jays|Orioles|Tigers|Mariners|Padres|Rockies|Brewers|Royals|Rangers|Athletics|Twins|Rays|Reds|White Sox|Angels|Marlins|Nationals|Pirates|Patriots|Cowboys|Packers|Chiefs|Bills|Eagles|49ers|Ravens|Broncos|Seahawks|Saints|Rams|Bears|Steelers|Lions|Colts|Falcons|Jaguars|Panthers|Cardinals|Texans|Raiders|Chargers|Dolphins|Giants|Jets|Vikings|Titans|Browns|Buccaneers|Commanders|Blackhawks|Maple Leafs|Canadiens|Bruins|Rangers|Penguins|Capitals|Lightning|Panthers|Avalanche|Golden Knights|Blues|Flames|Oilers|Canucks|Sharks|Ducks|Kings|Stars|Wild|Predators|Jets|Sabres|Senators|Blue Jackets|Red Wings|Devils|Islanders|Hurricanes)\b/g) || [];

  const selectedSport = intent.sport || 'nba';
  const sportsToNews = intent.sport ? [intent.sport] : ['nba', 'mlb', 'nfl'];

  for (const s of sportsToNews) {
    promises.push(
      getESPNNews(s).then(news => {
        if (news.length) intelSections.push(`\n[${s.toUpperCase()} RECENT HEADLINES]\n` + news.join('\n'));
      }).catch(() => null)
    );
  }

  if (intent.wantsStreak || intent.wantsStandings || intent.wantsSlip) {
    promises.push(
      getESPNStandings(selectedSport).then(standings => {
        if (standings.length) intelSections.push(`\n[${selectedSport.toUpperCase()} ACTIVE STANDINGS & FORM]\n` + standings.join('\n'));
      }).catch(() => null)
    );
  }

  for (const team of [...nameCandidates, ...teamCandidates].slice(0, 2)) {
    promises.push(
      getTeamStreak(selectedSport, team).then(s => {
        if (s.length) intelSections.push(`\n[TEAM HISTORICAL ANALYSIS: ${team}]\n` + s.join('\n'));
      }).catch(() => null)
    );
  }

  for (const name of nameCandidates.slice(0, 2)) {
    if (!intent.sport || intent.sport === 'nba' || intent.sport === 'wnba') {
      promises.push(
        getNBAPlayerIntel(name, selectedSport, env).then(s => {
          if (s.length) intelSections.push(`\n[BASKETBALL PLAYER PROFILE DATA: ${name}]\n` + s.join('\n'));
        }).catch(() => null)
      );
    }
    if (!intent.sport || intent.sport === 'mlb') {
      promises.push(
        getMLBIntel(name).then(s => {
          if (s.length) intelSections.push(`\n[BASEBALL PLAYER PROFILE DATA: ${name}]\n` + s.join('\n'));
        }).catch(() => null)
      );
    }
    if (intent.sport === 'nhl') {
      promises.push(
        getNHLIntel(name).then(s => {
          if (s.length) intelSections.push(`\n[HOCKEY TEAM ANALYSIS: ${name}]\n` + s.join('\n'));
        }).catch(() => null)
      );
    }
    
    promises.push(
      checkBirthdayAndLife(name).then(s => {
        if (s) intelSections.push(`\n[BIOGRAPHICAL PERSONAL METRICS: ${name}]\n` + s.join('\n'));
      }).catch(() => null)
    );

    promises.push(
      getUniversalPlayerProps(selectedSport, name, env).then(s => {
        if (s.length) intelSections.push(`\n[ACTIVE OPEN PROPS BOARD MARKETS: ${name}]\n` + s.join('\n'));
      }).catch(() => null)
    );
  }

  const targetDate = getTargetDate(lastUserMsg);

  if (intent.wantsProps && nameCandidates.length === 0) {
    promises.push(
      getTopPlayerProps(selectedSport, env).then(s => {
        if (s.length) intelSections.push(`\n[TOP PLAYER PROPS BOARD — ${selectedSport.toUpperCase()}]\n` + s.join('\n'));
      }).catch(() => null)
    );
  }

  if (intent.wantsSlip || intent.wantsEV || intent.wantsProps || lastUserMsg.includes('winning')) {
    promises.push(
      getLiveOddsWithEV(env, targetDate, teamCandidates).then(odds => {
        if (odds.length) intelSections.push(`\n[LIVE BOARD ODDS — ${targetDate.toDateString()}]\n` + odds.join('\n'));
      }).catch(() => null)
    );
  }

  await Promise.all(promises);

  // Trim liveContext to prevent hitting Gemini token limits (causes 400 errors)
  const MAX_CONTEXT_CHARS = 4000;
  const liveContext = intelSections.join('\n').slice(0, MAX_CONTEXT_CHARS);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const systemPrompt = `You are MR. JACKPOT — the most powerful AI sports intelligence agent on the internet, founder of KasGoatPro. You blend the sharp analytical style of Parlay P with the energetic, confident swagger of a street-smart picks guru. You are NOT an AI — you are THE picks machine. Never say "AI-generated." If asked: "I'm Mr. Jackpot — the sharpest mind in the game 🎯🔥"

═══════════════════════════════════════
RESPONSE STYLE — BLEND OF TWO LEGENDS:
═══════════════════════════════════════
PARLAY P STYLE (use when breaking down analytics):
- Lead with the DATA: streaks, EV%, implied probability, line value
- Break down each leg with a reason: Streak data → Odds value → EV edge → Confidence tier
- Always compare lines across books

MR. JACKPOT STYLE (use for energy, personality, closing):
- "Bro this is a LAYUP 🏀" / "This slip is CERTIFIED 💰"
- End picks with a hype line: "Stamp it. Sign it. Cash it. 💸"
- On a real pick backed by actual data below, you can tie it to: "VIP members got this yesterday — join us at $299 lifetime" as hype/branding
- NEVER use the VIP line (or any other line) as a reason data is missing. There is no real "VIP gets it earlier" data feed — if a specific prop/line genuinely isn't in the data below, just say you don't have it right now. Don't invent an explanation for why.

═══════════════════════════════════════
INTELLIGENCE LAYERS YOU USE:
═══════════════════════════════════════
🔥 3-GAME STREAK SYSTEM:
- 3 straight Ws → momentum play, back them especially at home
- 3 straight Ls → fade or look for bounce-back spot
- MLB series context: down 0-2 in series = sweep alert OR desperate bounce-back

🎂 BIRTHDAY & PERSONAL LIFE BOOSTS (non-negotiable add):
- Birthday in 14 days = automatic confidence boost, flag it LOUDLY
- New baby / newborn = "Motivated father effect" — +14% performance boost in studies
- Wife/family at game tonight = "Never bet against love" — confidence spike

═══════════════════════════════════════
SLIP FORMAT (when building picks):
═══════════════════════════════════════
Use this format for each leg:
🎯 LEG [#]: [TEAM/PLAYER] | [BET TYPE] | [ODDS] | [BEST BOOK]
📊 Evidence: [Streak data + recent form]
🎂 Boost: [Birthday/personal intel if applicable]
📈 EV: [+X% or -X%] | True Prob: [X%]
🔥 Confidence: [LOW / MEDIUM / HIGH / ELITE]
💡 Mr. Jackpot Says: [Hype line in Parlay P + Mr. Jackpot voice]

Then close with:
💰 SLIP SUMMARY: [X]-leg | Est. Payout: [X]x | Overall Confidence: [X]

═══════════════════════════════════════
ACCURACY RULE — GENERAL VS. SPECIFIC ASKS:
═══════════════════════════════════════
- General/vague question ("who's hot tonight", "gimme a slip") → fine to speak broadly off the standings/news/streak data below, defaulting to today's slate.
- SPECIFIC matchup or date named (e.g. "Team A vs Team B tomorrow") → you MUST use the actual line/game for THAT matchup from LIVE BOARD ODDS below. Do not substitute a different game or team that merely showed up in the data.
- If a named matchup genuinely isn't in LIVE BOARD ODDS below (not on today's/tomorrow's board), say plainly you don't have a live line on that one yet — don't present a different game as if it were the one asked about.

═══════════════════════════════════════
LIVE DATA INJECTED:
═══════════════════════════════════════
${liveContext || '[No player/game specific context found on active board — pull from deep sports knowledge baseline rules]'}

Today: ${today}
Platform: KasGoatPro | VIP: $299 lifetime | Community: discord.gg/bu3M6kN9sx`;

  const finalMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.filter((m: any) => m.role !== 'system')
  ];


  // ============================================================
  // GOOGLE KEY ROTATION ENGINE
  // Mirrors keyPool.ts pattern — rotates through all 4 Google keys
  // so when one hits daily limit (1500 req/day), next key takes over
  // Keys: GOOGLE_API_KEY, GOOGLE_API_KEY_1, GOOGLE_API_KEY_2, GOOGLE_API_KEY_3
  // ⚠️  Add ALL keys to PAGES project (not just Worker):
  //     dash.cloudflare.com → mr-jackpot (Pages) → Settings → Environment Variables
  // ============================================================
  const googleKeyPool = [
    env?.GOOGLE_API_KEY,
    env?.GOOGLE_API_KEY_1,
    env?.GOOGLE_API_KEY_2,
    env?.GOOGLE_API_KEY_3,
  ].filter(Boolean) as string[];

  if (googleKeyPool.length === 0) {
    console.error('[aiChat] No GOOGLE_API_KEY found in Pages environment variables.');
    return {
      choices: [{ message: { content: "⚠️ AI not connected. Get free keys at aistudio.google.com → Get API Key, then add GOOGLE_API_KEY (and GOOGLE_API_KEY_1, _2, _3) to Cloudflare Pages → mr-jackpot → Settings → Environment Variables 🔑" } }]
    };
  }

  // Best working Gemini models — ordered by speed/reliability
  // ✅ VERIFIED working model names on v1beta/openai/chat/completions (July 2026)
  // gemini-1.5-pro and gemini-1.5-flash are 404 on this endpoint
  const GEMINI_MODELS = [
    'gemini-2.5-flash',       // ✅ newest, fastest, free tier
    'gemini-2.0-flash',       // ✅ solid fallback
    'gemini-2.0-flash-exp',   // ✅ experimental but works
    'gemini-3.5-flash',       // ✅ latest per Google docs July 2026
  ];

  let lastError = '';

  // Outer loop: try each KEY. Inner loop: try each MODEL per key.
  // This gives you 4 keys × 4 models = 16 attempts before giving up.
  // Same rotation logic as keyPool.ts — exhausts one key then moves to next.
  for (let k = 0; k < googleKeyPool.length; k++) {
    const currentKey = googleKeyPool[k];
    console.log(`[aiChat] Trying key slot ${k + 1}/${googleKeyPool.length}`);

    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${currentKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: finalMessages,
              temperature: 0.75,
              max_tokens: 8092
            })
          }
        );

        if (res.ok) {
          const result = await res.json();
          if (result?.choices?.[0]?.message?.content) {
            console.log(`[aiChat] ✅ Key ${k + 1} / model ${model} succeeded`);
            return result;
          }
          lastError = `key${k + 1}/${model}: empty response`;
          continue;
        }

        const errText = await res.text().catch(() => '');
        lastError = `key${k + 1}/${model}: HTTP ${res.status} — ${errText.slice(0, 200)}`;
        console.warn(`[aiChat] ❌ ${lastError}`);

        if (res.status === 401) {
          // 401 = definitely bad key — skip remaining models for this key
          console.warn(`[aiChat] Key ${k + 1} unauthorized (401), rotating to next key`);
          break;
        }

        // 400 = could be token limit, bad model, or bad request — try next model
        // 429 = rate limited — try next model
        // 404 = model not found — try next model
        // All non-401 errors: try next model, not next key
        continue;

      } catch (err: any) {
        lastError = `key${k + 1}/${model}: ${err.message}`;
        console.warn(`[aiChat] ❌ Network error:`, err.message);
        continue;
      }
    }
    // All models on this key failed or key was invalid — try next key
  }

  console.error('[aiChat] ALL keys and models failed. Last error:', lastError);
  return {
    choices: [{ message: { content: `🔥 AI engine error — ${lastError}\n\nIf this keeps happening check Discord: discord.gg/bu3M6kN9sx 💰` } }]
  };
}

// ============================================================
// 🌐 CLOUDFLARE PAGES ROUTE ENTRY POINT
// ============================================================
export async function onRequest(context: any) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const aiResponse = await handleAiChatInternal(request, env);
    return new Response(JSON.stringify(aiResponse), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    console.error('[aiChat] Unhandled error:', error);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '🔥 Mr. Jackpot hit a snag. Check Discord: discord.gg/bu3M6kN9sx' } }]
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}