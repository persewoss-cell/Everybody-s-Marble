'use strict';

// 컴퓨터 플레이어 (앱으로만 하는 방). 방장 기기가 컴퓨터 차례에 next()가 고른 동작을 대신 보냄
// 사람처럼 이기려고 고름:
//  - 앞으로 걸릴 수 있는 통행료를 보고 비상금을 남기고, 그보다 많을 때만 사고 지음 (돈이 모이면 다시 삼)
//  - 바로 이기는 수(독점 완성)는 돈이 빠듯해도 둠. 내 독점에 가까워지거나 상대 독점을 막는 땅은 조금 무리해서라도
//  - 짓기는 독점·축제·올림픽 도시처럼 통행료가 잘 나오는 곳부터, 통행료/비용이 좋은 건물부터
//  - 돈이 모자라면 덜 중요한 도시부터 팔고, 다 팔아도 안 되면 바로 파산
//  - 공격 카드는 1등이나 승리에 가까운 사람을, 도시체인지·도시기부는 상대에게 독점을 만들어 주지 않게
(function (root) {
const G = typeof module !== 'undefined' && module.exports ? require('./game.js') : root.MarbleGame;
const MAN = G.MAN;
// 비상금 계산 기준 (컴퓨터끼리 수백 판을 두어 맞춘 값)
// (예전 컴퓨터와 800판씩 두어 이 값이 약 59% 승률로 가장 좋았음: 땅은 적극적으로, 건물은 비상금을 남기며)
const CFG = { base: 10, near: 0.3, board: 0.2, expect: 1, land: 0.3, build: 0.4, take: 1.2, floorLand: 10, floorBuild: 20, rich: 60, richK: 1.5 };
const done = new Set(); // 이번 도착에서 이미 생각해 본 일 (같은 칸에서 되풀이하지 않게)

const d6 = () => 1 + Math.floor(Math.random() * 6);
const act = (action, wait) => ({ action, wait: wait || 1600 });
const DICE_P = (s) => (6 - Math.abs(s - 7)) / 36; // 두 주사위 합이 s일 확률
const CITIES = G.BOARD.filter((t) => t.kind === 'city');
const TOURS = G.BOARD.filter((t) => t.kind === 'tour');
const GROUP_IDS = [...new Set(CITIES.map((t) => t.group))];
const LINE_IDS = [...new Set(G.BOARD.map((t) => t.line))];

function landId(st) {
  for (let i = st.log.length - 1; i >= 0; i--) {
    if (['roll', 'fortune', 'move', 'turn'].includes(st.log[i].kind)) return st.log[i].id;
  }
  return 0;
}
function once(key) {
  if (done.has(key)) return false;
  done.add(key);
  if (done.size > 500) done.delete(done.values().next().value);
  return true;
}

const ownerOf = (st, id) => (st.props[id] ? st.props[id].owner : null);
const isLandmark = (st, t) => !!(st.props[t.id] && st.props[t.id].built && st.props[t.id].built.landmark);
const toll = (st, t) => G.tollInfo(st, t.id).amount;
const opponents = (st, pid) => st.players.filter((x) => x.id !== pid && !x.bankrupt);
// 올림픽을 열 수 있는 내 도시 (같은 도시에 최대 4번)
const olympicOk = (st, t) => !(st.olympic && st.olympic.tileId === t.id && st.olympic.count >= G.MAX_OLYMPIC);
const owned = (st, pid, pred) => G.BOARD.filter((t) => ownerOf(st, t.id) === pid && (!pred || pred(t)));

// ---- 승리까지 남은 도시 수 ----
// 가정: give는 pid가 갖게 될 도시, take는 pid가 잃을 도시
function winDistance(st, pid, give, take) {
  const has = (t) => (give && give.includes(t.id)) || (ownerOf(st, t.id) === pid && !(take && take.includes(t.id)));
  // 상대 랜드마크 도시는 가져올 수 없음 (관광지는 도시체인지로만, 그래도 가능한 것으로 셈)
  const blocked = (t) => !has(t) && isLandmark(st, t);
  let best = Infinity;
  // 트리플 독점: 남은 수가 적은 색 3개
  const need = GROUP_IDS.map((g) => {
    const list = CITIES.filter((t) => t.group === g);
    return list.some(blocked) ? Infinity : list.filter((t) => !has(t)).length;
  }).sort((a, b) => a - b);
  best = Math.min(best, need[0] + need[1] + need[2]);
  for (const l of LINE_IDS) {
    const list = G.BOARD.filter((t) => t.line === l);
    if (!list.some(blocked)) best = Math.min(best, list.filter((t) => !has(t)).length);
  }
  best = Math.min(best, TOURS.filter((t) => !has(t)).length);
  return best;
}
// 이 도시를 가지면 이김?
const winsWith = (st, pid, t) => winDistance(st, pid, [t.id]) === 0;
// 이 도시가 승리에 가까운 상대(남은 수 2 이하)에게 꼭 필요한지 → 막을 가치
function blockValue(st, pid, t) {
  let v = 0;
  for (const o of opponents(st, pid)) {
    if (ownerOf(st, t.id) === o.id) continue;
    const now = winDistance(st, o.id);
    const after = winDistance(st, o.id, [t.id]);
    if (after < now && now <= 2) v = Math.max(v, now === 1 ? 3 : 1.5);
  }
  return v;
}
// 이 도시를 가지면 내 승리에 얼마나 가까워지는지 (0~)
function progressValue(st, pid, t) {
  const now = winDistance(st, pid);
  const after = winDistance(st, pid, [t.id]);
  if (after === 0) return 10;
  if (after < now) return after <= 1 ? 3 : after <= 3 ? 1.5 : 0.6;
  // 같은 색을 이미 가지고 있으면 조금 (컬러독점 통행료 2배)
  if (t.kind === 'city' && CITIES.some((x) => x.group === t.group && x.id !== t.id && ownerOf(st, x.id) === pid)) return 0.4;
  return 0;
}

// ---- 비상금: 다음 주사위로 걸릴 수 있는 통행료 + 게임판 전체의 비싼 통행료 ----
function danger(st, p) {
  let near = 0;
  let expect = 0;
  for (let s = 2; s <= 12; s++) {
    const sp = G.SPACES[((p.pos || 0) + s) % G.SPACES.length];
    let cost = 0;
    if (sp.kind !== 'special') {
      const o = ownerOf(st, sp.id);
      if (o && o !== p.id) cost = toll(st, sp);
    } else if (sp.key === 'tax') cost = G.TAX;
    near = Math.max(near, cost);
    expect += DICE_P(s) * cost;
  }
  let board = 0;
  for (const t of G.BOARD) if (ownerOf(st, t.id) && ownerOf(st, t.id) !== p.id) board = Math.max(board, toll(st, t));
  return { near, expect, board };
}
function reserveOf(st, p) {
  const d = danger(st, p);
  return Math.max(CFG.base * MAN, d.near * CFG.near, d.board * CFG.board, d.expect * CFG.expect);
}

// ---- 건물 고르기: 턴 제한 안에서, 예산 안에서, 통행료/비용이 좋은 것부터 ----
function buildPlan(st, p, t, budget, buying) {
  if (t.kind !== 'city' || budget <= 0) return { items: [], cost: 0 };
  const pr = st.props[t.id];
  const built = { ...((pr && pr.built) || {}) };
  const opts = ['villa', 'building', 'hotel'].filter((k) => !built[k] && G.canBuild(p, k))
    .sort((a, b) => t.toll[b] / t.cost[b] - t.toll[a] / t.cost[a]);
  const items = [];
  let cost = 0;
  for (const k of opts) {
    if (cost + t.cost[k] > budget) continue;
    items.push(k);
    cost += t.cost[k];
    built[k] = true;
  }
  if (built.villa && built.building && built.hotel && !built.landmark && G.canBuild(p, 'landmark') && cost + t.cost.landmark <= budget) {
    items.push('landmark');
    cost += t.cost.landmark;
  }
  return { items, cost };
}
// 지을 가치: 통행료 배수가 높은 도시(독점·축제·올림픽)일수록
function buildWorth(st, pid, t) {
  let m = 1;
  if (G.hasMonopoly(st, pid, t.group)) m *= 2;
  if (st.festival.includes(t.id)) m *= 2;
  if (st.olympic && st.olympic.tileId === t.id) m *= st.olympic.count + 1;
  return m;
}
// 예산을 얼마나 쓸지: 통행료가 잘 나오는 도시는 비상금을 조금 덜 남김
function buildBudget(st, p, t, reserve) {
  const m = buildWorth(st, p.id, t);
  // 아무리 좋아도 건물을 짓고 나서 최소한의 돈(floorBuild)은 남김
  return Math.min(p.money - reserve * CFG.build * (m >= 2 ? 0.7 : 1), p.money - CFG.floorBuild * MAN);
}

// ---- 돈이 모자랄 때: 덜 중요한 도시부터 매각 ----
function keepValue(st, pid, t) {
  // 지금 통행료 + 승리·독점에 얼마나 중요한지
  let v = toll(st, t);
  const lose = winDistance(st, pid, null, [t.id]) - winDistance(st, pid);
  v += lose * 20 * MAN;
  if (t.kind === 'city' && G.hasMonopoly(st, pid, t.group)) v += 30 * MAN;
  return v;
}
function raise(st, p, need, creditor) {
  const mine = owned(st, p.id);
  const total = p.money + mine.reduce((s, t) => s + G.sellPrice(st, t.id), 0);
  if (!mine.length || total < need) return act({ type: 'bankrupt', to: creditor || undefined }); // 다 팔아도 안 되면 바로
  // 모자란 만큼을 채우는 도시 중 가장 덜 중요한 것 (하나로 안 되면 덜 중요한 것부터)
  const short = need - p.money;
  const enough = mine.filter((t) => G.sellPrice(st, t.id) >= short);
  const pool = enough.length ? enough : mine;
  pool.sort((a, b) => (keepValue(st, p.id, a) - G.sellPrice(st, a.id) * 0.3) - (keepValue(st, p.id, b) - G.sellPrice(st, b.id) * 0.3));
  return act({ type: 'sell', tileId: pool[0].id });
}

// 1등(돈+땅) 또는 승리에 가장 가까운 상대
function leaderScore(st, o) {
  const assets = o.money + G.assetValue(st, o.id);
  return assets / MAN + (6 - Math.min(6, winDistance(st, o.id))) * 40;
}

// ---- 뽑은 카드 쓰기 ----
function useCard(st, p, reserve) {
  const pass = act({ type: 'passCard' });
  const key = p.use;
  const oppTiles = (pred) => G.BOARD.filter((t) => ownerOf(st, t.id) && ownerOf(st, t.id) !== p.id && pred(t));
  const ownerOfT = (t) => st.players.find((x) => x.id === ownerOf(st, t.id));
  const pick = (list, score) => list.map((t) => [t, score(t)]).sort((a, b) => b[1] - a[1])[0];
  const targetWeight = (t) => 1 + leaderScore(st, ownerOfT(t)) / 400 + blockValue(st, p.id, t);

  if (key === 'olympicHost') {
    const cities = owned(st, p.id, (t) => t.kind === 'city' && olympicOk(st, t));
    if (!cities.length || p.money - G.OLYMPIC_COST < reserve * 0.6) return pass;
    return act({ type: 'olympic', tileId: pick(cities, (t) => toll(st, t) * buildWorth(st, p.id, t))[0].id });
  }
  if (key === 'donate') {
    const mine = owned(st, p.id, (t) => !isLandmark(st, t));
    if (!mine.length) return pass;
    // 받는 사람이 그 도시로 이기거나 독점에 가까워지지 않게, 가장 약한 상대에게 가장 덜 중요한 도시
    let best = null;
    for (const o of opponents(st, p.id)) {
      for (const t of mine) {
        const harm = keepValue(st, p.id, t) + progressValue(st, o.id, t) * 30 * MAN + leaderScore(st, o) * MAN / 10
          + (winsWith(st, o.id, t) ? 1e9 : 0); // 받는 사람이 이기게 되는 기부는 마지막 수단
        if (!best || harm < best.harm) best = { t, o, harm };
      }
    }
    return act({ type: 'donate', tileId: best.t.id, to: best.o.id });
  }
  if (key === 'swap') {
    const theirs = oppTiles((t) => !isLandmark(st, t));
    const mine = owned(st, p.id, (t) => !isLandmark(st, t));
    if (!theirs.length || !mine.length) return pass;
    let best = null;
    for (const a of theirs) {
      for (const b of mine) {
        const o = ownerOf(st, a.id);
        // 바꾸면 내가 이기면 바로
        if (winDistance(st, p.id, [a.id], [b.id]) === 0) return act({ type: 'swap', tileId: a.id, mineId: b.id });
        // 상대가 내 도시로 이기거나 가까워지면 안 됨
        if (winDistance(st, o, [b.id], [a.id]) <= 1) continue;
        const gain = (toll(st, a) - toll(st, b)) / MAN + (progressValue(st, p.id, a) - progressValue(st, o, b)) * 25
          + blockValue(st, p.id, a) * 20 - (keepValue(st, p.id, b) - toll(st, b)) / MAN;
        if (!best || gain > best.gain) best = { a, b, gain };
      }
    }
    if (!best || best.gain <= 0) return pass;
    return act({ type: 'swap', tileId: best.a.id, mineId: best.b.id });
  }
  const hasBuilding = (t) => { const b = st.props[t.id].built || {}; return b.villa || b.building || b.hotel; };
  const filters = {
    epidemic: (t) => t.kind === 'city',
    alien: (t) => t.kind === 'city' && !isLandmark(st, t) && hasBuilding(t),
    quake: (t) => t.kind === 'city' && !isLandmark(st, t) && hasBuilding(t),
    forceSell: (t) => !isLandmark(st, t),
    blackout: () => true,
    dust: () => true,
  };
  if (!filters[key]) return pass;
  const list = oppTiles(filters[key]);
  if (!list.length) return pass;
  // 통행료 효과 카드는 내가 곧 밟을 수 있는 칸을 더 쳐줌
  const soon = (t) => {
    const s = (t.pos - (p.pos || 0) + G.SPACES.length) % G.SPACES.length;
    return s >= 2 && s <= 12 ? 1 + DICE_P(s) * 6 : 1;
  };
  const score = {
    epidemic: (t) => CITIES.filter((x) => x.group === t.group && ownerOf(st, x.id) && ownerOf(st, x.id) !== p.id).reduce((s, x) => s + toll(st, x), 0) * targetWeight(t),
    alien: (t) => CITIES.filter((x) => x.group === t.group && ownerOf(st, x.id) && ownerOf(st, x.id) !== p.id).reduce((s, x) => s + toll(st, x), 0) * targetWeight(t),
    quake: (t) => toll(st, t) * targetWeight(t),
    forceSell: (t) => (toll(st, t) + 10 * MAN) * targetWeight(t) * (1 + blockValue(st, p.id, t)),
    blackout: (t) => toll(st, t) * soon(t) * targetWeight(t),
    dust: (t) => toll(st, t) * soon(t) * targetWeight(t),
  }[key];
  return act({ type: key, tileId: pick(list, score)[0].id });
}

// ---- 세계여행: 갈 만한 도시 ----
function travelTarget(st, p, reserve) {
  let best = null;
  for (const t of G.BOARD) {
    const o = ownerOf(st, t.id);
    let s = 0;
    const left = p.money - G.TRAVEL;
    if (!o) {
      const price = t.kind === 'tour' ? G.TOUR_PRICE : t.cost.land;
      if (winsWith(st, p.id, t) && left >= price) s = 1000;
      else if (left - price >= reserve * 0.6) s = 10 + (progressValue(st, p.id, t) + blockValue(st, p.id, t)) * 10 + price / MAN / 5;
    } else if (o === p.id && t.kind === 'city') {
      const plan = buildPlan(st, p, t, left - reserve);
      if (plan.items.length) s = 5 + plan.cost / MAN / 5 * buildWorth(st, p.id, t);
    }
    if (s > 0 && (!best || s > best.s)) best = { t, s };
  }
  return best && best.t;
}

function next(st, pid) {
  const p = st.players.find((x) => x.id === pid);
  if (!p || !p.bot || p.bankrupt || st.status !== 'playing' || (st.mode !== 'app' && !st.withBots)) return null;
  if (st.phase === 'order') return st.orderRolls[pid] === null ? act({ type: 'orderRoll', dice: [d6(), d6()] }, 3200) : null;
  const t = st.turn;
  if (!t || t.pid !== pid) return null;
  if (t.awaitBlock) return null; // 공격받은 사람이 방패를 쓸지 고르는 중
  const key = `${st.code}:${pid}:${landId(st)}`;
  const reserve = reserveOf(st, p);

  // 보관 카드가 2장이면 지금 더 쓸모 있는 것
  if (p.pendingCard) {
    const rank = (k) => (p.jail > 0 && k === 'escape' ? -1 : ['angel', 'shield', 'coupon', 'booster', 'escape'].indexOf(k));
    return act({ type: 'keepCard', keep: rank(p.pendingCard) < rank(p.card) ? 'new' : 'old' });
  }

  // 꼭 해야 하는 일
  if (t.owe === 'toll') {
    const tile = G.SPACES[t.spot];
    const owner = ownerOf(st, tile.id);
    const base = toll(st, tile);
    const opts = {};
    // 천사·할인쿠폰: 큰 통행료나 돈이 모자랄 때 씀 (작은 통행료엔 아껴 둠)
    const big = base >= 15 * MAN || base > p.money * 0.3 || base > p.money;
    if (p.card === 'angel' && big) opts.angel = true;
    else if (p.card === 'coupon' && (big || base >= 8 * MAN)) opts.coupon = true;
    const amount = G.tollInfo(st, tile.id, opts).amount;
    if (p.money < amount) return raise(st, p, amount, owner);
    return act({ type: 'toll', tileId: tile.id, ...opts });
  }
  if (t.owe === 'tax') {
    if (p.money < G.TAX) return raise(st, p, G.TAX, null);
    return act({ type: 'pay', what: 'tax' });
  }
  // 앱 + 실물 방에 사람이 있으면, 사람이 랜덤으로 뽑을지 실물 카드를 뽑아 알려 줄지 고를 때까지 기다림
  if (t.mustDraw && st.mode !== 'app' && st.players.some((x) => !x.bot && !x.bankrupt)) return null;
  if (t.mustDraw) return act({ type: 'draw', pick: Math.random() }, 4600);
  if (p.use) return useCard(st, p, reserve);

  // 도착한 칸에서 할 수 있는 일
  const at = t.spot !== undefined && t.spot !== null && (p.pos || 0) === t.spot ? G.SPACES[t.spot] : null;
  const did = t.did || {};
  if (at && at.kind !== 'special') {
    const pr = st.props[at.id];
    if (!pr && once(key + ':buy')) {
      const price = at.kind === 'tour' ? G.TOUR_PRICE : at.cost.land;
      const win = winsWith(st, pid, at);
      const value = progressValue(st, pid, at) + blockValue(st, pid, at);
      // 이기면 무조건, 중요한 땅이면 비상금을 덜 남겨도, 그 밖엔 비상금을 남길 수 있을 때만
      const need = win ? 0 : Math.max(CFG.floorLand * MAN, (value >= 3 ? reserve * 0.3 : value >= 1 ? reserve * 0.6 : reserve) * CFG.land);
      if (p.money - price >= need) {
        const items = buildPlan(st, p, at, buildBudget(st, p, at, reserve) - price, true).items;
        return act({ type: 'buy', tileId: at.id, items });
      }
    } else if (pr && pr.owner === pid) {
      if ((at.tour === 'beach' || st.effects[at.id]) && !did.arrive) return act({ type: 'arrive', tileId: at.id });
      if (at.kind === 'city' && once(key + ':build')) {
        const plan = buildPlan(st, p, at, buildBudget(st, p, at, reserve));
        if (plan.items.length) return act({ type: 'build', tileId: at.id, items: plan.items });
      }
    } else if (pr && t.paid === at.id && at.kind === 'city' && !isLandmark(st, at) && once(key + ':take')) {
      // 인수: 이기면 무조건, 내 독점·상대 막기면 조금 무리해서, 그 밖엔 돈이 넉넉하고 통행료가 쏠쏠할 때만
      const price = G.takeoverPrice(st, at.id);
      const owner = st.players.find((x) => x.id === pr.owner);
      const win = winsWith(st, pid, at);
      const value = progressValue(st, pid, at) + blockValue(st, pid, at) + (owner && G.hasMonopoly(st, owner.id, at.group) ? 1.5 : 0);
      const need = win ? 0 : value >= 3 ? reserve * 0.5 : value >= 1 ? reserve : reserve * CFG.take;
      // 돈이 넉넉하면(인수하고도 비상금의 몇 배가 남으면) 통행료가 작아도 인수 — 땅이 늘면 통행료·독점 기회가 늘고 상대 땅은 줄어듦
      const rich = p.money - price >= Math.max(reserve * CFG.richK, CFG.rich * MAN);
      const worth = win || value >= 1 || toll(st, at) >= price * 0.25 || rich;
      if (worth && p.money - price >= need) return act({ type: 'takeover', tileId: at.id });
    }
  }
  if (at && at.key === 'start' && !did.startBuild && once(key + ':start')) {
    // 출발지 도착: 내 도시 중 지으면 가장 좋은 곳 한 곳에
    let best = null;
    for (const c of owned(st, pid, (x) => x.kind === 'city')) {
      const plan = buildPlan(st, p, c, buildBudget(st, p, c, reserve));
      const s = plan.items.reduce((sum, k) => sum + c.toll[k], 0) * buildWorth(st, pid, c);
      if (plan.items.length && (!best || s > best.s)) best = { c, plan, s };
    }
    if (best) return act({ type: 'build', tileId: best.c.id, items: best.plan.items });
  }
  if (at && at.key === 'olympic' && !did.olympic && once(key + ':olympic')) {
    const cities = owned(st, pid, (x) => x.kind === 'city' && olympicOk(st, x));
    if (cities.length && p.money - G.OLYMPIC_COST >= reserve) {
      const best = cities.sort((a, b) => toll(st, b) * buildWorth(st, pid, b) - toll(st, a) * buildWorth(st, pid, a))[0];
      if (toll(st, best) >= 5 * MAN) return act({ type: 'olympic', tileId: best.id });
    }
  }
  if (at && at.key === 'bonus' && !did.bonus) {
    // 코인 앞뒤 맞히기: 돈이 급하면 1번 성공에서, 아니면 2번 성공에서 멈춤
    const stopAt = p.money < reserve ? 1 : 2;
    let wins = 0;
    for (let i = 0; i < stopAt; i++) {
      if (Math.random() < 0.5) wins++;
      else { wins = 0; break; }
    }
    return act({ type: 'bonus', wins }, 2200);
  }

  // 세계여행: 갈 만한 도시가 있으면 가고, 없으면 주사위
  if (G.canTravelNow(st, p) && once(key + ':travel')) {
    const target = travelTarget(st, p, reserve);
    if (target) return act({ type: 'travelTo', to: target.pos }, 2600);
  }
  // 무인도: 탈출 카드 → 빈 땅이 많고 돈이 넉넉하면 보석금 → 아니면 쉬면서 더블 노리기 (늦게는 무인도가 안전)
  if (p.jail > 0 && !t.rolled) {
    if (p.card === 'escape') return act({ type: 'useEscape' });
    const free = G.BOARD.filter((x) => !ownerOf(st, x.id)).length;
    if (free >= 8 && p.money - G.BAIL >= reserve + 20 * MAN && once(key + ':bail')) return act({ type: 'pay', what: 'bail' });
  }
  if (!t.rolled || t.again) {
    const dice = [d6(), d6()];
    return act({ type: 'roll', dice }, 3700 + (dice[0] + dice[1]) * 240);
  }
  return act({ type: 'endTurn' }, 1200);
}

const api = { next, reserveOf, winDistance, CFG };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.MarbleBot = api;
})(typeof self !== 'undefined' ? self : this);
