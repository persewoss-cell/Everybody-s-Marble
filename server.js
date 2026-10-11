'use strict';

// 모두의 마블 돈 계산기 서버 (외부 라이브러리 없이 Node.js만 사용)
// - 방 만들기 / 참가 / 실시간 동기화(Server-Sent Events)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const game = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const ROOM_TTL = 1000 * 60 * 60 * 24 * 3; // 3일 동안 활동이 없으면 방 삭제

/** @type {Map<string, {room: object, tokens: Record<string,string>, clients: Set<http.ServerResponse>}>} */
const rooms = new Map();

// ---- 저장 / 불러오기 (서버를 껐다 켜도 게임이 이어지도록) ----
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const r of raw) rooms.set(r.room.code, { room: r.room, tokens: r.tokens, clients: new Set() });
    console.log(`저장된 방 ${rooms.size}개를 불러왔습니다.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('저장 파일을 읽지 못했습니다:', e.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = [...rooms.values()].map(({ room, tokens }) => ({ room, tokens }));
    fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, () => {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(data), (err) => {
        if (err) return console.warn('저장 실패:', err.message);
        fs.rename(tmp, DATA_FILE, () => {});
      });
    });
  }, 500);
}

function cleanup() {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    if (now - entry.room.updatedAt > ROOM_TTL && entry.clients.size === 0) rooms.delete(code);
  }
  scheduleSave();
}
setInterval(cleanup, 1000 * 60 * 30).unref();

// ---- 유틸 ----
function newCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(code)) return code;
  }
  throw new game.GameError('방을 더 만들 수 없습니다. 잠시 후 다시 시도해 주세요.');
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new game.GameError('요청이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new game.GameError('잘못된 요청입니다.'));
      }
    });
    req.on('error', reject);
  });
}

function getEntry(code) {
  const entry = rooms.get(String(code));
  if (!entry) throw new game.GameError('방을 찾을 수 없습니다. 방 번호를 확인해 주세요.', { code: 'NO_ROOM' });
  return entry;
}

function auth(entry, token) {
  const pid = Object.keys(entry.tokens).find((id) => entry.tokens[id] === token);
  if (!pid || !entry.room.players.some((p) => p.id === pid)) {
    throw new game.GameError('이 방의 참가자가 아닙니다.', { code: 'NO_AUTH' });
  }
  return pid;
}

function broadcast(entry) {
  const data = `data: ${JSON.stringify(game.publicState(entry.room))}\n\n`;
  for (const res of entry.clients) res.write(data);
  scheduleSave();
}

// ---- 정적 파일 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---- API ----
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', code?, sub?]

  // 방 만들기
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
    const body = await readBody(req);
    const code = newCode();
    const hostId = newId();
    const room = game.createRoom(code, body.name, hostId, body.settings);
    const token = newToken();
    rooms.set(code, { room, tokens: { [hostId]: token }, clients: new Set() });
    scheduleSave();
    return sendJson(res, 200, { code, playerId: hostId, token });
  }

  if (parts[1] !== 'rooms' || !parts[2]) return sendJson(res, 404, { error: '없는 주소입니다.' });
  const entry = getEntry(parts[2]);
  const sub = parts[3];

  // 방 정보(참가 전 미리보기)
  if (req.method === 'GET' && !sub) {
    const { room } = entry;
    return sendJson(res, 200, {
      code: room.code,
      status: room.status,
      players: room.players.map((p) => p.name),
    });
  }

  // 참가
  if (req.method === 'POST' && sub === 'join') {
    const body = await readBody(req);
    const id = newId();
    game.addPlayer(entry.room, body.name, id);
    const token = newToken();
    entry.tokens[id] = token;
    entry.room.updatedAt = Date.now();
    broadcast(entry);
    return sendJson(res, 200, { code: entry.room.code, playerId: id, token });
  }

  // 실시간 상태 구독 (SSE)
  if (req.method === 'GET' && sub === 'events') {
    const pid = auth(entry, url.searchParams.get('token'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\n`);
    res.write(`event: me\ndata: ${JSON.stringify({ playerId: pid })}\n\n`);
    res.write(`data: ${JSON.stringify(game.publicState(entry.room))}\n\n`);
    entry.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      entry.clients.delete(res);
    });
    return;
  }

  // 동작 (돈 주고받기 등)
  if (req.method === 'POST' && sub === 'action') {
    const body = await readBody(req);
    const pid = auth(entry, body.token);
    game.applyAction(entry.room, pid, body.action);
    if (body.action.type === 'kick') delete entry.tokens[body.action.playerId];
    broadcast(entry);
    return sendJson(res, 200, { ok: true });
  }

  // 나가기 (게임 시작 전에만)
  if (req.method === 'POST' && sub === 'leave') {
    const body = await readBody(req);
    const pid = auth(entry, body.token);
    const { room } = entry;
    if (room.status === 'lobby') {
      room.players = room.players.filter((p) => p.id !== pid);
      delete entry.tokens[pid];
      if (!room.players.length) {
        rooms.delete(room.code);
        scheduleSave();
      } else {
        if (room.hostId === pid) room.hostId = room.players[0].id;
        broadcast(entry);
      }
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: '없는 주소입니다.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      if (e instanceof game.GameError) {
        sendJson(res, 400, { error: e.message, ...e.extra });
      } else {
        console.error(e);
        sendJson(res, 500, { error: '서버 오류가 발생했습니다.' });
      }
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  serveStatic(req, res, url.pathname);
});

load();
server.listen(PORT, () => {
  console.log(`\n모두의 마블 돈 계산기 실행 중 (포트 ${PORT})`);
  console.log(`  이 컴퓨터:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) console.log(`  같은 와이파이: http://${ni.address}:${PORT}`);
    }
  }
  console.log('');
});
