const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // New endpoint for live ESPN scoring
    if (url.pathname === '/api/live-scores') {
      return handleLiveScores(request);
    }

    if (url.pathname === '/api/data' || url.pathname === '/api/stream') {
      const id = env.LEAGUE_ROOM.idFromName('shared');
      const stub = env.LEAGUE_ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

// FanDuel 2024/2025 Scoring Rules
const SCORING = {
  passing_yards: 0.04,
  passing_td: 4,
  interception: -1,
  passing_300_bonus: 3,
  
  rushing_yards: 0.1,
  rushing_td: 6,
  rushing_100_bonus: 3,
  
  reception: 0.5,
  receiving_yards: 0.1,
  receiving_td: 6,
  receiving_100_bonus: 3,
  
  two_point_conversion: 2,
  fumble_lost: -2,
  return_td: 6
};

const LEAGUE_TEAMS = ['GB', 'DET', 'KC', 'DAL', 'CIN', 'BAL', 'CHI', 'PHI'];

async function handleLiveScores(request) {
  try {
    // Fetch ESPN scoreboard
    const scoreboard = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
    const scoreboardData = await scoreboard.json();
    
    // Get all league games and check status
    const games = [];
    let allGamesFinal = true;
    
    for (const event of scoreboardData.events || []) {
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors || [];
      
      const gameTeams = competitors
        .map(c => c.team?.abbreviation)
        .filter(t => LEAGUE_TEAMS.includes(t));
      
      if (gameTeams.length === 2) {
        const status = event.status?.type?.name || 'Unknown';
        const isComplete = event.status?.type?.completed || false;
        
        games.push({
          id: event.id,
          name: event.name,
          status: status,
          isComplete: isComplete
        });
        
        // If any game is not complete, we're not done
        if (!isComplete) {
          allGamesFinal = false;
        }
      }
    }
    
    // Fetch stats for each game
    const allPlayerStats = {};
    
    for (const game of games) {
      try {
        const gameResponse = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${game.id}`
        );
        const gameData = await gameResponse.json();
        
        const playerStats = parsePlayerStats(gameData);
        Object.assign(allPlayerStats, playerStats);
      } catch (e) {
        console.error(`Error fetching game ${game.id}:`, e);
      }
    }
    
    return jsonResponse({
      success: true,
      players: allPlayerStats,
      gamesCount: games.length,
      allGamesFinal: allGamesFinal,
      games: games.map(g => ({ name: g.name, status: g.status }))
    });
    
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message
    }, 500);
  }
}

function parsePlayerStats(gameData) {
  const players = {};
  
  if (!gameData?.boxscore?.players) return players;
  
  for (const teamData of gameData.boxscore.players) {
    const teamAbbr = teamData.team?.abbreviation || '';
    
    for (const statCategory of teamData.statistics || []) {
      const statType = statCategory.name?.toLowerCase() || '';
      
      for (const athleteStat of statCategory.athletes || []) {
        const athlete = athleteStat.athlete || {};
        const playerName = athlete.displayName || '';
        const stats = athleteStat.stats || [];
        
        const playerKey = `${playerName}|${teamAbbr}`;
        
        if (!players[playerKey]) {
          players[playerKey] = {
            name: playerName,
            team: teamAbbr,
            stats: {
              passing_yards: 0,
              passing_tds: 0,
              interceptions: 0,
              rushing_yards: 0,
              rushing_tds: 0,
              receptions: 0,
              receiving_yards: 0,
              receiving_tds: 0
            }
          };
        }
        
        try {
          if (statType.includes('passing') && stats.length >= 8) {
            players[playerKey].stats.passing_yards = parseFloat(stats[1]) || 0;
            players[playerKey].stats.passing_tds = parseInt(stats[3]) || 0;
            players[playerKey].stats.interceptions = parseInt(stats[4]) || 0;
          } else if (statType.includes('rushing') && stats.length >= 4) {
            players[playerKey].stats.rushing_yards = parseFloat(stats[1]) || 0;
            players[playerKey].stats.rushing_tds = parseInt(stats[3]) || 0;
          } else if (statType.includes('receiving') && stats.length >= 4) {
            players[playerKey].stats.receptions = parseInt(stats[0]) || 0;
            players[playerKey].stats.receiving_yards = parseFloat(stats[1]) || 0;
            players[playerKey].stats.receiving_tds = parseInt(stats[3]) || 0;
          }
        } catch (e) {
          // Skip parsing errors
        }
      }
    }
  }
  
  // Calculate FanDuel points for each player
  for (const playerKey in players) {
    const stats = players[playerKey].stats;
    let points = 0;
    
    // Passing
    points += stats.passing_yards * SCORING.passing_yards;
    points += stats.passing_tds * SCORING.passing_td;
    points += stats.interceptions * SCORING.interception;
    if (stats.passing_yards >= 300) points += SCORING.passing_300_bonus;
    
    // Rushing
    points += stats.rushing_yards * SCORING.rushing_yards;
    points += stats.rushing_tds * SCORING.rushing_td;
    if (stats.rushing_yards >= 100) points += SCORING.rushing_100_bonus;
    
    // Receiving
    points += stats.receptions * SCORING.reception;
    points += stats.receiving_yards * SCORING.receiving_yards;
    points += stats.receiving_tds * SCORING.receiving_td;
    if (stats.receiving_yards >= 100) points += SCORING.receiving_100_bonus;
    
    players[playerKey].points = Math.round(points * 10) / 10;
  }
  
  return players;
}

export class LeagueRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.dataPromise = this.state.blockConcurrencyWhile(async () => {
      this.teams = (await this.state.storage.get('teams')) || [];
      this.updatedAt = (await this.state.storage.get('updatedAt')) || new Date().toISOString();
    });
  }

  async fetch(request) {
    await this.dataPromise;
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      if (request.method === 'GET') return this.handleGet();
      if (request.method === 'POST') return this.handlePost(request);
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/api/stream' && request.method === 'GET') {
      return this.handleStream(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  buildPayload() {
    return { teams: this.teams, updatedAt: this.updatedAt };
  }

  async handleGet() {
    this.teams = (await this.state.storage.get('teams')) || [];
    this.updatedAt = (await this.state.storage.get('updatedAt')) || new Date().toISOString();
    return jsonResponse(this.buildPayload());
  }

  async handlePost(request) {
    let body;
    try {
      body = await request.json();
    } catch (error) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { teams } = body || {};
    if (!Array.isArray(teams)) {
      return jsonResponse({ error: 'Invalid payload: "teams" must be an array' }, 400);
    }

    this.teams = teams;
    this.updatedAt = new Date().toISOString();
    await this.state.storage.put('teams', this.teams);
    await this.state.storage.put('updatedAt', this.updatedAt);

    const payloadString = JSON.stringify(this.buildPayload());
    this.broadcast(payloadString);

    return jsonResponse(this.buildPayload());
  }

  async handleStream(request) {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    this.sessions.add(writer);

    const sendInitial = JSON.stringify(this.buildPayload());
    await writer.write(encoder.encode(`data: ${sendInitial}\n\n`));

    const heartbeat = setInterval(() => {
      writer.write(encoder.encode(': keep-alive\n\n')).catch(() => {});
    }, 30000);

    const close = () => {
      clearInterval(heartbeat);
      this.sessions.delete(writer);
      writer.close().catch(() => {});
    };

    request.signal.addEventListener('abort', close);

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  broadcast(payloadString) {
    const message = encoder.encode(`data: ${payloadString}\n\n`);
    for (const writer of Array.from(this.sessions)) {
      writer.write(message).catch(() => {
        this.sessions.delete(writer);
      });
    }
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
