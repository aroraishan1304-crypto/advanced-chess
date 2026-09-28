const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Chess } = require('chess.js');

const PORT = Number(process.env.PORT || 5500);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const games = new Map();
const MAX_BODY = 64 * 1024;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const TIME_CONTROLS = {
  '1+0': { label: '1 + 0 · Bullet', initialSeconds: 60, incrementSeconds: 0 },
  '1+1': { label: '1 + 1 · Bullet', initialSeconds: 60, incrementSeconds: 1 },
  '2+1': { label: '2 + 1 · Bullet', initialSeconds: 120, incrementSeconds: 1 },
  '3+0': { label: '3 + 0 · Blitz', initialSeconds: 180, incrementSeconds: 0 },
  '3+2': { label: '3 + 2 · Blitz', initialSeconds: 180, incrementSeconds: 2 },
  '5+0': { label: '5 + 0 · Blitz', initialSeconds: 300, incrementSeconds: 0 },
  '5+3': { label: '5 + 3 · Blitz', initialSeconds: 300, incrementSeconds: 3 },
  '10+0': { label: '10 + 0 · Rapid', initialSeconds: 600, incrementSeconds: 0 },
  '10+5': { label: '10 + 5 · Rapid', initialSeconds: 600, incrementSeconds: 5 },
  '15+10': { label: '15 + 10 · Rapid', initialSeconds: 900, incrementSeconds: 10 },
  '30+0': { label: '30 + 0 · Classical', initialSeconds: 1800, incrementSeconds: 0 },
  unlimited: { label: 'Unlimited', initialSeconds: Infinity, incrementSeconds: 0, unlimited: true },
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: 'Not found.' });
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function serverError(res, message) {
  console.error(message);
  json(res, 500, { error: 'Server error.' });
}

function makeId(length = 8) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return out;
}

function makeUniqueGameId() {
  let id;
  do id = makeId(6); while (games.has(id));
  return id;
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeName(name, fallback) {
  const value = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return value || fallback;
}

function sendEvent(game, payload) {
  const message = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of game.clients) {
    try {
      client.write(message);
    } catch {
      game.clients.delete(client);
    }
  }
}

function currentClockMs(game) {
  const clocks = { ...game.clocksMs };
  if (game.status !== 'playing' || game.timeControl.unlimited) return clocks;
  const elapsed = Math.max(0, Date.now() - game.turnStartedAt);
  clocks[game.turn] = Math.max(0, clocks[game.turn] - elapsed);
  return clocks;
}

function stateFor(game) {
  return {
    gameId: game.id,
    status: game.status,
    timeControl: game.timeControlKey,
    timeControlLabel: game.timeControl.label,
    unlimited: !!game.timeControl.unlimited,
    fen: game.chess.fen(),
    pgn: game.chess.pgn(),
    moves: game.chess.history({ verbose: true }),
    turn: game.chess.turn(),
    clocksMs: currentClockMs(game),
    serverNow: Date.now(),
    turnStartedAt: game.turnStartedAt,
    players: {
      w: game.players.w ? { name: game.players.w.name, connected: game.players.w.connected } : null,
      b: game.players.b ? { name: game.players.b.name, connected: game.players.b.connected } : null,
    },
    result: game.result,
    drawOffer: game.drawOffer,
    canJoin: !game.players.w || !game.players.b,
  };
}

function findPlayer(game, token) {
  if (!token) return null;
  if (game.players.w?.token === token) return { color: 'w', player: game.players.w };
  if (game.players.b?.token === token) return { color: 'b', player: game.players.b };
  return null;
}

function broadcast(game) {
  sendEvent(game, stateFor(game));
}

function finish(game, resultText, winner = null) {
  if (game.status === 'finished') return;
  game.status = 'finished';
  game.result = { text: resultText, winner };
  game.turnStartedAt = Date.now();
  broadcast(game);
}

function evaluateNaturalEnd(game) {
  if (game.chess.isCheckmate()) {
    const winner = game.chess.turn() === 'w' ? 'b' : 'w';
    finish(game, `${winner === 'w' ? '1-0' : '0-1'} · checkmate`, winner);
    return true;
  }
  if (game.chess.isStalemate()) { finish(game, '½-½ · stalemate', null); return true; }
  if (game.chess.isInsufficientMaterial()) { finish(game, '½-½ · insufficient material', null); return true; }
  if (game.chess.isDrawByFiftyMoves()) { finish(game, '½-½ · 50-move rule', null); return true; }
  if (game.chess.isThreefoldRepetition()) { finish(game, '½-½ · threefold repetition', null); return true; }
  if (typeof game.chess.isDraw === 'function' && game.chess.isDraw()) { finish(game, '½-½ · draw', null); return true; }
  return false;
}

function checkTimeout(game) {
  if (game.status !== 'playing' || game.timeControl.unlimited || !game.players.w || !game.players.b) return false;
  const clocks = currentClockMs(game);
  if (clocks[game.turn] > 0) return false;
  game.clocksMs = clocks;
  const loser = game.turn;
  const winner = loser === 'w' ? 'b' : 'w';
  if (game.chess.isInsufficientMaterial()) {
    finish(game, '½-½ · timeout with insufficient material', null);
  } else {
    finish(game, `${winner === 'w' ? '1-0' : '0-1'} · time`, winner);
  }
  return true;
}

function parseTimeControl(key) {
  const config = TIME_CONTROLS[key];
  if (!config) return null;
  return { ...config };
}

function assignColor(game) {
  if (!game.players.w) return 'w';
  if (!game.players.b) return 'b';
  return null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON.'); }
}

function createGame(body) {
  const timeControlKey = String(body.timeControl || '10+0');
  const timeControl = parseTimeControl(timeControlKey);
  if (!timeControl) throw new Error('Invalid time control.');

  const id = makeUniqueGameId();
  const chess = new Chess();
  const game = {
    id,
    chess,
    timeControlKey,
    timeControl,
    players: { w: null, b: null },
    status: 'waiting',
    clocksMs: {
      w: timeControl.unlimited ? Infinity : timeControl.initialSeconds * 1000,
      b: timeControl.unlimited ? Infinity : timeControl.initialSeconds * 1000,
    },
    turn: 'w',
    turnStartedAt: Date.now(),
    result: null,
    drawOffer: null,
    clients: new Set(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  const token = makeToken();
  game.players.w = { token, name: normalizeName(body.name, 'White'), connected: false };
  games.set(id, game);
  return { game, color: 'w', token };
}

function joinGame(game, body) {
  if (!game) throw new Error('Game not found.');
  const existing = findPlayer(game, body.token);
  if (existing) return { color: existing.color, token: existing.player.token };
  const color = assignColor(game);
  if (!color) throw new Error('This game already has two players.');
  const token = makeToken();
  game.players[color] = { token, name: normalizeName(body.name, color === 'w' ? 'White' : 'Black'), connected: false };
  if (game.players.w && game.players.b && game.status === 'waiting') {
    game.status = 'playing';
    game.turnStartedAt = Date.now();
  }
  game.lastActivityAt = Date.now();
  return { color, token };
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' || pathname === '/chess.html' ? 'chess.html' : pathname.replace(/^\/+/, '');
  if (file.includes('..')) return notFound(res);
  const abs = path.join(ROOT, file);
  if (!abs.startsWith(ROOT)) return notFound(res);
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const ext = path.extname(abs).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.wasm': 'application/wasm',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, games: games.size, time: Date.now() });
    }

    if (pathname === '/api/games' && req.method === 'POST') {
      const body = await readBody(req);
      const { game, color, token } = createGame(body);
      return json(res, 201, { gameId: game.id, color, token, state: stateFor(game) });
    }

    const match = pathname.match(/^\/api\/games\/([A-Z0-9]+)(?:\/(events|join|move|action))?$/i);
    if (match) {
      const gameId = match[1].toUpperCase();
      const action = match[2] || null;
      const game = games.get(gameId);
      if (!game) return json(res, 404, { error: 'Game not found.' });

      if (req.method === 'GET' && !action) {
        return json(res, 200, { state: stateFor(game) });
      }

      if (req.method === 'GET' && action === 'events') {
        const token = url.searchParams.get('token');
        const player = findPlayer(game, token);
        if (!player) return json(res, 403, { error: 'Invalid player token.' });
        player.player.connected = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 1500\n\n`);
        res.write(`event: state\ndata: ${JSON.stringify(stateFor(game))}\n\n`);
        game.clients.add(res);
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
        }, 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          game.clients.delete(res);
          const p = findPlayer(game, token);
          if (p) p.player.connected = false;
        });
        return;
      }

      if (req.method === 'POST' && action === 'join') {
        const body = await readBody(req);
        const joined = joinGame(game, body);
        broadcast(game);
        return json(res, 200, { gameId, ...joined, state: stateFor(game) });
      }

      if (req.method === 'POST' && action === 'move') {
        const body = await readBody(req);
        const player = findPlayer(game, body.token);
        if (!player) return json(res, 403, { error: 'Invalid player token.' });
        if (game.status !== 'playing') return json(res, 409, { error: 'Game is not active.' });
        if (game.chess.turn() !== player.color) return json(res, 409, { error: 'It is not your turn.' });
        if (checkTimeout(game)) return json(res, 409, { error: 'Your clock has expired.' });

        const clocks = currentClockMs(game);
        game.clocksMs = clocks;
        const move = {
          from: String(body.from || ''),
          to: String(body.to || ''),
        };
        if (body.promotion) move.promotion = String(body.promotion).toLowerCase();
        let played;
        try {
          played = game.chess.move(move);
        } catch {
          return json(res, 409, { error: 'Illegal move.' });
        }
        const mover = player.color;
        if (!game.timeControl.unlimited) {
          game.clocksMs[mover] += game.timeControl.incrementSeconds * 1000;
        }
        game.turn = game.chess.turn();
        game.turnStartedAt = Date.now();
        game.drawOffer = null;
        game.lastActivityAt = Date.now();
        evaluateNaturalEnd(game);
        broadcast(game);
        return json(res, 200, { ok: true, move: played, state: stateFor(game) });
      }

      if (req.method === 'POST' && action === 'action') {
        const body = await readBody(req);
        const player = findPlayer(game, body.token);
        if (!player) return json(res, 403, { error: 'Invalid player token.' });
        const actionName = String(body.action || '');

        if (actionName === 'resign') {
          if (game.status !== 'playing') return json(res, 409, { error: 'Game is already over.' });
          const winner = player.color === 'w' ? 'b' : 'w';
          finish(game, `${winner === 'w' ? '1-0' : '0-1'} · resignation`, winner);
        } else if (actionName === 'abort') {
          if (game.status === 'finished') return json(res, 409, { error: 'Game is already over.' });
          if (game.chess.history().length > 0) return json(res, 409, { error: 'A started game cannot be aborted; resign instead.' });
          finish(game, 'Game aborted', null);
        } else if (actionName === 'draw_offer') {
          if (game.status !== 'playing') return json(res, 409, { error: 'Game is already over.' });
          game.drawOffer = player.color;
          game.lastActivityAt = Date.now();
          broadcast(game);
        } else if (actionName === 'draw_decline') {
          if (game.drawOffer && game.drawOffer !== player.color) {
            game.drawOffer = null;
            game.lastActivityAt = Date.now();
            broadcast(game);
          }
        } else if (actionName === 'draw_cancel') {
          if (game.drawOffer === player.color) {
            game.drawOffer = null;
            game.lastActivityAt = Date.now();
            broadcast(game);
          }
        } else if (actionName === 'heartbeat') {
          player.player.connected = true;
          game.lastActivityAt = Date.now();
        } else if (actionName === 'draw_accept') {
          if (game.status !== 'playing' || !game.drawOffer || game.drawOffer === player.color) {
            return json(res, 409, { error: 'No opponent draw offer to accept.' });
          }
          finish(game, '½-½ · draw by agreement', null);
        } else if (actionName === 'claim_threefold') {
          if (game.status !== 'playing' || !game.chess.isThreefoldRepetition()) return json(res, 409, { error: 'Threefold repetition is not claimable.' });
          finish(game, '½-½ · claimed threefold repetition', null);
        } else if (actionName === 'claim_fifty') {
          if (game.status !== 'playing' || !game.chess.isDrawByFiftyMoves()) return json(res, 409, { error: '50-move draw is not claimable.' });
          finish(game, '½-½ · claimed 50-move draw', null);
        } else {
          return badRequest(res, 'Unknown game action.');
        }

        return json(res, 200, { ok: true, state: stateFor(game) });
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }

    return serveStatic(req, res, pathname);
  } catch (error) {
    if (error.message === 'Invalid JSON.' || error.message === 'Request body too large.') return badRequest(res, error.message);
    return serverError(res, error.stack || String(error));
  }
});

setInterval(() => {
  for (const game of games.values()) {
    if (game.status === 'playing' && checkTimeout(game)) {
      // checkTimeout broadcasts the finished state.
    }
  }
}, 250);

// Clean up abandoned waiting games and very old finished games.
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games) {
    const age = now - game.lastActivityAt;
    if (game.status === 'waiting' && age > 6 * 60 * 60 * 1000 && game.clients.size === 0) games.delete(id);
    if (game.status === 'finished' && age > 24 * 60 * 60 * 1000 && game.clients.size === 0) games.delete(id);
  }
}, 10 * 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`Advanced Chess multiplayer server listening on http://${HOST}:${PORT}`);
});
