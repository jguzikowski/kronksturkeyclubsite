const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data' || url.pathname === '/api/stream') {
      const id = env.LEAGUE_ROOM.idFromName('shared');
      const stub = env.LEAGUE_ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

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
