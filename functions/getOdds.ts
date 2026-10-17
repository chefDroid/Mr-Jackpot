// functions/getOdds.ts
import { fetchWithKeyRotation } from './api/keyPool.ts';
// ESPN free standings API used for real streak data — no key needed

// ============================================================
// ALL AVAILABLE PROP MARKETS PER SPORT
// Every market key the Odds API supports for each league
// ============================================================
const SPORT_PROP_MARKETS: Record<string, string[]> = {
  basketball_nba: [
    // Core stats
    'player_points', 'player_rebounds', 'player_assists', 'player_threes',
    'player_blocks', 'player_steals', 'player_turnovers', 'player_field_goals',
    // Combos
    'player_points_rebounds_assists', 'player_points_rebounds',
    'player_points_assists', 'player_rebounds_assists',
    // Milestone markets
    'player_double_double', 'player_triple_double',
    // First basket
    'player_first_basket',
    // Alternate lines (milestone X+ lines)
    'player_points_alternate', 'player_rebounds_alternate',
    'player_assists_alternate', 'player_threes_alternate',
  ],
  basketball_wnba: [
    'player_points', 'player_rebounds', 'player_assists', 'player_threes',
    'player_blocks', 'player_steals',
    'player_points_rebounds_assists', 'player_double_double',
  ],
  baseball_mlb: [
    // Batter props
    'batter_hits', 'batter_home_runs', 'batter_rbis', 'batter_runs_scored',
    'batter_total_bases', 'batter_stolen_bases', 'batter_walks',
    'batter_singles', 'batter_doubles', 'batter_triples',
    'batter_hits_runs_rbis', 'batter_strikeouts',
    // Pitcher props
    'pitcher_strikeouts', 'pitcher_outs', 'pitcher_hits_allowed',
    'pitcher_earned_runs', 'pitcher_walks', 'pitcher_record_a_win',
    // Alternate batter lines
    'batter_home_runs_alternate', 'batter_hits_alternate',
    'batter_total_bases_alternate',
  ],
  icehockey_nhl: [
    'player_points', 'player_goals', 'player_assists',
    'player_shots_on_goal', 'player_blocked_shots',
    'player_power_play_points', 'player_total_saves',
    'player_anytime_goal_scorer', 'player_first_goal_scorer',
    'player_shots_on_goal_alternate',
  ],
  americanfootball_nfl: [
    'player_pass_yds', 'player_pass_tds', 'player_pass_completions',
    'player_pass_attempts', 'player_pass_interceptions',
    'player_rush_yds', 'player_rush_attempts', 'player_rush_tds',
    'player_reception_yds', 'player_receptions', 'player_reception_tds',
    'player_reception_longest', 'player_rush_reception_yds',
    'player_tackles_assists', 'player_sacks', 'player_solo_tackles',
    'player_anytime_td', 'player_1st_td', 'player_last_td',
    'player_tds_over',
    'player_pass_yds_alternate', 'player_rush_yds_alternate',
    'player_reception_yds_alternate',
  ],
  basketball_ncaab: [
    'player_points', 'player_rebounds', 'player_assists', 'player_threes',
    'player_blocks', 'player_steals', 'player_turnovers',
  ],
  americanfootball_ncaaf: [
    'player_pass_yds', 'player_pass_tds', 'player_rush_yds',
    'player_reception_yds', 'player_receptions', 'player_anytime_td',
  ],
  soccer_usa_mls: [
    'player_goal', 'player_assist', 'player_shots_on_target', 'player_shots',
    'player_offsides', 'player_fouls_committed', 'player_yellow_cards',
    'player_tackles',
  ],
  // ⚠️ Champions League, World Cup, and Liga MX are NOT in this map.
  // Confirmed via The Odds API's own docs: soccer player props are only
  // available for EPL, Ligue 1, Bundesliga, Serie A, La Liga, and MLS.
  // Those three leagues still get real moneyline/totals via the picks
  // route (getLiveOddsWithEV) — just no individual player prop lines.
  soccer_epl: [
    'player_goal', 'player_assist', 'player_shots_on_target', 'player_shots',
    'player_offsides', 'player_fouls_committed', 'player_yellow_cards',
    'player_tackles',
  ],
  soccer_spain_la_liga: [
    'player_goal', 'player_assist', 'player_shots_on_target', 'player_shots',
    'player_offsides', 'player_fouls_committed', 'player_yellow_cards',
    'player_tackles',
  ],
  soccer_germany_bundesliga: [
    'player_goal', 'player_assist', 'player_shots_on_target', 'player_shots',
    'player_offsides', 'player_fouls_committed', 'player_yellow_cards',
    'player_tackles',
  ],
  soccer_italy_serie_a: [
    'player_goal', 'player_assist', 'player_shots_on_target', 'player_shots',
    'player_offsides', 'player_fouls_committed', 'player_yellow_cards',
    'player_tackles',
  ],
  soccer_france_ligue_one: [
    'player_goal', 'player_assist', 'player_shots_on_target', 'player_shots',
    'player_offsides', 'player_fouls_committed', 'player_yellow_cards',
    'player_tackles',
  ],
  mma_mixed_martial_arts: [
    'fighter_win_method', 'fighter_total_rounds',
  ],
  // ⚠️ Unverified: The Odds API's exact market key names for boxing_boxing
  // aren't confirmed here — mirroring MMA's schema as a best guess. If this
  // still comes back empty after the date-fix, check the Odds API docs for
  // the boxing_boxing sport's actual supported market keys before assuming
  // there's just no fight on the board.
  boxing_boxing: [
    'fighter_win_method', 'fighter_total_rounds',
  ],
};

// NOTE: Period markets (h2h_h1, totals_h1, etc.) are NOT supported on the
// bulk /odds endpoint. They only work on /events/{eventId}/odds (per-event).
// The picks route uses only h2h,spreads,totals on /odds.
// The props route fetches per-event and can include period markets in future.

// ============================================================
// MULTI-SOURCE STREAK FETCHER
// Source 1: site.web.api.espn.com (different subdomain, works from Workers)
// Source 2: statsapi.mlb.com (MLB only, totally free, always works)
// Source 3: Implied odds fallback (last resort, never crashes the worker)
//
// ESPN STRK format: "W3" = 3 win streak, "L2" = 2 loss streak
// MLB API format: { streakType: "wins", streakNumber: 3, streakCode: "W3" }
// ============================================================

const ESPN_STANDINGS_URLS: Record<string, string> = {
  basketball_nba:  'https://site.web.api.espn.com/apis/v2/sports/basketball/nba/standings?type=0&level=3',
  basketball_wnba: 'https://site.web.api.espn.com/apis/v2/sports/basketball/wnba/standings?type=0&level=3',
  baseball_mlb:    'https://site.web.api.espn.com/apis/v2/sports/baseball/mlb/standings?type=0&level=3',
  icehockey_nhl:   'https://site.web.api.espn.com/apis/v2/sports/hockey/nhl/standings?type=0&level=3',
  americanfootball_nfl: 'https://site.web.api.espn.com/apis/v2/sports/football/nfl/standings?type=0&level=3',
  basketball_ncaab:     'https://site.web.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/standings?type=0&level=3',
  americanfootball_ncaaf: 'https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings?type=0&level=3',
  // ── Soccer leagues ────────────────────────────────────────
  soccer_usa_mls:            'https://site.web.api.espn.com/apis/v2/sports/soccer/usa.1/standings?type=0&level=1',
  soccer_epl:                'https://site.web.api.espn.com/apis/v2/sports/soccer/eng.1/standings?type=0&level=1',
  soccer_spain_la_liga:      'https://site.web.api.espn.com/apis/v2/sports/soccer/esp.1/standings?type=0&level=1',
  soccer_germany_bundesliga: 'https://site.web.api.espn.com/apis/v2/sports/soccer/ger.1/standings?type=0&level=1',
  soccer_italy_serie_a:      'https://site.web.api.espn.com/apis/v2/sports/soccer/ita.1/standings?type=0&level=1',
  soccer_france_ligue_one:   'https://site.web.api.espn.com/apis/v2/sports/soccer/fra.1/standings?type=0&level=1',
  soccer_mexico_ligamx:      'https://site.web.api.espn.com/apis/v2/sports/soccer/mex.1/standings?type=0&level=1',
  soccer_uefa_champs_league: 'https://site.web.api.espn.com/apis/v2/sports/soccer/uefa.champions/standings?type=0&level=1',
  // ── FIFA World Cup group stage standings ──────────────────
  soccer_fifa_world_cup: 'https://site.web.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?type=0&level=1',
  // ── Individual sports — no team standings (streak stays 0) ─
  tennis_atp: '', tennis_wta: '',
  mma_mixed_martial_arts: '', boxing_boxing: '', cricket_ipl: '',
  golf_pga_tour: '', motorsport_nascar_cup_series: '',

};

// Parse ESPN standings JSON into streakMap regardless of nesting level
function parseESPNEntries(data: any): any[] {
  const entries: any[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (node?.standings?.entries) entries.push(...node.standings.entries);
    if (node?.children) node.children.forEach(walk);
  };
  walk(data);
  return entries;
}

function parseStreakString(raw: string): { streak: number; isWinStreak: boolean } {
  if (!raw || raw.length < 2) return { streak: 0, isWinStreak: false };
  const isWin = raw[0].toUpperCase() === 'W';
  const count = parseInt(raw.slice(1), 10) || 0;
  return { streak: count, isWinStreak: isWin };
}

async function fetchAllStreaksESPN(
  activeSports: string[]
): Promise<Map<string, { streak: number; isWinStreak: boolean }>> {
  const result = new Map<string, { streak: number; isWinStreak: boolean }>();
  const sportsToFetch = activeSports.filter(s => ESPN_STANDINGS_URLS[s]);

  await Promise.allSettled(
    sportsToFetch.map(async (sport) => {
      // ── SOURCE 1: ESPN (site.web subdomain works from Cloudflare Workers) ──
      let loaded = false;
      try {
        const res = await fetch(ESPN_STANDINGS_URLS[sport], {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; MrJackpot/1.0)',
            'Accept': 'application/json',
            'Origin': 'https://www.espn.com',
            'Referer': 'https://www.espn.com/',
          },
          cf: { cacheTtl: 300, cacheEverything: true } as any,
        });

        if (res.ok) {
          const data = await res.json();
          const entries = parseESPNEntries(data);

          for (const entry of entries) {
            const teamName: string = entry?.team?.displayName || entry?.team?.name || '';
            if (!teamName) continue;
            const stats: any[] = entry?.stats || [];
            // ESPN uses name="streak" or abbreviation="STRK"
            const streakStat = stats.find(
              (s: any) => s.name === 'streak' || s.abbreviation === 'STRK' || s.shortDisplayName === 'STRK'
            );
            const raw: string = streakStat?.displayValue || '';
            const parsed = parseStreakString(raw);
            result.set(teamName, parsed);
            // Also store short name + abbreviation as fallback keys
            const short: string = entry?.team?.shortDisplayName || '';
            const abbr: string  = entry?.team?.abbreviation || '';
            if (short && !result.has(short)) result.set(short, parsed);
            if (abbr  && !result.has(abbr))  result.set(abbr,  parsed);
          }

          if (entries.length > 0) {
            loaded = true;
            console.log(`[STREAK ESPN] ${sport}: ${entries.length} teams loaded`);
          }
        } else {
          console.warn(`[STREAK ESPN] ${sport}: HTTP ${res.status}`);
        }
      } catch (e: any) {
        console.warn(`[STREAK ESPN] ${sport} failed:`, e.message);
      }

      // ── SOURCE 2: MLB Stats API fallback (only for baseball_mlb) ──
      if (!loaded && sport === 'baseball_mlb') {
        try {
          const res = await fetch(
            'https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2025&standingsTypes=regularSeason',
            { headers: { 'Accept': 'application/json' } }
          );
          if (res.ok) {
            const data: any = await res.json();
            for (const record of data?.records || []) {
              for (const tr of record?.teamRecords || []) {
                const name: string = tr?.team?.name || '';
                const streakCode: string = tr?.streak?.streakCode || '';
                if (name && streakCode) {
                  result.set(name, parseStreakString(streakCode));
                  console.log(`[STREAK MLB] ${name}: ${streakCode}`);
                }
              }
            }
            loaded = true;
          }
        } catch (e: any) {
          console.warn(`[STREAK MLB API] failed:`, e.message);
        }
      }

      if (!loaded) {
        console.warn(`[STREAK] ${sport}: all sources failed, no stars for this sport`);
      }
    })
  );

  return result;
}

// ============================================================
// UTILITIES
// ============================================================
const americanToDecimal = (odds: number): number =>
  odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);

const impliedProb = (odds: number): number =>
  odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);

const parlayPayout = (stake: number, oddsArray: number[]) => {
  const decimalOdds = oddsArray.reduce((acc, odds) => acc * americanToDecimal(odds), 1);
  return { decimal: decimalOdds.toFixed(2), payout: (stake * decimalOdds).toFixed(2) };
};

function unitTier(odds: number) {
  if (odds <= -200) return { label: "HIGH",     units: 3, weight: 1.2 };
  if (odds <= -150) return { label: "MODERATE", units: 2, weight: 1.0 };
  return                    { label: "LOW",      units: 1, weight: 0.8 };
}

const isToday = (dateStr: string): boolean => {
  const d = new Date(dateStr), n = new Date();
  return d.getUTCDate() === n.getUTCDate() &&
         d.getUTCMonth() === n.getUTCMonth() &&
         d.getUTCFullYear() === n.getUTCFullYear();
};

// ============================================================
// REAL STREAK LOGIC — BallDontLie
// Returns Map<teamName, { streak: number, isWinStreak: boolean }>
// streak = consecutive W count going backward from most recent game
// ============================================================
// ============================================================
// STREAK LABEL — converts real streak count to star emojis
// ============================================================
function buildStreakLabel(streak: number, isWinStreak: boolean): string {
  if (!isWinStreak || streak === 0) return '';
  if (streak >= 8) return '🌟🌟🌟🌟🌟';
  if (streak >= 6) return '🌟🌟🌟🌟';
  if (streak >= 4) return '⭐⭐⭐';
  if (streak >= 3) return '⭐⭐';
  if (streak >= 2) return '⭐';
  return '';
}

// ============================================================
// BUILD PICKS — uses real ESPN streaks for all sports
// Adds: streakLabel ⭐, isTaco 🌮, isDog 🐶
// ============================================================
function buildPicks(games: any[], streakMap: Map<string, { streak: number; isWinStreak: boolean }>) {
  const picks = [];

  for (const g of games) {
    const book = g.bookmakers?.[0];
    if (!book) continue;

    const h2h     = book.markets?.find((m: any) => m.key === 'h2h');
    const spreads = book.markets?.find((m: any) => m.key === 'spreads');
    const totals  = book.markets?.find((m: any) => m.key === 'totals');
    const h1h2h   = book.markets?.find((m: any) => m.key === 'h2h_h1');   // 1st half ML
    const h1tot   = book.markets?.find((m: any) => m.key === 'totals_h1'); // 1st half total

    if (!h2h?.outcomes) continue;

    const fav = [...h2h.outcomes].sort((a: any, b: any) => a.price - b.price)[0];
    const dog = [...h2h.outcomes].sort((a: any, b: any) => b.price - a.price)[0];
    if (!fav) continue;

    const tier            = unitTier(fav.price);
    const confidenceScore = impliedProb(fav.price) * tier.weight;

    // ── REAL STREAK from ESPN standings ──────────────────
    const favStreakData = streakMap.get(fav.name) || { streak: 0, isWinStreak: false };
    const dogStreakData = streakMap.get(dog?.name || '') || { streak: 0, isWinStreak: false };
    const streakLabel   = buildStreakLabel(favStreakData.streak, favStreakData.isWinStreak);

    // ── TACO 🌮 = 90%+ confidence (near lock) ────────────
    // impliedProb × tier weight >= 0.90 means books agree this is a near-certainty
    const isTaco = confidenceScore >= 0.90;

    // ── DOG 🐶 = underdog on a 2+ game win streak ─────────
    // dog.price > 0 means they're the underdog
    // their recent win streak means books may be sleeping on them
    const isDog = (dog?.price ?? 0) > 0 &&
                  dogStreakData.isWinStreak &&
                  dogStreakData.streak >= 2;

    // ── OVER / UNDER recommendation ───────────────────────
    const totalLine    = totals?.outcomes?.[0]?.point ?? null;
    const overOdds     = totals?.outcomes?.find((o: any) => o.name === 'Over')?.price ?? null;
    const underOdds    = totals?.outcomes?.find((o: any) => o.name === 'Under')?.price ?? null;
    let totalPick: string | null = null;
    let totalPickOdds: number | null = null;
    if (overOdds !== null && underOdds !== null) {
      if (overOdds >= underOdds) { totalPick = 'Over';  totalPickOdds = overOdds;  }
      else                       { totalPick = 'Under'; totalPickOdds = underOdds; }
    }

    // ── SPREAD display ────────────────────────────────────
    const favSpread    = spreads?.outcomes?.find((o: any) => o.name === fav.name)?.point ?? null;
    const spreadDisplay = favSpread !== null
      ? (favSpread > 0 ? `+${favSpread}` : `${favSpread}`)
      : null;

    // ── 1ST HALF LINES ────────────────────────────────────
    const h1FavML = h1h2h?.outcomes?.find((o: any) => o.name === fav.name)?.price ?? null;
    const h1Total = h1tot?.outcomes?.[0]?.point ?? null;

    picks.push({
      game:           `${g.home_team} vs ${g.away_team}`,
      sport:          g.sport_key,
      team:           fav.name,
      odds:           fav.price,
      spread:         favSpread,
      spreadDisplay,
      total:          totalLine,
      totalPick,
      totalPickOdds,
      overOdds,
      underOdds,
      // 1st half
      h1FavML,
      h1Total,
      // streak (real ESPN standings data)
      streak:         favStreakData.streak,
      isWinStreak:    favStreakData.isWinStreak,
      streakLabel,
      // emoji badges
      isTaco,         // 🌮 guaranteed / 90%+ conf
      isDog,          // 🐶 underdog on win streak
      // scoring
      tier,
      confidenceScore,
      commence_time:  g.commence_time,
      underdog:       dog?.name,
      underdogOdds:   dog?.price,
      // underdog streak for display
      dogStreak:      dogStreakData.streak,
      dogIsWinStreak: dogStreakData.isWinStreak,
    });
  }

  return picks.sort((a, b) => b.confidenceScore - a.confidenceScore);
}

// ============================================================
// BUILD PLAYER PROPS — adds streak + taco + dog per prop
// Uses the team streak from streakMap for the prop's team
// ============================================================
function buildPlayerProps(
  games: any[],
  statFilter: string,
  streakMap: Map<string, { streak: number; isWinStreak: boolean }>
) {
  function propConfidence(odds: number, line: number): number {
    let score = impliedProb(odds) * 100;
    if (odds <= -180) score += 10;
    if (odds <= -140) score += 5;
    // Round numbers (0.5 lines) are easier props
    if (line % 1 === 0.5) score += 2;
    return Math.round(Math.min(score, 99));
  }

  const bestProps = new Map<string, any>();

  for (const game of games) {
    for (const book of game.bookmakers || []) {
      for (const market of book.markets || []) {
        if (statFilter && statFilter !== 'all' && market.key !== statFilter) continue;

        for (const outcome of market.outcomes || []) {
          if (!outcome.description) continue;

          const conf = propConfidence(outcome.price || -110, outcome.point || 0);

          // Determine which team the player is on
          // ESPN streak lookup uses best of home/away team streak
          const homeTeam  = game.home_team || '';
          const awayTeam  = game.away_team || '';
          // We don't have player→team mapping from Odds API, so use home team streak
          // as a proxy for now (both teams' streaks will be shown in the future)
          const homeStreak = streakMap.get(homeTeam) || { streak: 0, isWinStreak: false };
          const awayStreak = streakMap.get(awayTeam) || { streak: 0, isWinStreak: false };
          // Use the higher streak team for the prop display
          const bestStreak = homeStreak.streak >= awayStreak.streak ? homeStreak : awayStreak;
          const streakLabel = buildStreakLabel(bestStreak.streak, bestStreak.isWinStreak);

          // 🌮 Taco: 90%+ confidence prop
          const isTaco = conf >= 90;

          // 🐶 Dog: prop is on the Over AND the team is on a win streak as underdogs
          // (outcome.name === 'Over' means we're backing more production)
          const isDog = outcome.name === 'Over' &&
                        bestStreak.isWinStreak &&
                        bestStreak.streak >= 2 &&
                        (outcome.price || -110) > -120; // near-even or plus odds Over

          const prop = {
            player:       outcome.description,
            stat:         market.key,
            line:         outcome.point || 0,
            pick:         outcome.name || 'Over',
            odds:         outcome.price || -110,
            game:         game.game || `${homeTeam} vs ${awayTeam}`,
            sport:        game.sport_key,
            commence_time: game.commence_time,
            confidence:   conf,
            team:         homeTeam,
            // streak / badges
            streak:       bestStreak.streak,
            isWinStreak:  bestStreak.isWinStreak,
            streakLabel,
            isTaco,
            isDog,
          };

          const key = `${prop.player}_${prop.stat}_${prop.pick}`;
          const existing = bestProps.get(key);
          if (!existing || prop.confidence > existing.confidence) {
            bestProps.set(key, prop);
          }
        }
      }
    }
  }

  return [...bestProps.values()].sort((a, b) => b.confidence - a.confidence);
}

// ============================================================
// BUILD FIGHT MATCHUPS — for combat sports (UFC/MMA, boxing) where
// player-style props usually aren't posted. Instead of an empty
// screen, show the real opponent vs opponent moneyline.
// ============================================================
function buildFightMatchups(
  games: any[],
  streakMap: Map<string, { streak: number; isWinStreak: boolean }>
) {
  const matchups: any[] = [];

  for (const g of games) {
    const book = g.bookmakers?.[0];
    if (!book) continue;
    const h2h = book.markets?.find((m: any) => m.key === 'h2h');
    if (!h2h?.outcomes?.length) continue;

    const fav = [...h2h.outcomes].sort((a: any, b: any) => a.price - b.price)[0];
    const dog = [...h2h.outcomes].sort((a: any, b: any) => b.price - a.price)[0];
    if (!fav) continue;

    matchups.push({
      player:        fav.name,
      opponent:      dog?.name || '',
      stat:          'moneyline',
      line:          null,
      pick:          'Favorite',
      odds:          fav.price,
      game:          `${g.home_team} vs ${g.away_team}`,
      sport:         g.sport_key,
      commence_time: g.commence_time,
      confidence:    Math.round(Math.min(impliedProb(fav.price) * 100, 99)),
      team:          '',
      streakLabel:   '',
      isTaco:        impliedProb(fav.price) * 100 >= 90,
      isDog:         false,
      isMatchup:     true, // flags this as a fight-card matchup, not a stat-line prop
    });

    if (dog && dog.name !== fav.name) {
      matchups.push({
        player:        dog.name,
        opponent:      fav.name,
        stat:          'moneyline',
        line:          null,
        pick:          'Underdog',
        odds:          dog.price,
        game:          `${g.home_team} vs ${g.away_team}`,
        sport:         g.sport_key,
        commence_time: g.commence_time,
        confidence:    Math.round(Math.min(impliedProb(dog.price) * 100, 99)),
        team:          '',
        streakLabel:   '',
        isTaco:        false,
        isDog:         (dog.price ?? 0) > 100,
        isMatchup:     true,
      });
    }
  }

  return matchups.sort((a, b) => b.confidence - a.confidence);
}

// ============================================================
// GENERATE SLIPS
// ============================================================
function generatePicks(
  games: any[],
  bankroll: number,
  streakMap: Map<string, { streak: number; isWinStreak: boolean }>
) {
    const allowedSports = [
    'basketball_nba', 'basketball_wnba', 'baseball_mlb', 'icehockey_nhl',
    'americanfootball_nfl', 'soccer_usa_mls', 'soccer_epl',
    'soccer_fifa_world_cup', 'soccer_spain_la_liga', 'soccer_germany_bundesliga',
    'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_mexico_ligamx',
    'soccer_uefa_champs_league', 'basketball_ncaab', 'americanfootball_ncaaf',
    'baseball_ncaa', 'golf_pga_tour', 'motorsport_nascar_cup_series',
    'tennis_atp', 'tennis_wta', 'boxing_boxing', 'cricket_ipl',
    'mma_mixed_martial_arts',

  ];
  const filtered  = games.filter(g => allowedSports.includes(g.sport_key));
  const usable    = filtered.length > 0 ? filtered : games;

  const todayGames  = usable.filter(g =>  isToday(g.commence_time));
  const futureGames = usable.filter(g => !isToday(g.commence_time));

  const todayPicks  = buildPicks(todayGames, streakMap);
  const futurePicks = buildPicks(futureGames, streakMap);
  const allPicks    = [...todayPicks, ...futurePicks];
  const safePicks   = todayPicks.length >= 2 ? todayPicks : allPicks.slice(0, 10);

  const buildSlip = (type: string, pool: any[]) => {
    if (!pool?.length) return { type, straights: [], parlay: { legs: [], stake: '0.00', payout: '0.00' } };

    let base = [...pool].sort((a, b) => b.confidenceScore - a.confidenceScore);
    const used = new Set<string>();
    base = base.filter(p => { if (used.has(p.game)) return false; used.add(p.game); return true; });

    if (type === 'underdog')   base = base.filter(p => p.odds > +100);
    if (type === 'highroller') base = base.filter(p => p.odds > -140);
    if (!base.length) base = [...pool].slice(0, 3);

    const straights = base.slice(0, 3).map(p => ({
      ...p,
      amount: (bankroll * (p.tier.units * 0.01)).toFixed(2),
    }));

    const usedLegs = new Set<string>();
    let legs: any[] = [];
    base.forEach(p => { if (!usedLegs.has(p.game)) { usedLegs.add(p.game); legs.push(p); } });
    legs = legs.slice(0, 4);

    if (legs.length < 2) return { type, straights, parlay: { legs: [], stake: '0.00', payout: '0.00' } };

    const stake  = bankroll * 0.05;
    const payout = parlayPayout(stake, legs.map(l => l.odds));
    return { type, straights, parlay: { legs, stake: stake.toFixed(2), payout: payout.payout } };
  };

  const slips = [
    buildSlip('standard',   safePicks),
    buildSlip('highroller', safePicks),
    buildSlip('underdog',   allPicks.filter(p => p.odds > 100)),
  ];

  const nextGames = futureGames.slice(0, 10).map(g => ({
    game:  `${g.home_team} vs ${g.away_team}`,
    time:  g.commence_time,
    sport: g.sport_key,
  }));

  const topDog = allPicks.find(p => p.odds > 120) || allPicks[0] || null;
  return { slips, nextGames, topDog, totalGames: games.length };
}

// ============================================================
// CLOUDFLARE WORKER — CENTRAL ROUTER
// ============================================================
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type':                 'application/json',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    try {
      const url = new URL(request.url);

      // Resolve action
      let action = url.searchParams.get('action');
      if (!action) {
        if (url.pathname.includes('/props'))     action = 'props';
        else if (url.pathname.includes('/picks')) action = 'picks';
        else if (url.pathname.includes('/stocks'))action = 'stocks';
        else                                       action = 'picks';
      }

      const bankroll   = Number(url.searchParams.get('bankroll')) || 100;
      const sport      = url.searchParams.get('sport') || url.searchParams.get('sport_key') || 'basketball_nba';
      const statFilter = url.searchParams.get('statFilter') || url.searchParams.get('stat') || 'all';

        // ──────────────────────────────────────────────────────
       // ROUTE 1: PICKS  (real ESPN streaks — all sports)
      // ──────────────────────────────────────────────────────
      if (action === 'picks') {
        // Sports to pull, NBA first
        // ✅ Sports that have real TEAM vs TEAM matchups with posted odds
        // NFL excluded — off-season, only futures show (Super Bowl winner etc.)
        // Golf/NASCAR excluded — individual sport, no team vs team
        // Soccer leagues INCLUDED — they have h2h/spread/totals team games
        const sports = [
          'basketball_nba', 'basketball_wnba', 'basketball_ncaab',
          'icehockey_nhl', 'baseball_mlb',
          'americanfootball_nfl', 'americanfootball_ncaaf',
          'soccer_fifa_world_cup',   // ✅ Active June 11 - July 19 2026
          'soccer_usa_mls', 'soccer_epl',
          'soccer_spain_la_liga', 'soccer_germany_bundesliga',
          'soccer_italy_serie_a', 'soccer_france_ligue_one',
          'soccer_mexico_ligamx', 'soccer_uefa_champs_league',
          'tennis_atp', 'tennis_wta',  // h2h match winner
          'mma_mixed_martial_arts',    // h2h fight winner
          'boxing_boxing',
          'cricket_ipl',
        ];

        let allGames: any[] = [];

        for (const s of sports) {
          try {
            // ✅ /odds endpoint ONLY supports h2h, spreads, totals
            // Period markets (h2h_h1, totals_h1 etc.) only work on /events/{id}/odds
            const data = await fetchWithKeyRotation(
              `https://api.the-odds-api.com/v4/sports/${s}/odds`,
              `?regions=us&markets=h2h,spreads,totals&oddsFormat=american`,
              env
            );
            if (Array.isArray(data)) allGames.push(...data);
          } catch (e: any) {
            console.error(`[PICKS] Failed ${s}:`, e.message);
          }
        }

        // ✅ ESPN free standings — real streaks for ALL sports, no key needed
        let streakMap = new Map<string, { streak: number; isWinStreak: boolean }>();
        try {
          streakMap = await fetchAllStreaksESPN(sports);
        } catch (e: any) {
          console.warn('[STREAKS] ESPN lookup failed, no stars shown:', e.message);
        }

        const data = generatePicks(allGames, bankroll, streakMap);
        return new Response(JSON.stringify(data), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────────────────────
      // ROUTE 2: PROPS  (now with all markets + streaks + emojis)
      // ──────────────────────────────────────────────────────
      if (action === 'props') {
        const markets = SPORT_PROP_MARKETS[sport] || [];
        let unifiedPropsList: any[] = [];

        if (!markets.length) {
          return new Response(
            JSON.stringify({ props: [], availableMarkets: [], sport }),
            { status: 200, headers: corsHeaders }
          );
        }

        let streakMap = new Map<string, { streak: number; isWinStreak: boolean }>();

        try {
          // Step 1: Get today's events
          const events = await fetchWithKeyRotation(
            `https://api.the-odds-api.com/v4/sports/${sport}/events`,
            '',
            env
          );
          const upcomingEvents = Array.isArray(events) ? events.slice(0, 10) : [];

          // ✅ ESPN free standings — real streaks for ALL sports
          try {
            streakMap = await fetchAllStreaksESPN([sport]);
          } catch (e: any) {
            console.warn('[PROPS STREAKS] ESPN lookup failed:', e.message);
          }

          // Step 3: Fetch props for each event
          // Split markets into batches of 4 (Odds API limit per event call)
          const BATCH_SIZE = 4;
          let allGames: any[] = [];

          for (const event of upcomingEvents) {
            // Batch markets to avoid URL length issues
            for (let i = 0; i < markets.length; i += BATCH_SIZE) {
              const batch = markets.slice(i, i + BATCH_SIZE);
              try {
                const gameData = await fetchWithKeyRotation(
                  `https://api.the-odds-api.com/v4/sports/${sport}/events/${event.id}/odds`,
                  `?regions=us&markets=${batch.join(',')}&oddsFormat=american`,
                  env
                );
                if (gameData?.bookmakers) {
                  // Merge bookmakers across batches for the same event
                  const existingGame = allGames.find(
                    (g: any) => g.id === event.id
                  );
                  if (existingGame) {
                    // Merge markets into existing game's bookmakers
                    for (const bk of gameData.bookmakers) {
                      const existingBk = existingGame.bookmakers.find(
                        (b: any) => b.key === bk.key
                      );
                      if (existingBk) {
                        existingBk.markets.push(...bk.markets);
                      } else {
                        existingGame.bookmakers.push(bk);
                      }
                    }
                  } else {
                    allGames.push({
                      ...gameData,
                      id:         event.id,
                      game:       `${event.home_team} vs ${event.away_team}`,
                      home_team:  event.home_team,
                      away_team:  event.away_team,
                      sport_key:  sport,
                      commence_time: event.commence_time,
                    });
                  }
                }
              } catch (batchErr: any) {
                console.warn(`[PROPS BATCH] ${event.id} batch ${i}:`, batchErr.message);
              }
            }
          }

          unifiedPropsList = buildPlayerProps(allGames, statFilter, streakMap);

          // UFC/MMA and boxing usually don't have fighter props posted.
          // Instead of an empty screen, show the real opponent-vs-opponent
          // moneyline for that card.
          if (!unifiedPropsList.length && (sport === 'mma_mixed_martial_arts' || sport === 'boxing_boxing')) {
            try {
              const h2hGames = await fetchWithKeyRotation(
                `https://api.the-odds-api.com/v4/sports/${sport}/odds`,
                `?regions=us&markets=h2h&oddsFormat=american`,
                env
              );
              if (Array.isArray(h2hGames) && h2hGames.length) {
                unifiedPropsList = buildFightMatchups(h2hGames, streakMap);
              }
            } catch (e: any) {
              console.warn('[PROPS] Fight matchup fallback failed:', e.message);
            }
          }

        } catch (e: any) {
          console.error('[PROPS] Fatal exception:', e.message);
        }

        // No mocked fallback — if the real pipeline came back empty,
        // that's the true state of the board right now (no games with
        // props posted for this sport/date), not something to paper over.
        return new Response(
          JSON.stringify({ props: unifiedPropsList, availableMarkets: markets, sport }),
          { status: 200, headers: corsHeaders }
        );
      }

      // Fallback
      return new Response(
        JSON.stringify({ message: 'Jackpot API Gateway Active.', action, sport }),
        { status: 200, headers: corsHeaders }
      );

    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
  },
};
