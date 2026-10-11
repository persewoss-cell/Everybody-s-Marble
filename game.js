// 모두의 마블(보드게임) 돈 계산 규칙.
// 브라우저(방장 기기)와 Node.js(테스트) 양쪽에서 씁니다.
(function (root) {
'use strict';

// 금액 단위는 "마블" 정수입니다. (화면에서는 '만' 단위로 입력/표시)
const MAN = 10000;

const DEFAULT_SETTINGS = {
  startMoney: 200 * MAN,   // 시작 자금: 각자 200만 마블
  salary: 30 * MAN,        // 출발지를 지날 때마다 월급 30만 마블
  bail: 20 * MAN,          // 무인도 보석금
  monopolyMultiplier: 2,   // 같은 색 도시 독점(컬러 독점) 시 통행료 2배
  olympicMultiplier: 2,    // 올림픽 개최 도시 통행료 배수
  takeoverMultiplier: 2,   // 인수 가격 = 현재 건설가(땅+건물)의 2배
  sellRate: 50,            // 은행에 매각할 때 돌려받는 비율(%)
  autoWin: true,           // 트리플/라인/관광지 독점을 자동으로 판정
};

const MAX_PLAYERS = 4;
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];

class GameError extends Error {
  constructor(message, extra) {
    super(message);
    this.extra = extra || {};
  }
}

function toInt(v, name) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new GameError(`${name || '금액'}이(가) 올바르지 않습니다.`);
  return n;
}

function positiveAmount(v, name) {
  const n = toInt(v, name);
  if (n <= 0) throw new GameError(`${name || '금액'}은(는) 0보다 커야 합니다.`);
  return n;
}

function cleanName(name) {
  const s = String(name || '').trim().slice(0, 12);
  if (!s) throw new GameError('이름을 입력해 주세요.');
  return s;
}

function sanitizeSettings(input, base) {
  const s = { ...(base || DEFAULT_SETTINGS) };
  if (!input) return s;
  const money = ['startMoney', 'salary', 'bail'];
  for (const k of money) {
    if (input[k] !== undefined) {
      const n = toInt(input[k], k);
      if (n < 0) throw new GameError('설정 금액은 0 이상이어야 합니다.');
      s[k] = n;
    }
  }
  for (const k of ['monopolyMultiplier', 'olympicMultiplier', 'takeoverMultiplier']) {
    if (input[k] !== undefined) {
      const n = Number(input[k]);
      if (!Number.isFinite(n) || n < 1 || n > 10) throw new GameError('배수는 1~10 사이여야 합니다.');
      s[k] = n;
    }
  }
  if (input.sellRate !== undefined) {
    const n = toInt(input.sellRate, '매각 비율');
    if (n < 0 || n > 100) throw new GameError('매각 비율은 0~100% 사이여야 합니다.');
    s.sellRate = n;
  }
  if (input.autoWin !== undefined) s.autoWin = !!input.autoWin;
  return s;
}

function createRoom(code, hostName, hostId, settings, board) {
  const room = {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'lobby', // lobby | playing | ended
    hostId,
    settings: sanitizeSettings(settings),
    players: [],
    log: [],
    nextTxId: 1,
    result: null,
    board: sanitizeBoard(board),
    props: {}, // tileId → { owner, built: { villa, building, hotel, landmark }, olympic }
  };
  addPlayer(room, hostName, hostId);
  return room;
}

function addPlayer(room, name, id) {
  if (room.status !== 'lobby') throw new GameError('이미 게임이 시작되어 새로 참가할 수 없습니다.');
  if (room.players.length >= MAX_PLAYERS) throw new GameError(`최대 ${MAX_PLAYERS}명까지 참가할 수 있습니다.`);
  const n = cleanName(name);
  if (room.players.some((p) => p.name === n)) throw new GameError('같은 이름이 이미 있습니다.');
  const used = new Set(room.players.map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
  const player = { id, name: n, color, money: 0, bankrupt: false };
  room.players.push(player);
  return player;
}

function getPlayer(room, id) {
  const p = room.players.find((x) => x.id === id);
  if (!p) throw new GameError('플레이어를 찾을 수 없습니다.');
  return p;
}

function activePlayer(room, id) {
  const p = getPlayer(room, id);
  if (p.bankrupt) throw new GameError(`${p.name}님은 파산했습니다.`);
  return p;
}

function requirePlaying(room) {
  if (room.status !== 'playing') throw new GameError('게임 진행 중이 아닙니다.');
}

function requireHost(room, actorId) {
  if (room.hostId !== actorId) throw new GameError('방장만 할 수 있습니다.');
}

// ---- 도시 가격표 / 땅 소유 ----
// 도시 카드(도시증서)에 적힌 건설비와 통행료를 칸마다 입력해 두면 자동으로 계산합니다.
// 도시 통행료 = 지어진 것(땅·빌라·빌딩·호텔·랜드마크) 통행료의 합 × 컬러 독점 배수 × 올림픽 배수
// 관광지 통행료 = 지어진 가장 높은 단계(땅 → 파라솔 → 방갈로)의 통행료. 관광지는 인수할 수 없음(카드에 인수비용 없음)
const ITEMS = ['land', 'villa', 'building', 'hotel', 'landmark'];
const BUILDINGS = ['villa', 'building', 'hotel', 'landmark'];
const TOUR_ITEMS = ['land', 'parasol', 'bungalow'];
const TOUR_BUILDINGS = ['parasol', 'bungalow'];
const ITEM_NAMES = { land: '땅', villa: '빌라', building: '빌딩', hotel: '호텔', landmark: '랜드마크', parasol: '파라솔', bungalow: '방갈로' };
// 실물 카드 띠 색 기준 (값이 싼 도시부터)
const GROUPS = [
  { name: '연두', color: '#9ccc3c' },
  { name: '초록', color: '#3fa34d' },
  { name: '하늘', color: '#4fc3e8' },
  { name: '파랑', color: '#3b82d6' },
  { name: '분홍', color: '#e47fc0' },
  { name: '보라', color: '#8e5bc4' },
  { name: '주황', color: '#f59a23' },
  { name: '다홍', color: '#e2582a' },
];

function itemsOf(tile) {
  return tile.kind === 'tour' ? TOUR_ITEMS : ITEMS;
}
function buildingsOf(tile) {
  return tile.kind === 'tour' ? TOUR_BUILDINGS : BUILDINGS;
}

// 모두의 마블 보드게임 실물 도시 카드 가격 (단위: 만 마블)
// [이름, 색 번호, 보드 줄, 건설비용(땅·빌라·빌딩·호텔·랜드마크), 통행료(땅·빌라·빌딩·호텔·랜드마크)]
// 인수비용은 건설비용의 2배, 매각비용은 건설비용의 절반으로 카드와 같음
const CARD_CITIES = [
  ['방콕', 0, 0, [2, 1, 4, 6, 6], [0.5, 1, 2, 6, 25]],
  ['베이징', 0, 0, [3, 1, 4, 6, 6], [0.5, 1, 2, 6, 25]],
  ['독도', 'tour', 0],
  ['타이페이', 1, 0, [4, 2, 6, 10, 10], [1, 2, 4, 12, 45]],
  ['두바이', 1, 0, [4, 2, 6, 10, 10], [1, 2, 4, 12, 45]],
  ['카이로', 1, 0, [6, 2, 6, 10, 10], [1, 2, 5, 13, 45]],
  ['발리', 'tour', 1],
  ['도쿄', 2, 1, [8, 4, 8, 16, 16], [2, 3, 8, 22, 60]],
  ['시드니', 2, 1, [8, 4, 8, 16, 16], [2, 3, 8, 22, 60]],
  ['하와이', 'tour', 1],
  ['퀘벡', 3, 1, [10, 4, 12, 20, 20], [2, 5, 11, 27, 70]],
  ['상파울로', 3, 1, [10, 4, 12, 20, 20], [3, 5, 12, 28, 70]],
  ['프라하', 4, 2, [12, 4, 14, 24, 24], [3, 7, 17, 39, 75]],
  ['푸켓', 'tour', 2],
  ['베를린', 4, 2, [12, 4, 14, 24, 24], [3, 7, 17, 39, 75]],
  ['모스크바', 5, 2, [14, 6, 18, 30, 30], [4, 8, 20, 46, 75]],
  ['제네바', 5, 2, [14, 6, 18, 30, 30], [5, 9, 22, 47, 75]],
  ['로마', 5, 2, [14, 6, 18, 30, 30], [5, 9, 22, 47, 75]],
  ['타히티', 'tour', 3],
  ['런던', 6, 3, [16, 8, 22, 36, 36], [5, 12, 28, 60, 70]],
  ['파리', 6, 3, [18, 8, 22, 36, 36], [6, 13, 29, 62, 70]],
  ['뉴욕', 7, 3, [20, 8, 24, 40, 40], [7, 15, 32, 68, 60]],
  ['서울', 7, 3, [22, 8, 24, 40, 40], [8, 16, 34, 70, 60]],
];
// 관광지 카드: 건설비용 각 10만, 통행료 땅 8만 · 파라솔 16만 · 방갈로 32만
const TOUR_COST = [10, 10, 10];
const TOUR_TOLL = [8, 16, 32];

function defaultBoard() {
  return CARD_CITIES.map(([name, group, line, cost, toll], i) => {
    const tour = group === 'tour';
    const items = tour ? TOUR_ITEMS : ITEMS;
    const c = tour ? TOUR_COST : cost;
    const t = tour ? TOUR_TOLL : toll;
    const tile = { id: 'c' + (i + 1), name, kind: tour ? 'tour' : 'city', line, cost: {}, toll: {} };
    if (!tour) tile.group = group;
    items.forEach((k, j) => {
      tile.cost[k] = Math.round(c[j] * MAN);
      tile.toll[k] = Math.round(t[j] * MAN);
    });
    return tile;
  });
}
const LINES = 4;
const MAX_TILES = 60;

function moneyField(v) {
  const n = Math.round(Number(v) || 0);
  if (n < 0 || n > 1e12) throw new GameError('가격표의 금액이 올바르지 않습니다.');
  return n;
}

function sanitizeBoard(input) {
  const tiles = Array.isArray(input) ? input : (input && Array.isArray(input.tiles) ? input.tiles : []);
  if (tiles.length > MAX_TILES) throw new GameError(`칸은 최대 ${MAX_TILES}개까지 넣을 수 있습니다.`);
  const ids = new Set();
  return tiles.map((t, i) => {
    const kind = t.kind === 'tour' ? 'tour' : 'city';
    let id = String(t.id || '').slice(0, 16) || 't' + i;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    const name = String(t.name || '').trim().slice(0, 12) || `칸 ${i + 1}`;
    const line = Math.max(0, Math.min(LINES - 1, Math.round(Number(t.line) || 0)));
    const cost = {};
    const toll = {};
    for (const k of kind === 'city' ? ITEMS : TOUR_ITEMS) {
      cost[k] = moneyField(t.cost && t.cost[k]);
      toll[k] = moneyField(t.toll && t.toll[k]);
    }
    const tile = { id, name, kind, line, cost, toll };
    if (kind === 'city') tile.group = Math.max(0, Math.min(GROUPS.length - 1, Math.round(Number(t.group) || 0)));
    return tile;
  });
}

function getTile(room, tileId) {
  const t = (room.board || []).find((x) => x.id === tileId);
  if (!t) throw new GameError('칸을 찾을 수 없습니다.');
  return t;
}

function builtList(tile, prop) {
  if (!prop) return [];
  return ['land', ...buildingsOf(tile).filter((k) => prop.built && prop.built[k])];
}

// 현재 건설가 (땅 + 지어진 건물 가격의 합)
function constructionValue(tile, prop) {
  return builtList(tile, prop).reduce((sum, k) => sum + (tile.cost[k] || 0), 0);
}

function hasMonopoly(room, ownerId, group) {
  const cities = (room.board || []).filter((t) => t.kind === 'city' && t.group === group);
  return cities.length > 0 && cities.every((t) => room.props[t.id] && room.props[t.id].owner === ownerId);
}

function tollInfo(room, tileId) {
  const tile = getTile(room, tileId);
  const prop = room.props[tileId];
  if (!prop) return { amount: 0, base: 0, parts: [] };
  const built = builtList(tile, prop);
  const base = tile.kind === 'tour'
    ? tile.toll[built[built.length - 1]] || 0
    : built.reduce((sum, k) => sum + (tile.toll[k] || 0), 0);
  let mult = 1;
  const parts = [];
  if (tile.kind === 'city' && hasMonopoly(room, prop.owner, tile.group)) {
    mult *= room.settings.monopolyMultiplier;
    parts.push(`컬러 독점×${room.settings.monopolyMultiplier}`);
  }
  if (prop.olympic > 0) {
    const m = Math.pow(room.settings.olympicMultiplier, prop.olympic);
    mult *= m;
    parts.push(`올림픽×${m}`);
  }
  return { amount: Math.round(base * mult), base, parts };
}

function takeoverPrice(room, tileId) {
  const tile = getTile(room, tileId);
  return Math.round(constructionValue(tile, room.props[tileId]) * room.settings.takeoverMultiplier);
}

function sellPrice(room, tileId) {
  const tile = getTile(room, tileId);
  return Math.floor((constructionValue(tile, room.props[tileId]) * room.settings.sellRate) / 100);
}

// 독점 승리 판정: 트리플 독점 / 라인 독점 / 관광지 독점
function winCheck(room, ownerId) {
  const board = room.board || [];
  const mine = (t) => room.props[t.id] && room.props[t.id].owner === ownerId;
  let colors = 0;
  for (let g = 0; g < GROUPS.length; g++) if (hasMonopoly(room, ownerId, g)) colors++;
  if (colors >= 3) return '트리플 독점';
  for (let l = 0; l < LINES; l++) {
    const line = board.filter((t) => t.line === l);
    if (line.length >= 2 && line.every(mine)) return '라인 독점';
  }
  const tours = board.filter((t) => t.kind === 'tour');
  if (tours.length >= 2 && tours.every(mine)) return '관광지 독점';
  return null;
}

function snapshot(room, tileIds) {
  const out = {};
  for (const id of tileIds) out[id] = room.props[id] ? JSON.parse(JSON.stringify(room.props[id])) : null;
  return out;
}

function pickBuildings(tile, prop, items) {
  const list = Array.isArray(items) ? [...new Set(items)] : [];
  if (!list.length) return [];
  for (const k of list) {
    if (!buildingsOf(tile).includes(k)) throw new GameError('알 수 없는 건물입니다.');
    if (prop && prop.built && prop.built[k]) throw new GameError(`${ITEM_NAMES[k]}은(는) 이미 지어져 있습니다.`);
  }
  if (list.includes('landmark')) {
    const ready = prop && prop.built && prop.built.villa && prop.built.building && prop.built.hotel;
    if (!ready) throw new GameError('랜드마크는 별장·빌딩·호텔이 모두 지어진 도시에 다시 도착했을 때 지을 수 있습니다.');
  }
  if (list.includes('bungalow') && !list.includes('parasol') && !(prop && prop.built && prop.built.parasol)) {
    throw new GameError('방갈로는 파라솔을 지은 다음에 지을 수 있습니다.');
  }
  return buildingsOf(tile).filter((k) => list.includes(k));
}

function ownTile(room, actorId, tileId) {
  const tile = getTile(room, tileId);
  const prop = room.props[tileId];
  if (!prop || prop.owner !== actorId) throw new GameError('내 땅이 아닙니다.');
  return { tile, prop };
}

function maybeAutoWin(room, ownerId, tx) {
  if (!room.settings.autoWin || room.status !== 'playing') return;
  const reason = winCheck(room, ownerId);
  if (reason) {
    room.status = 'ended';
    room.result = { winnerId: ownerId, reason, at: Date.now() };
    tx.endsGame = true;
  }
}

// 거래 기록. deltas: { playerId: 변화량 }, bankruptIds: 이 거래로 파산한 플레이어
function record(room, actorId, kind, text, deltas, extra) {
  for (const [pid, d] of Object.entries(deltas)) {
    getPlayer(room, pid).money += d;
  }
  const tx = {
    id: room.nextTxId++,
    at: Date.now(),
    actorId,
    kind,
    text,
    deltas,
    undone: false,
    ...(extra || {}),
  };
  room.log.push(tx);
  if (room.log.length > 500) room.log.splice(0, room.log.length - 500);
  return tx;
}

function ensureFunds(player, amount) {
  if (player.money < amount) {
    throw new GameError(`잔액이 부족합니다. (${fmt(amount - player.money)} 부족)`, {
      code: 'INSUFFICIENT',
      shortfall: amount - player.money,
    });
  }
}

function fmt(n) {
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  const eok = Math.floor(n / 1e8);
  const man = (n % 1e8) / MAN;
  const manStr = Number.isInteger(man) ? man.toLocaleString('ko-KR') : man.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  if (eok && man) return `${sign}${eok}억 ${manStr}만`;
  if (eok) return `${sign}${eok}억`;
  if (n === 0) return '0';
  if (n < MAN) return n % 1000 === 0 ? `${sign}${n / 1000}천` : `${sign}${n.toLocaleString('ko-KR')}`;
  return `${sign}${manStr}만`;
}

function aliveCount(room) {
  return room.players.filter((p) => !p.bankrupt).length;
}

function checkLastSurvivor(room) {
  if (room.status === 'playing' && room.players.length > 1 && aliveCount(room) === 1) {
    const w = room.players.find((p) => !p.bankrupt);
    room.status = 'ended';
    room.result = { winnerId: w.id, reason: '나머지 플레이어 모두 파산', at: Date.now() };
  }
}

// ---- 액션 ----
const actions = {
  updateSettings(room, actorId, a) {
    requireHost(room, actorId);
    if (room.status !== 'lobby') throw new GameError('게임 시작 전에만 설정을 바꿀 수 있습니다.');
    room.settings = sanitizeSettings(a.settings, room.settings);
  },

  kick(room, actorId, a) {
    requireHost(room, actorId);
    if (room.status !== 'lobby') throw new GameError('게임 시작 전에만 내보낼 수 있습니다.');
    if (a.playerId === room.hostId) throw new GameError('방장은 내보낼 수 없습니다.');
    room.players = room.players.filter((p) => p.id !== a.playerId);
  },

  start(room, actorId) {
    requireHost(room, actorId);
    if (room.status !== 'lobby') throw new GameError('이미 시작했습니다.');
    if (room.players.length < 2) throw new GameError('2명 이상이어야 시작할 수 있습니다.');
    room.status = 'playing';
    const deltas = {};
    for (const p of room.players) {
      p.money = 0;
      p.bankrupt = false;
      deltas[p.id] = room.settings.startMoney;
    }
    record(room, actorId, 'start', `게임 시작! 모두 ${fmt(room.settings.startMoney)} 마블을 받았습니다.`, deltas, { noUndo: true });
  },

  // 출발지 통과(세계여행으로 출발지를 지나갈 때 포함) → 월급
  salary(room, actorId) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const amt = room.settings.salary;
    record(room, actorId, 'salary', `${p.name} 월급 +${fmt(amt)}`, { [p.id]: amt });
  },

  // 통행료: 카드에 적힌 통행료 × (컬러독점 배수) × (올림픽 배수^횟수)
  toll(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const owner = activePlayer(room, a.to);
    if (owner.id === p.id) throw new GameError('자기 땅에는 통행료를 내지 않습니다.');
    const base = positiveAmount(a.base, '통행료');
    const olympics = Math.max(0, Math.min(10, toInt(a.olympics || 0, '올림픽 횟수')));
    let mult = 1;
    const parts = [];
    if (a.monopoly) {
      mult *= room.settings.monopolyMultiplier;
      parts.push(`독점×${room.settings.monopolyMultiplier}`);
    }
    if (olympics > 0) {
      const m = Math.pow(room.settings.olympicMultiplier, olympics);
      mult *= m;
      parts.push(`올림픽×${m}`);
    }
    const amount = Math.round(base * mult);
    ensureFunds(p, amount);
    const city = a.city ? `[${String(a.city).slice(0, 12)}] ` : '';
    const detail = parts.length ? ` (${fmt(base)} ${parts.join(' ')})` : '';
    record(room, actorId, 'toll', `${city}${p.name} → ${owner.name} 통행료 ${fmt(amount)}${detail}`, {
      [p.id]: -amount,
      [owner.id]: amount,
    });
  },

  // 인수: 현재 건설가(땅+건물 가격 합) × 2 를 땅 주인에게 지불. 랜드마크는 인수 불가.
  takeover(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const owner = activePlayer(room, a.to);
    if (owner.id === p.id) throw new GameError('자기 땅은 인수할 수 없습니다.');
    if (a.landmark) throw new GameError('랜드마크가 지어진 도시는 인수할 수 없습니다.');
    const value = positiveAmount(a.value, '건설가');
    const amount = Math.round(value * room.settings.takeoverMultiplier);
    ensureFunds(p, amount);
    const city = a.city ? `[${String(a.city).slice(0, 12)}] ` : '';
    record(room, actorId, 'takeover', `${city}${p.name}이(가) ${owner.name}의 땅 인수 ${fmt(amount)} (${fmt(value)}×${room.settings.takeoverMultiplier})`, {
      [p.id]: -amount,
      [owner.id]: amount,
    });
  },

  // 은행에 지불: 땅 구매, 건물 건설, 보석금, 세금, 찬스카드 등
  payBank(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const amount = positiveAmount(a.amount);
    ensureFunds(p, amount);
    const reason = String(a.reason || '은행에 지불').slice(0, 30);
    record(room, actorId, 'payBank', `${p.name} ${reason} -${fmt(amount)}`, { [p.id]: -amount });
  },

  bail(room, actorId) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const amount = room.settings.bail;
    ensureFunds(p, amount);
    record(room, actorId, 'payBank', `${p.name} 무인도 보석금 -${fmt(amount)}`, { [p.id]: -amount });
  },

  // 은행에서 받기: 찬스카드 보상 등
  receiveBank(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const amount = positiveAmount(a.amount);
    const reason = String(a.reason || '은행에서 받음').slice(0, 30);
    record(room, actorId, 'receiveBank', `${p.name} ${reason} +${fmt(amount)}`, { [p.id]: amount });
  },

  // 다른 플레이어에게 보내기 (찬스카드, 합의 거래 등)
  transfer(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const to = activePlayer(room, a.to);
    if (to.id === p.id) throw new GameError('자신에게는 보낼 수 없습니다.');
    const amount = positiveAmount(a.amount);
    ensureFunds(p, amount);
    const reason = a.reason ? ` (${String(a.reason).slice(0, 30)})` : '';
    record(room, actorId, 'transfer', `${p.name} → ${to.name} ${fmt(amount)}${reason}`, {
      [p.id]: -amount,
      [to.id]: amount,
    });
  },

  // 은행에 땅/건물 매각: 매각 가격(카드에 적힌 건설가 합) × 매각 비율
  sell(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const value = positiveAmount(a.value, '매각할 건설가');
    const amount = Math.floor((value * room.settings.sellRate) / 100);
    const city = a.city ? `[${String(a.city).slice(0, 12)}] ` : '';
    record(room, actorId, 'sell', `${city}${p.name} 매각 +${fmt(amount)} (${fmt(value)}의 ${room.settings.sellRate}%)`, { [p.id]: amount });
  },

  // ---- 도시 가격표로 자동 계산하는 동작 ----
  updateBoard(room, actorId, a) {
    requireHost(room, actorId);
    room.board = sanitizeBoard(a.board);
    const ids = new Set(room.board.map((t) => t.id));
    for (const id of Object.keys(room.props)) if (!ids.has(id)) delete room.props[id];
  },

  // 빈 땅 구매 (+ 원하면 건물도 같이 건설)
  buyTile(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const tile = getTile(room, a.tileId);
    if (room.props[tile.id]) throw new GameError('이미 주인이 있는 땅입니다.');
    const items = pickBuildings(tile, null, a.items);
    const amount = tile.cost.land + items.reduce((s, k) => s + tile.cost[k], 0);
    ensureFunds(p, amount);
    const before = snapshot(room, [tile.id]);
    const built = {};
    for (const k of items) built[k] = true;
    room.props[tile.id] = { owner: p.id, built, olympic: 0 };
    const what = ['땅', ...items.map((k) => ITEM_NAMES[k])].join('+');
    const tx = record(room, actorId, 'buyTile', `[${tile.name}] ${p.name} ${what} 구매 -${fmt(amount)}`, { [p.id]: -amount }, { propsBefore: before });
    maybeAutoWin(room, p.id, tx);
  },

  // 내 땅에 건물 추가 건설
  buildTile(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = ownTile(room, actorId, a.tileId);
    const items = pickBuildings(tile, prop, a.items);
    if (!items.length) throw new GameError('지을 건물을 골라 주세요.');
    const amount = items.reduce((s, k) => s + tile.cost[k], 0);
    ensureFunds(p, amount);
    const before = snapshot(room, [tile.id]);
    prop.built = { ...prop.built };
    for (const k of items) prop.built[k] = true;
    record(room, actorId, 'buildTile', `[${tile.name}] ${p.name} ${items.map((k) => ITEM_NAMES[k]).join('+')} 건설 -${fmt(amount)}`, { [p.id]: -amount }, { propsBefore: before });
  },

  // 다른 사람 땅에 도착 → 통행료 자동 계산
  payTollTile(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const tile = getTile(room, a.tileId);
    const prop = room.props[tile.id];
    if (!prop) throw new GameError('주인이 없는 땅입니다.');
    if (prop.owner === p.id) throw new GameError('자기 땅에는 통행료를 내지 않습니다.');
    const owner = activePlayer(room, prop.owner);
    const info = tollInfo(room, tile.id);
    if (info.amount <= 0) throw new GameError('가격표에 통행료가 입력되지 않았습니다.');
    ensureFunds(p, info.amount);
    const detail = info.parts.length ? ` (${fmt(info.base)} ${info.parts.join(' ')})` : '';
    record(room, actorId, 'toll', `[${tile.name}] ${p.name} → ${owner.name} 통행료 ${fmt(info.amount)}${detail}`, {
      [p.id]: -info.amount,
      [owner.id]: info.amount,
    });
  },

  // 인수: 건설가 × 인수 배수를 주인에게 내고 땅과 건물을 그대로 가져옴. 랜드마크는 인수 불가.
  takeoverTile(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const tile = getTile(room, a.tileId);
    const prop = room.props[tile.id];
    if (!prop) throw new GameError('주인이 없는 땅입니다.');
    if (prop.owner === p.id) throw new GameError('자기 땅은 인수할 수 없습니다.');
    if (tile.kind === 'tour') throw new GameError('관광지는 인수할 수 없습니다.');
    if (prop.built && prop.built.landmark) throw new GameError('랜드마크가 지어진 도시는 인수할 수 없습니다.');
    const owner = activePlayer(room, prop.owner);
    const amount = takeoverPrice(room, tile.id);
    ensureFunds(p, amount);
    const before = snapshot(room, [tile.id]);
    prop.owner = p.id;
    const tx = record(room, actorId, 'takeover', `[${tile.name}] ${p.name}이(가) ${owner.name}의 땅 인수 ${fmt(amount)}`, {
      [p.id]: -amount,
      [owner.id]: amount,
    }, { propsBefore: before });
    maybeAutoWin(room, p.id, tx);
  },

  // 내 땅을 은행에 매각
  sellTile(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile } = ownTile(room, actorId, a.tileId);
    const amount = sellPrice(room, tile.id);
    const before = snapshot(room, [tile.id]);
    delete room.props[tile.id];
    record(room, actorId, 'sell', `[${tile.name}] ${p.name} 매각 +${fmt(amount)} (${room.settings.sellRate}%)`, { [p.id]: amount }, { propsBefore: before });
  },

  // 올림픽 개최: 내 도시의 통행료 배수 증가
  olympicTile(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = ownTile(room, actorId, a.tileId);
    if (tile.kind !== 'city') throw new GameError('올림픽은 도시에서만 열 수 있습니다.');
    if ((prop.olympic || 0) >= 5) throw new GameError('더 이상 올림픽을 열 수 없습니다.');
    const before = snapshot(room, [tile.id]);
    prop.olympic = (prop.olympic || 0) + 1;
    record(room, actorId, 'olympic', `[${tile.name}] ${p.name} 올림픽 개최 (통행료 ×${Math.pow(room.settings.olympicMultiplier, prop.olympic)})`, {}, { propsBefore: before });
  },

  // 파산: 남은 현금은 빚진 상대(또는 은행)에게 넘어가고 부족한 금액은 내지 않음.
  bankrupt(room, actorId, a) {
    requirePlaying(room);
    const target = a.playerId && a.playerId !== actorId ? (requireHost(room, actorId), a.playerId) : actorId;
    const p = activePlayer(room, target);
    const deltas = { [p.id]: -p.money };
    let text = `${p.name} 파산`;
    if (a.to) {
      const to = activePlayer(room, a.to);
      if (to.id === p.id) throw new GameError('잘못된 대상입니다.');
      deltas[to.id] = p.money;
      text += ` — 남은 ${fmt(p.money)}을(를) ${to.name}에게`;
    } else if (p.money > 0) {
      text += ` — 남은 ${fmt(p.money)}은(는) 은행으로`;
    }
    // 파산한 사람의 땅과 건물은 은행으로 돌아감
    const owned = Object.keys(room.props).filter((id) => room.props[id].owner === p.id);
    const before = snapshot(room, owned);
    for (const id of owned) delete room.props[id];
    if (owned.length) text += ` · 땅 ${owned.length}곳은 은행으로`;
    p.bankrupt = true;
    const tx = record(room, actorId, 'bankrupt', text, deltas, { bankruptIds: [p.id], propsBefore: before });
    checkLastSurvivor(room);
    if (room.status === 'ended') tx.endsGame = true;
  },

  // 방장 전용: 잔액 직접 수정 (실수 보정용)
  adjust(room, actorId, a) {
    requireHost(room, actorId);
    requirePlaying(room);
    const p = getPlayer(room, a.playerId);
    const money = toInt(a.money, '잔액');
    if (money < 0) throw new GameError('잔액은 0 이상이어야 합니다.');
    const d = money - p.money;
    if (d === 0) return;
    record(room, actorId, 'adjust', `방장이 ${p.name} 잔액 수정 ${fmt(p.money)} → ${fmt(money)}`, { [p.id]: d });
  },

  // 되돌리기: 본인 거래는 본인이, 모든 거래는 방장이
  undo(room, actorId, a) {
    if (room.status === 'lobby') throw new GameError('되돌릴 거래가 없습니다.');
    if (room.status === 'ended') {
      const t = room.log.find((x) => x.id === Number(a.txId));
      if (!t || !t.endsGame) throw new GameError('게임이 끝났습니다. 게임을 끝낸 거래만 취소할 수 있습니다.');
    }
    const tx = room.log.find((t) => t.id === Number(a.txId));
    if (!tx) throw new GameError('거래를 찾을 수 없습니다.');
    if (tx.undone) throw new GameError('이미 취소된 거래입니다.');
    if (tx.noUndo || tx.kind === 'undo') throw new GameError('이 기록은 되돌릴 수 없습니다.');
    if (tx.actorId !== actorId && room.hostId !== actorId) throw new GameError('본인 거래만 되돌릴 수 있습니다. (방장은 모두 가능)');
    const inverse = {};
    for (const [pid, d] of Object.entries(tx.deltas)) inverse[pid] = -d;
    for (const pid of tx.bankruptIds || []) getPlayer(room, pid).bankrupt = false;
    for (const [id, prev] of Object.entries(tx.propsBefore || {})) {
      if (prev) room.props[id] = prev;
      else delete room.props[id];
    }
    if (tx.endsGame && room.status === 'ended') {
      room.status = 'playing';
      room.result = null;
    }
    tx.undone = true;
    const actor = getPlayer(room, actorId);
    record(room, actorId, 'undo', `${actor.name}이(가) 취소: ${tx.text}`, inverse, { noUndo: true, undoOf: tx.id });
  },

  // 게임 종료: 트리플 독점 / 라인 독점 / 관광지 독점 / 기타
  end(room, actorId, a) {
    requireHost(room, actorId);
    requirePlaying(room);
    const w = activePlayer(room, a.winnerId);
    const reasons = { triple: '트리플 독점', line: '라인 독점', tour: '관광지 독점', other: '게임 종료' };
    room.status = 'ended';
    room.result = { winnerId: w.id, reason: reasons[a.reason] || reasons.other, at: Date.now() };
  },

  // 다시 하기 (같은 사람들로 로비로)
  reset(room, actorId) {
    requireHost(room, actorId);
    room.status = 'lobby';
    room.result = null;
    room.log = [];
    room.props = {};
    for (const p of room.players) {
      p.money = 0;
      p.bankrupt = false;
    }
  },
};

function applyAction(room, actorId, action) {
  if (!action || typeof action.type !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action.type)) {
    throw new GameError('알 수 없는 동작입니다.');
  }
  getPlayer(room, actorId);
  if (!room.board) room.board = [];
  if (!room.props) room.props = {};
  actions[action.type](room, actorId, action);
  room.updatedAt = Date.now();
}

// 클라이언트에 보낼 공개 상태 (토큰 제외)
function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    settings: room.settings,
    players: room.players.map(({ id, name, color, money, bankrupt }) => ({ id, name, color, money, bankrupt })),
    log: room.log.slice(-100),
    result: room.result,
    board: room.board || [],
    props: room.props || {},
  };
}

const api = {
  MAN,
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  GameError,
  createRoom,
  addPlayer,
  applyAction,
  publicState,
  sanitizeSettings,
  sanitizeBoard,
  fmt,
  ITEMS,
  BUILDINGS,
  TOUR_ITEMS,
  TOUR_BUILDINGS,
  itemsOf,
  buildingsOf,
  defaultBoard,
  ITEM_NAMES,
  GROUPS,
  LINES,
  tollInfo,
  takeoverPrice,
  sellPrice,
  constructionValue,
  hasMonopoly,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.MarbleGame = api;
})(typeof self !== 'undefined' ? self : this);
