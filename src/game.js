'use strict';

// 모두의 마블(보드게임) 돈 계산 규칙.
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
  return s;
}

function createRoom(code, hostName, hostId, settings) {
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
  if (n < MAN) return `${sign}${n.toLocaleString('ko-KR')}`;
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
    p.bankrupt = true;
    record(room, actorId, 'bankrupt', text, deltas, { bankruptIds: [p.id] });
    checkLastSurvivor(room);
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
    const tx = room.log.find((t) => t.id === Number(a.txId));
    if (!tx) throw new GameError('거래를 찾을 수 없습니다.');
    if (tx.undone) throw new GameError('이미 취소된 거래입니다.');
    if (tx.noUndo || tx.kind === 'undo') throw new GameError('이 기록은 되돌릴 수 없습니다.');
    if (tx.actorId !== actorId && room.hostId !== actorId) throw new GameError('본인 거래만 되돌릴 수 있습니다. (방장은 모두 가능)');
    const inverse = {};
    for (const [pid, d] of Object.entries(tx.deltas)) inverse[pid] = -d;
    for (const pid of tx.bankruptIds || []) getPlayer(room, pid).bankrupt = false;
    if (tx.bankruptIds && room.status === 'ended' && room.result && room.result.reason === '나머지 플레이어 모두 파산') {
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
  };
}

module.exports = {
  MAN,
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  GameError,
  createRoom,
  addPlayer,
  applyAction,
  publicState,
  sanitizeSettings,
  fmt,
};
