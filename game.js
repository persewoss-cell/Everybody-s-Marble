// 모두의 마블 메가 디럭스(보드게임) 돈 계산 규칙 — 룰북 기준.
// 방장 기기에서 실행되고, 다른 기기는 결과를 미리 보기 위해 같은 코드를 씁니다.
(function (root) {
'use strict';

const MAN = 10000; // 금액 단위는 "마블" 정수. 화면에서는 '만' 단위로 보여 줌

const START_MONEY = 200 * MAN; // 2-② 마블 나누기
const SALARY = 30 * MAN;       // 출발지를 지날 때 월급
const BAIL = 20 * MAN;         // 무인도 보석금
const TAX = 20 * MAN;          // 국세청 세금
const TRAVEL = 10 * MAN;       // 세계여행 비용
const OLYMPIC_COST = 10 * MAN; // 올림픽 개최 비용
const SPONSOR = 10 * MAN;      // 포춘카드 '후원금'
const BONUS = [40 * MAN, 80 * MAN, 160 * MAN]; // 보너스 게임 연속 1·2·3회 성공
const TOUR_PRICE = 10 * MAN;
const TOUR_TOLL = [8 * MAN, 16 * MAN, 32 * MAN]; // 깃발 · 파라솔 · 방갈로
const TOUR_SELL = 5 * MAN;
const MAX_OLYMPIC = 4; // 최대 4번 중복 개최 → ×5
const MAX_PLAYERS = 4;
// 입체 캐릭터 말 4색. 방에 들어오면 각자 고름 (방장부터)
const PIECES = [
  { name: '빨강', color: '#e74c3c' },
  { name: '노랑', color: '#f1c40f' },
  { name: '초록', color: '#2ecc71' },
  { name: '파랑', color: '#3498db' },
];

const BUILDINGS = ['villa', 'building', 'hotel', 'landmark'];
const ITEM_NAMES = { land: '땅', villa: '빌라', building: '빌딩', hotel: '호텔', landmark: '랜드마크' };
const TOUR_LEVELS = ['깃발', '파라솔', '방갈로'];

// 컬러독점 8곳 (룰북 9쪽 예시의 색 이름)
const GROUPS = [
  { name: '연두', color: '#9ccc3c' },
  { name: '초록', color: '#3fa34d' },
  { name: '하늘', color: '#4fc3e8' },
  { name: '파랑', color: '#3b82d6' },
  { name: '핑크', color: '#e47fc0' },
  { name: '보라', color: '#8e5bc4' },
  { name: '주황', color: '#f59a23' },
  { name: '빨강', color: '#e2482a' },
];
const LINE_NAMES = ['A', 'D', 'C', 'B']; // 출발지에서 시계방향 순서

// 도시증서 23장 (단위: 만 마블). 보드 순서대로, 출발지에서 시계방향.
// 도시: [이름, 색, 줄, 건설비용(땅·빌라·빌딩·호텔·랜드마크), 통행료(땅·빌라·빌딩·호텔·랜드마크)]
// 인수비용 = 건설비용 × 2, 매각비용 = 건설비용 ÷ 2 (도시증서와 같음)
// 관광지: [이름, 'island' | 'beach', 줄]
const CARDS = [
  ['방콕', 0, 0, [2, 1, 4, 6, 6], [0.5, 1, 2, 6, 25]],
  ['베이징', 0, 0, [3, 1, 4, 6, 6], [0.5, 1, 2, 6, 25]],
  ['독도', 'island', 0],
  ['타이페이', 1, 0, [4, 2, 6, 10, 10], [1, 2, 4, 12, 45]],
  ['두바이', 1, 0, [4, 2, 6, 10, 10], [1, 2, 4, 12, 45]],
  ['카이로', 1, 0, [6, 2, 6, 10, 10], [1, 2, 5, 13, 45]],
  ['발리', 'beach', 1],
  ['도쿄', 2, 1, [8, 4, 8, 16, 16], [2, 3, 8, 22, 60]],
  ['시드니', 2, 1, [8, 4, 8, 16, 16], [2, 3, 8, 22, 60]],
  ['퀘벡', 3, 1, [10, 4, 12, 20, 20], [2, 5, 11, 27, 70]],
  ['하와이', 'island', 1],
  ['상파울로', 3, 1, [10, 4, 12, 20, 20], [3, 5, 12, 28, 70]],
  ['프라하', 4, 2, [12, 4, 14, 24, 24], [3, 7, 17, 39, 75]],
  ['푸켓', 'island', 2],
  ['베를린', 4, 2, [12, 4, 14, 24, 24], [3, 7, 17, 39, 75]],
  ['모스크바', 5, 2, [14, 6, 18, 30, 30], [4, 8, 20, 46, 75]],
  ['제네바', 5, 2, [14, 6, 18, 30, 30], [5, 9, 22, 47, 75]],
  ['로마', 5, 2, [14, 6, 18, 30, 30], [5, 9, 22, 47, 75]],
  ['타히티', 'beach', 3],
  ['파리', 6, 3, [18, 8, 22, 36, 36], [6, 13, 29, 62, 70]],
  ['런던', 6, 3, [16, 8, 22, 36, 36], [5, 12, 28, 60, 70]],
  ['뉴욕', 7, 3, [20, 8, 24, 40, 40], [7, 15, 32, 68, 60]],
  ['서울', 7, 3, [22, 8, 24, 40, 40], [8, 16, 34, 70, 60]],
];
const ITEMS = ['land', ...BUILDINGS];
const BOARD = CARDS.map(([name, kind, line, cost, toll], i) => {
  const id = 'c' + (i + 1);
  if (typeof kind === 'string') return { id, name, kind: 'tour', tour: kind, line };
  const t = { id, name, kind: 'city', group: kind, line, cost: {}, toll: {} };
  ITEMS.forEach((k, j) => {
    t.cost[k] = Math.round(cost[j] * MAN);
    t.toll[k] = Math.round(toll[j] * MAN);
  });
  return t;
});
const TILE = Object.fromEntries(BOARD.map((t) => [t.id, t]));

// 게임판 32칸 (룰북 2쪽 그림). 0 = 출발지에서 시계방향.
// 아래(A): 출발 → 방콕 … 카이로 → 무인도 / 왼쪽(D) → 올림픽 / 위(C) → 세계여행 / 오른쪽(B) → 서울 → 출발
const SPECIALS = {
  start: { name: '출발', icon: '🏁' },
  bonus: { name: '보너스 게임', short: '보너스', icon: '🪙' },
  island: { name: '무인도', icon: '🏝️' },
  card: { name: '포춘카드', icon: '🃏' },
  olympic: { name: '올림픽', icon: '🏅' },
  travel: { name: '세계여행', icon: '✈️' },
  tax: { name: '국세청', icon: '🧾' },
};
const LAYOUT = [
  'start', '방콕', 'bonus', '베이징', '독도', '타이페이', '두바이', '카이로',
  'island', '발리', '도쿄', '시드니', 'card', '퀘벡', '하와이', '상파울로',
  'olympic', '프라하', '푸켓', '베를린', 'card', '모스크바', '제네바', '로마',
  'travel', '타히티', '런던', '파리', 'card', '뉴욕', 'tax', '서울',
];
const SPACES = LAYOUT.map((key, pos) => {
  if (SPECIALS[key]) return { pos, kind: 'special', key, ...SPECIALS[key] };
  const t = BOARD.find((x) => x.name === key);
  t.pos = pos;
  return t;
});
BOARD.sort((a, b) => a.pos - b.pos);
const POS = { start: 0, bonus: 2, island: 8, olympic: 16, travel: 24, tax: 30 };

class GameError extends Error {
  constructor(message, extra) {
    super(message);
    this.extra = extra || {};
  }
}

function fmt(n) {
  const sign = n < 0 ? '-' : '';
  n = Math.abs(Math.round(n));
  const eok = Math.floor(n / 1e8);
  const rest = n % 1e8;
  const man = Math.floor(rest / MAN);
  const won = rest % MAN;
  const parts = [];
  if (eok) parts.push(`${eok}억`);
  if (man) parts.push(`${man.toLocaleString('ko-KR')}만`);
  if (won) parts.push(won % 1000 === 0 ? `${won / 1000}천` : won.toLocaleString('ko-KR'));
  return parts.length ? sign + parts.join(' ') : '0';
}

function toInt(v, name) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new GameError(`${name || '금액'}이(가) 올바르지 않습니다.`);
  return n;
}
function positive(v, name) {
  const n = toInt(v, name);
  if (n <= 0) throw new GameError(`${name || '금액'}은(는) 0보다 커야 합니다.`);
  return n;
}
function cleanName(name) {
  const s = String(name || '').trim().slice(0, 12);
  if (!s) throw new GameError('이름을 입력해 주세요.');
  return s;
}

// ---- 방 ----
function createRoom(code, hostName, hostId) {
  const room = {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'lobby', // lobby | playing | ended
    hostId,
    players: [],
    props: {},     // tileId → { owner, built: { villa, building, hotel, landmark }, visits }
    olympic: null, // { tileId, count } — 한 곳에만, count 1~4 → 통행료 ×2~×5
    festival: [],  // 축제도시 3곳
    effects: {},   // tileId → { epidemic, dust, blackout }
    log: [],
    nextTxId: 1,
    result: null,
  };
  addPlayer(room, hostName, hostId);
  return room;
}

function addPlayer(room, name, id) {
  if (room.status !== 'lobby') throw new GameError('이미 게임이 시작되어 새로 참가할 수 없습니다. 같은 이름으로 들어오면 이어서 할 수 있어요.');
  if (room.players.length >= MAX_PLAYERS) throw new GameError(`최대 ${MAX_PLAYERS}명까지 참가할 수 있습니다.`);
  const n = cleanName(name);
  if (room.players.some((p) => p.name === n)) throw new GameError('같은 이름이 이미 있습니다.');
  const player = { id, name: n, color: null, money: 0, laps: 0, pos: 0, bankrupt: false };
  room.players.push(player);
  return player;
}

function findByName(room, name) {
  const n = String(name || '').trim().slice(0, 12);
  return room.players.find((p) => p.name === n) || null;
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
function getTile(id) {
  const t = TILE[id];
  if (!t) throw new GameError('칸을 찾을 수 없습니다.');
  return t;
}
function ensureFunds(p, amount, sellable) {
  if (p.money < amount) {
    throw new GameError(`마블이 ${fmt(amount - p.money)} 부족합니다.`, {
      code: 'INSUFFICIENT',
      shortfall: amount - p.money,
      sellable: !!sellable, // 통행료·세금은 도시를 매각해서 낼 수 있음
    });
  }
}

// ---- 땅 계산 ----
function builtItems(tile, prop) {
  if (!prop || tile.kind !== 'city') return [];
  return ['land', ...BUILDINGS.filter((k) => prop.built && prop.built[k])];
}
function ownerOf(room, tileId) {
  return room.props[tileId] ? room.props[tileId].owner : null;
}
function hasMonopoly(room, ownerId, group) {
  const cities = BOARD.filter((t) => t.kind === 'city' && t.group === group);
  return cities.every((t) => ownerOf(room, t.id) === ownerId);
}

// 관광지 단계: 0=깃발, 1=파라솔, 2=방갈로
// 섬(독도·하와이·푸켓)은 한 사람이 가진 섬 개수, 해변(발리·타히티)은 구매 뒤 방문 횟수
function tourLevel(room, tile) {
  const prop = room.props[tile.id];
  if (!prop) return -1;
  if (tile.tour === 'island') {
    const n = BOARD.filter((t) => t.tour === 'island' && ownerOf(room, t.id) === prop.owner).length;
    return Math.min(2, n - 1);
  }
  return Math.min(2, prop.visits || 0);
}

// 턴 제한: 첫 턴 빌라까지, 두 번째 빌딩까지, 세 번째 호텔까지, 그 뒤 자유 (턴 = 출발지 통과 횟수 + 1)
function maxBuilding(player) {
  return BUILDINGS[Math.min(3, player.laps)];
}
function canBuild(player, item) {
  return BUILDINGS.indexOf(item) <= Math.min(3, player.laps);
}

function tollInfo(room, tileId, opts) {
  const tile = getTile(tileId);
  const prop = room.props[tileId];
  const parts = [];
  if (!prop) return { amount: 0, base: 0, parts };
  let base;
  if (tile.kind === 'tour') {
    const lv = tourLevel(room, tile);
    base = TOUR_TOLL[lv];
    parts.push(TOUR_LEVELS[lv]);
  } else {
    base = builtItems(tile, prop).reduce((s, k) => s + tile.toll[k], 0);
  }
  let mult = 1;
  if (tile.kind === 'city' && hasMonopoly(room, prop.owner, tile.group)) {
    mult *= 2;
    parts.push('컬러독점 ×2');
  }
  if (room.festival.includes(tileId)) {
    mult *= 2;
    parts.push('축제 ×2');
  }
  if (room.olympic && room.olympic.tileId === tileId) {
    mult *= room.olympic.count + 1;
    parts.push(`올림픽 ×${room.olympic.count + 1}`);
  }
  const fx = room.effects[tileId] || {};
  if (fx.epidemic) {
    mult *= 0.5;
    parts.push('전염병 ½');
  }
  if (fx.dust) {
    mult *= 0.5;
    parts.push('황사 ½');
  }
  if (fx.blackout) {
    mult = 0;
    parts.push('정전 무료');
  }
  if (opts && opts.angel) {
    mult = 0;
    parts.push('천사 면제');
  } else if (opts && opts.coupon) {
    mult *= 0.5;
    parts.push('할인쿠폰 ½');
  }
  return { amount: Math.round(base * mult), base, parts };
}

// 인수비용 = 건설된 것의 인수비용 합 (= 건설비용 × 2). 관광지·랜드마크 도시는 인수 불가
function takeoverPrice(room, tileId) {
  const tile = getTile(tileId);
  return builtItems(tile, room.props[tileId]).reduce((s, k) => s + tile.cost[k] * 2, 0);
}
// 매각비용 = 건설된 것의 매각비용 합 (= 건설비용 ÷ 2). 관광지는 항상 5만
function sellPrice(room, tileId) {
  const tile = getTile(tileId);
  if (!room.props[tileId]) return 0;
  if (tile.kind === 'tour') return TOUR_SELL;
  return builtItems(tile, room.props[tileId]).reduce((s, k) => s + tile.cost[k] / 2, 0);
}

// 승리독점: 트리플 / 라인 / 관광지
function winCheck(room, pid) {
  let colors = 0;
  for (let g = 0; g < GROUPS.length; g++) if (hasMonopoly(room, pid, g)) colors++;
  if (colors >= 3) return '트리플 독점';
  for (let l = 0; l < LINE_NAMES.length; l++) {
    if (BOARD.filter((t) => t.line === l).every((t) => ownerOf(room, t.id) === pid)) return '라인 독점';
  }
  if (BOARD.filter((t) => t.kind === 'tour').every((t) => ownerOf(room, t.id) === pid)) return '관광지 독점';
  return null;
}

function removeProp(room, tileId) {
  delete room.props[tileId];
  delete room.effects[tileId];
  if (room.olympic && room.olympic.tileId === tileId) room.olympic = null;
}

// 가장 비싼(상위) 건물 하나 파괴
function destroyTop(tile, prop) {
  if (!prop || tile.kind !== 'city' || prop.built.landmark) return null;
  for (const k of ['hotel', 'building', 'villa']) {
    if (prop.built[k]) {
      prop.built = { ...prop.built, [k]: false };
      return k;
    }
  }
  return null;
}

// ---- 기록과 되돌리기 ----
// 거래마다 그 직전 상태를 저장해 두고, 되돌리기는 가장 최근 거래부터 하나씩 되돌림
const UNDO_DEPTH = 40;
function snapshot(room) {
  return JSON.parse(JSON.stringify({
    status: room.status,
    result: room.result,
    players: room.players,
    props: room.props,
    olympic: room.olympic,
    effects: room.effects,
  }));
}

function record(room, actorId, kind, text, deltas, before) {
  for (const [pid, d] of Object.entries(deltas || {})) getPlayer(room, pid).money += d;
  const tx = { id: room.nextTxId++, at: Date.now(), actorId, kind, text, deltas: deltas || {}, before };
  room.log.push(tx);
  if (room.log.length > 300) room.log.splice(0, room.log.length - 300);
  let kept = 0;
  for (let i = room.log.length - 1; i >= 0; i--) {
    if (room.log[i].before && ++kept > UNDO_DEPTH) delete room.log[i].before;
  }
  return tx;
}

function autoWin(room, ...pids) {
  if (room.status !== 'playing') return;
  for (const pid of pids) {
    const p = room.players.find((x) => x.id === pid);
    if (!p || p.bankrupt) continue;
    const reason = winCheck(room, pid);
    if (reason) {
      room.status = 'ended';
      room.result = { winnerId: pid, reason, at: Date.now() };
      return;
    }
  }
}

function lastSurvivor(room) {
  const alive = room.players.filter((p) => !p.bankrupt);
  if (room.status === 'playing' && room.players.length > 1 && alive.length === 1) {
    room.status = 'ended';
    room.result = { winnerId: alive[0].id, reason: '나머지 모두 파산', at: Date.now() };
  }
}

function tileOf(room, tileId, check) {
  const tile = getTile(tileId);
  const prop = room.props[tileId];
  if (check === 'free' && prop) throw new GameError('이미 주인이 있는 땅입니다.');
  if (check === 'owned' && !prop) throw new GameError('주인이 없는 땅입니다.');
  return { tile, prop };
}

function noLandmark(tile, prop, what) {
  if (prop && prop.built && prop.built.landmark) throw new GameError(`랜드마크가 건설된 도시는 ${what}할 수 없습니다.`);
}

function pickBuildings(player, tile, prop, items) {
  const list = [...new Set(Array.isArray(items) ? items : [])];
  for (const k of list) {
    if (!BUILDINGS.includes(k)) throw new GameError('알 수 없는 건물입니다.');
    if (prop && prop.built[k]) throw new GameError(`${ITEM_NAMES[k]}은(는) 이미 있습니다.`);
    if (!canBuild(player, k)) {
      throw new GameError(`${player.laps + 1}번째 턴에는 ${ITEM_NAMES[maxBuilding(player)]}까지만 지을 수 있습니다.`);
    }
  }
  if (list.includes('landmark')) {
    const b = prop ? prop.built : {};
    if (!(b.villa && b.building && b.hotel)) throw new GameError('랜드마크는 빌라·빌딩·호텔이 모두 세워진 내 도시에 도착했을 때 지을 수 있습니다.');
  }
  return BUILDINGS.filter((k) => list.includes(k));
}

// 땅에 도착(방문): 전염병·황사·정전 해제, 해변 관광지 단계 올라감
function visit(room, tile, prop) {
  delete room.effects[tile.id];
  if (tile.tour === 'beach' && prop) prop.visits = Math.min(2, (prop.visits || 0) + 1);
}

const PAY = {
  bail: [BAIL, '무인도 보석금'],
  tax: [TAX, '국세청 세금'],
  travel: [TRAVEL, '세계여행 비용'],
};

// ---- 동작 ----
const actions = {
  // 말 색 고르기: 방장이 먼저, 이미 고른 색은 안 됨
  pickColor(room, actorId, a) {
    if (room.status !== 'lobby') throw new GameError('게임 시작 전에만 색을 고를 수 있습니다.');
    if (!PIECES.some((c) => c.color === a.color)) throw new GameError('알 수 없는 색입니다.');
    const host = getPlayer(room, room.hostId);
    if (actorId !== room.hostId && !host.color) throw new GameError('방장이 먼저 색을 골라요.');
    const other = room.players.find((p) => p.color === a.color && p.id !== actorId);
    if (other) throw new GameError(`${other.name}님이 이미 고른 색이에요.`);
    getPlayer(room, actorId).color = a.color;
  },

  // 내 말 옮기기 (돈 거래 없음, 기록 안 남김)
  move(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const to = toInt(a.to, '칸');
    if (to < 0 || to >= SPACES.length) throw new GameError('알 수 없는 칸입니다.');
    p.pos = to;
  },

  kick(room, actorId, a) {
    requireHost(room, actorId);
    if (room.status !== 'lobby') throw new GameError('게임 시작 전에만 내보낼 수 있습니다.');
    if (a.playerId === room.hostId) throw new GameError('방장은 내보낼 수 없습니다.');
    room.players = room.players.filter((p) => p.id !== a.playerId);
  },

  // 게임 시작: 모두 200만 마블, 축제도시 3곳 무작위
  start(room, actorId) {
    requireHost(room, actorId);
    if (room.status !== 'lobby') throw new GameError('이미 시작했습니다.');
    if (room.players.length < 2) throw new GameError('2명 이상이어야 시작할 수 있습니다.');
    const noColor = room.players.filter((p) => !p.color).map((p) => p.name);
    if (noColor.length) throw new GameError(`${noColor.join(', ')}님이 아직 말 색을 고르지 않았어요.`);
    room.status = 'playing';
    room.props = {};
    room.effects = {};
    room.olympic = null;
    const ids = BOARD.map((t) => t.id);
    room.festival = [];
    while (room.festival.length < 3) room.festival.push(ids.splice(Math.floor(Math.random() * ids.length), 1)[0]);
    const deltas = {};
    for (const p of room.players) {
      p.money = 0;
      p.laps = 0;
      p.pos = 0;
      p.bankrupt = false;
      deltas[p.id] = START_MONEY;
    }
    const names = room.festival.map((id) => TILE[id].name).join(', ');
    record(room, actorId, 'start', `게임 시작! 모두 ${fmt(START_MONEY)} · 축제도시: ${names}`, deltas);
  },

  // 출발지를 지날 때 월급 (월급 부스터 카드면 2배). 턴이 하나 늘어남
  salary(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const before = snapshot(room);
    const amt = a.booster ? SALARY * 2 : SALARY;
    p.laps++;
    record(room, actorId, 'salary', `${p.name} 월급 +${fmt(amt)}${a.booster ? ' (월급 부스터)' : ''} · ${p.laps + 1}번째 턴`, { [p.id]: amt }, before);
  },

  // 빈 도시 구매 (+ 턴 제한 안에서 건물도 함께)
  buy(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile } = tileOf(room, a.tileId, 'free');
    let amount;
    let what;
    let items = [];
    if (tile.kind === 'tour') {
      amount = TOUR_PRICE;
      what = '관광지';
    } else {
      items = pickBuildings(p, tile, null, a.items);
      amount = tile.cost.land + items.reduce((s, k) => s + tile.cost[k], 0);
      what = ['땅', ...items.map((k) => ITEM_NAMES[k])].join('+');
    }
    ensureFunds(p, amount);
    const before = snapshot(room);
    const built = {};
    for (const k of items) built[k] = true;
    room.props[tile.id] = { owner: p.id, built, visits: 0 };
    record(room, actorId, 'buy', `[${tile.name}] ${p.name} ${what} 구매 -${fmt(amount)}`, { [p.id]: -amount }, before);
    autoWin(room, p.id);
  },

  // 내 도시에 건물 추가 (도착했을 때)
  build(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = tileOf(room, a.tileId, 'owned');
    if (prop.owner !== p.id) throw new GameError('내 도시가 아닙니다.');
    if (tile.kind !== 'city') throw new GameError('관광지 건물은 조건에 따라 자동으로 바뀝니다.');
    const items = pickBuildings(p, tile, prop, a.items);
    if (!items.length) throw new GameError('지을 건물을 골라 주세요.');
    const amount = items.reduce((s, k) => s + tile.cost[k], 0);
    ensureFunds(p, amount);
    const before = snapshot(room);
    visit(room, tile, prop);
    prop.built = { ...prop.built };
    for (const k of items) prop.built[k] = true;
    record(room, actorId, 'build', `[${tile.name}] ${p.name} ${items.map((k) => ITEM_NAMES[k]).join('+')} 건설 -${fmt(amount)}`, { [p.id]: -amount }, before);
  },

  // 내 땅에 도착: 효과 해제, 해변 관광지 단계 올리기
  arrive(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = tileOf(room, a.tileId, 'owned');
    if (prop.owner !== p.id) throw new GameError('내 땅이 아닙니다.');
    const before = snapshot(room);
    visit(room, tile, prop);
    record(room, actorId, 'arrive', `[${tile.name}] ${p.name} 도착`, {}, before);
  },

  // 다른 사람 땅에 도착 → 통행료 (천사: 면제, 할인쿠폰: 50%). 해변은 지금 단계로 내고 한 단계 올라감
  toll(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = tileOf(room, a.tileId, 'owned');
    if (prop.owner === p.id) throw new GameError('내 땅에는 통행료를 내지 않습니다.');
    const owner = activePlayer(room, prop.owner);
    const info = tollInfo(room, tile.id, { angel: a.angel, coupon: a.coupon });
    ensureFunds(p, info.amount, true);
    const before = snapshot(room);
    visit(room, tile, prop);
    const detail = info.parts.length ? ` (${info.parts.join(' · ')})` : '';
    record(room, actorId, 'toll', `[${tile.name}] ${p.name} → ${owner.name} 통행료 ${fmt(info.amount)}${detail}`, {
      [p.id]: -info.amount,
      [owner.id]: info.amount,
    }, before);
  },

  // 인수: 통행료를 낸 뒤 인수비용을 주인에게. 관광지·랜드마크 도시는 불가
  takeover(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = tileOf(room, a.tileId, 'owned');
    if (prop.owner === p.id) throw new GameError('내 도시는 인수할 수 없습니다.');
    if (tile.kind === 'tour') throw new GameError('관광지는 인수할 수 없습니다.');
    noLandmark(tile, prop, '인수');
    const owner = activePlayer(room, prop.owner);
    const amount = takeoverPrice(room, tile.id);
    ensureFunds(p, amount);
    const before = snapshot(room);
    prop.owner = p.id;
    record(room, actorId, 'takeover', `[${tile.name}] ${p.name}이(가) ${owner.name}의 도시 인수 -${fmt(amount)}`, {
      [p.id]: -amount,
      [owner.id]: amount,
    }, before);
    autoWin(room, p.id);
  },

  // 매각: 통행료·세금이 부족할 때 은행에 팔고 매각비용을 받음
  sell(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = tileOf(room, a.tileId, 'owned');
    if (prop.owner !== p.id) throw new GameError('내 땅이 아닙니다.');
    const amount = sellPrice(room, tile.id);
    const before = snapshot(room);
    removeProp(room, tile.id);
    record(room, actorId, 'sell', `[${tile.name}] ${p.name} 매각 +${fmt(amount)}`, { [p.id]: amount }, before);
  },

  // 보석금 · 세금 · 세계여행 비용
  pay(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const item = PAY[a.what];
    if (!item) throw new GameError('알 수 없는 항목입니다.');
    ensureFunds(p, item[0], a.what === 'tax');
    const before = snapshot(room);
    record(room, actorId, 'pay', `${p.name} ${item[1]} -${fmt(item[0])}`, { [p.id]: -item[0] }, before);
  },

  // 올림픽 개최 (10만): 한 곳에만. 같은 도시면 중복 개최(최대 ×5), 다른 도시면 마크를 옮겨 ×2
  olympic(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = tileOf(room, a.tileId, 'owned');
    if (prop.owner !== p.id) throw new GameError('내 도시에만 개최할 수 있습니다.');
    const same = room.olympic && room.olympic.tileId === tile.id;
    if (same && room.olympic.count >= MAX_OLYMPIC) throw new GameError('올림픽은 최대 4번(×5)까지 개최할 수 있습니다.');
    ensureFunds(p, OLYMPIC_COST);
    const before = snapshot(room);
    room.olympic = { tileId: tile.id, count: same ? room.olympic.count + 1 : 1 };
    record(room, actorId, 'olympic', `[${tile.name}] ${p.name} 올림픽 개최 (통행료 ×${room.olympic.count + 1}) -${fmt(OLYMPIC_COST)}`, { [p.id]: -OLYMPIC_COST }, before);
  },

  // 보너스 게임: 연속 성공 횟수 0~3
  bonus(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const n = Math.max(0, Math.min(3, toInt(a.wins, '성공 횟수')));
    const before = snapshot(room);
    const amt = n ? BONUS[n - 1] : 0;
    record(room, actorId, 'bonus', `${p.name} 보너스 게임 ${n ? `${n}회 성공 +${fmt(amt)}` : '실패'}`, amt ? { [p.id]: amt } : {}, before);
  },

  // 포춘카드 '후원금': 모두에게서 10만씩 (모자라면 가진 만큼)
  sponsor(room, actorId) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const before = snapshot(room);
    const deltas = { [p.id]: 0 };
    for (const o of room.players) {
      if (o.id === p.id || o.bankrupt) continue;
      const amt = Math.min(SPONSOR, Math.max(0, o.money));
      deltas[o.id] = -amt;
      deltas[p.id] += amt;
    }
    record(room, actorId, 'sponsor', `${p.name} 후원금 +${fmt(deltas[p.id])}`, deltas, before);
  },

  transfer(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const amount = positive(a.amount);
    if (a.to === 'bank') {
      // 은행에 따로 낼 일이 있을 때
      ensureFunds(p, amount);
      const before = snapshot(room);
      record(room, actorId, 'transfer', `${p.name} → 은행 ${fmt(amount)}`, { [p.id]: -amount }, before);
      return;
    }
    const to = activePlayer(room, a.to);
    if (to.id === p.id) throw new GameError('자신에게는 보낼 수 없습니다.');
    ensureFunds(p, amount);
    const before = snapshot(room);
    record(room, actorId, 'transfer', `${p.name} → ${to.name} 송금 ${fmt(amount)}`, { [p.id]: -amount, [to.id]: amount }, before);
  },

  // ---- 포춘카드 공격 ----
  // 전염병: 고른 도시와 같은 색 도시 모두 통행료 50% (방문자가 생기면 해제)
  epidemic(room, actorId, a) {
    const { p, tile } = attackTarget(room, actorId, a.tileId, { city: true });
    const before = snapshot(room);
    const hit = BOARD.filter((t) => t.kind === 'city' && t.group === tile.group && room.props[t.id]);
    for (const t of hit) room.effects[t.id] = { ...room.effects[t.id], epidemic: true };
    record(room, actorId, 'card', `${p.name} 전염병 → ${hit.map((t) => t.name).join(', ')} 통행료 50%`, {}, before);
  },
  dust(room, actorId, a) {
    const { p, tile } = attackTarget(room, actorId, a.tileId, {});
    const before = snapshot(room);
    room.effects[tile.id] = { ...room.effects[tile.id], dust: true };
    record(room, actorId, 'card', `${p.name} 황사 → [${tile.name}] 통행료 50%`, {}, before);
  },
  blackout(room, actorId, a) {
    const { p, tile } = attackTarget(room, actorId, a.tileId, {});
    const before = snapshot(room);
    room.effects[tile.id] = { ...room.effects[tile.id], blackout: true };
    record(room, actorId, 'card', `${p.name} 도시정전 → [${tile.name}] 무료통과`, {}, before);
  },
  // 지진: 상대 도시의 가장 비싼 건물 하나 파괴
  quake(room, actorId, a) {
    const { p, tile, prop } = attackTarget(room, actorId, a.tileId, { city: true, noLandmark: '공격' });
    const before = snapshot(room);
    const k = destroyTop(tile, prop);
    if (!k) throw new GameError('파괴할 건물이 없습니다.');
    record(room, actorId, 'card', `${p.name} 지진 → [${tile.name}] ${ITEM_NAMES[k]} 파괴`, {}, before);
  },
  // 외계인 침공: 같은 색 도시마다 가장 비싼 건물 하나씩 파괴 (랜드마크 도시 제외)
  alien(room, actorId, a) {
    const { p, tile } = attackTarget(room, actorId, a.tileId, { city: true });
    const before = snapshot(room);
    const done = [];
    for (const t of BOARD.filter((x) => x.kind === 'city' && x.group === tile.group)) {
      const k = destroyTop(t, room.props[t.id]);
      if (k) done.push(`${t.name} ${ITEM_NAMES[k]}`);
    }
    if (!done.length) throw new GameError('파괴할 건물이 없습니다.');
    record(room, actorId, 'card', `${p.name} 외계인 침공 → ${done.join(', ')} 파괴`, {}, before);
  },
  // 강제매각: 상대 도시를 없애고, 주인은 은행에서 매각비용을 받음
  forceSell(room, actorId, a) {
    const { p, tile, owner } = attackTarget(room, actorId, a.tileId, { noLandmark: '공격' });
    const amount = sellPrice(room, tile.id);
    const before = snapshot(room);
    removeProp(room, tile.id);
    record(room, actorId, 'card', `${p.name} 강제매각 → [${tile.name}] ${owner.name} 매각비용 +${fmt(amount)}`, { [owner.id]: amount }, before);
  },
  // 도시체인지: 상대 도시 하나와 내 도시 하나를 맞교환 (랜드마크 도시 제외)
  swap(room, actorId, a) {
    const { p, tile, prop, owner } = attackTarget(room, actorId, a.tileId, { noLandmark: '교환' });
    const mine = tileOf(room, a.mineId, 'owned');
    if (mine.prop.owner !== p.id) throw new GameError('맞바꿀 내 도시를 골라 주세요.');
    noLandmark(mine.tile, mine.prop, '교환');
    const before = snapshot(room);
    prop.owner = p.id;
    mine.prop.owner = owner.id;
    record(room, actorId, 'card', `${p.name} 도시체인지: [${mine.tile.name}] ↔ ${owner.name}의 [${tile.name}]`, {}, before);
    autoWin(room, p.id, owner.id);
  },
  // 도시기부: 내 도시 하나를 원하는 상대에게 (랜드마크 도시도 가능)
  donate(room, actorId, a) {
    requirePlaying(room);
    const p = activePlayer(room, actorId);
    const { tile, prop } = tileOf(room, a.tileId, 'owned');
    if (prop.owner !== p.id) throw new GameError('내 도시를 골라 주세요.');
    const to = activePlayer(room, a.to);
    if (to.id === p.id) throw new GameError('받을 사람을 골라 주세요.');
    const before = snapshot(room);
    prop.owner = to.id;
    record(room, actorId, 'card', `${p.name} 도시기부: [${tile.name}] → ${to.name}`, {}, before);
    autoWin(room, to.id);
  },

  // 파산: 땅과 건물은 모두 치우고, 남은 현금은 빚진 사람(없으면 은행)에게
  bankrupt(room, actorId, a) {
    requirePlaying(room);
    const target = a.playerId && a.playerId !== actorId ? (requireHost(room, actorId), a.playerId) : actorId;
    const p = activePlayer(room, target);
    const before = snapshot(room);
    const deltas = { [p.id]: -p.money };
    let text = `${p.name} 파산`;
    if (a.to) {
      const to = activePlayer(room, a.to);
      if (to.id === p.id) throw new GameError('잘못된 대상입니다.');
      deltas[to.id] = p.money;
      text += ` — 남은 ${fmt(p.money)}은(는) ${to.name}에게`;
    }
    for (const id of Object.keys(room.props)) if (room.props[id].owner === p.id) removeProp(room, id);
    p.bankrupt = true;
    record(room, actorId, 'bankrupt', text, deltas, before);
    lastSurvivor(room);
  },

  // 방장: 잔액 직접 수정
  adjust(room, actorId, a) {
    requireHost(room, actorId);
    requirePlaying(room);
    const p = getPlayer(room, a.playerId);
    const money = toInt(a.money, '잔액');
    if (money < 0) throw new GameError('잔액은 0 이상이어야 합니다.');
    if (money === p.money) return;
    const before = snapshot(room);
    record(room, actorId, 'adjust', `방장이 ${p.name} 잔액 수정 ${fmt(p.money)} → ${fmt(money)}`, { [p.id]: money - p.money }, before);
  },

  // 되돌리기: 가장 최근 거래를 되돌림 (본인 거래는 본인이, 방장은 누구 것이든)
  undo(room, actorId) {
    if (room.status === 'lobby') throw new GameError('되돌릴 거래가 없습니다.');
    const tx = lastUndoable(room);
    if (!tx) throw new GameError('되돌릴 거래가 없습니다.');
    if (tx.actorId !== actorId && room.hostId !== actorId) throw new GameError(`가장 최근 거래는 ${pname(room, tx.actorId)}님 것이에요. 본인이나 방장만 되돌릴 수 있어요.`);
    const pos = Object.fromEntries(room.players.map((p) => [p.id, p.pos])); // 말 위치는 그대로 둠
    Object.assign(room, JSON.parse(JSON.stringify(tx.before)));
    for (const p of room.players) if (pos[p.id] !== undefined) p.pos = pos[p.id];
    tx.undone = true;
    delete tx.before;
    record(room, actorId, 'undo', `${pname(room, actorId)} 되돌리기: ${tx.text}`, {});
  },

  // 방장: 게임 종료 (승리독점 직접 선언, 또는 시간 종료 → 마블이 가장 많은 사람)
  end(room, actorId, a) {
    requireHost(room, actorId);
    requirePlaying(room);
    if (a.reason === 'time') {
      const rich = room.players.filter((p) => !p.bankrupt).sort((x, y) => y.money - x.money)[0];
      room.result = { winnerId: rich.id, reason: '시간 종료 — 보유 마블 1등', at: Date.now() };
    } else {
      const w = activePlayer(room, a.winnerId);
      const reasons = { triple: '트리플 독점', line: '라인 독점', tour: '관광지 독점' };
      room.result = { winnerId: w.id, reason: reasons[a.reason] || '게임 종료', at: Date.now() };
    }
    room.status = 'ended';
  },

  reset(room, actorId) {
    requireHost(room, actorId);
    Object.assign(room, { status: 'lobby', result: null, log: [], props: {}, effects: {}, olympic: null, festival: [] });
    for (const p of room.players) Object.assign(p, { money: 0, laps: 0, bankrupt: false });
  },
};

function pname(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '?';
}

function lastUndoable(room) {
  for (let i = room.log.length - 1; i >= 0; i--) {
    const t = room.log[i];
    if (t.kind === 'undo' || t.undone) continue;
    return t.before || t.canUndo ? t : null;
  }
  return null;
}

function attackTarget(room, actorId, tileId, opt) {
  requirePlaying(room);
  const p = activePlayer(room, actorId);
  const { tile, prop } = tileOf(room, tileId, 'owned');
  if (prop.owner === p.id) throw new GameError('상대방의 도시를 골라 주세요.');
  if (opt.city && tile.kind !== 'city') throw new GameError('일반도시를 골라 주세요.');
  if (opt.noLandmark) noLandmark(tile, prop, opt.noLandmark);
  return { p, tile, prop, owner: getPlayer(room, prop.owner) };
}

const TILE_ACTIONS = ['buy', 'build', 'arrive', 'toll', 'takeover'];
function whereAt(a) {
  if (TILE_ACTIONS.includes(a.type) && TILE[a.tileId]) return TILE[a.tileId].pos;
  if (a.type === 'pay') return POS[{ bail: 'island', tax: 'tax', travel: 'travel' }[a.what]];
  if (a.type === 'bonus') return POS.bonus;
  if (Number.isInteger(a.at) && a.at >= 0 && a.at < SPACES.length) return a.at;
  return null;
}

function applyAction(room, actorId, action) {
  if (!action || typeof action.type !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action.type)) {
    throw new GameError('알 수 없는 동작입니다.');
  }
  const me = getPlayer(room, actorId);
  actions[action.type](room, actorId, action);
  // 칸에서 한 거래면 내 말을 그 칸으로 옮김
  const at = whereAt(action);
  if (at !== null && room.status !== 'lobby') me.pos = at;
  room.updatedAt = Date.now();
}

// 다른 기기에 보낼 상태 (되돌리기용 스냅샷은 빼고)
function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: room.players.map(({ id, name, color, money, laps, pos, bankrupt }) => ({ id, name, color, money, laps, pos: pos || 0, bankrupt })),
    props: room.props,
    olympic: room.olympic,
    festival: room.festival,
    effects: room.effects,
    log: room.log.slice(-80).map(({ before, ...t }) => (before ? { ...t, canUndo: true } : t)),
    nextTxId: room.nextTxId,
    result: room.result,
  };
}

// 공개 상태로 결과를 미리 계산할 방 (버튼을 누르자마자 내 화면에 먼저 반영하는 용도)
function roomFromPublic(state) {
  return JSON.parse(JSON.stringify(state));
}

const api = {
  MAN, START_MONEY, SALARY, BAIL, TAX, TRAVEL, OLYMPIC_COST, SPONSOR, BONUS, TOUR_PRICE, TOUR_TOLL, TOUR_SELL,
  MAX_PLAYERS, MAX_OLYMPIC, BOARD, TILE, SPACES, POS, PIECES, GROUPS, LINE_NAMES, BUILDINGS, ITEM_NAMES, TOUR_LEVELS,
  GameError, createRoom, addPlayer, findByName, applyAction, publicState, roomFromPublic,
  fmt, tollInfo, takeoverPrice, sellPrice, tourLevel, hasMonopoly, canBuild, maxBuilding, builtItems, lastUndoable,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.MarbleGame = api;
})(typeof self !== 'undefined' ? self : this);
