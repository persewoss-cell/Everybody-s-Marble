'use strict';

// 컴퓨터 플레이어 (앱으로만 하는 방). 방장 기기가 컴퓨터 차례에 next()가 고른 동작을 대신 보냄
// 지금 상태에서 규칙상 할 수 있는 일 중 하나를 고름. 한 번에 한 동작씩, 사람이 보기 편하게 사이에 쉬는 시간(wait)
(function (root) {
const G = typeof module !== 'undefined' && module.exports ? require('./game.js') : root.MarbleGame;
const RESERVE = 30 * G.MAN; // 통행료에 대비해 남겨 두는 돈
const KEEP_RANK = ['shield', 'angel', 'escape', 'coupon', 'booster'];
const done = new Set(); // 이번 도착에서 이미 생각해 본 일 (같은 칸에서 되풀이하지 않게)

const d6 = () => 1 + Math.floor(Math.random() * 6);
const act = (action, wait) => ({ action, wait: wait || 1600 });

// 이번 도착을 구분하는 값: 마지막 이동(주사위·포춘카드·말 옮기기) 기록
function landId(st) {
  for (let i = st.log.length - 1; i >= 0; i--) {
    const tx = st.log[i];
    if (['roll', 'fortune', 'move', 'turn'].includes(tx.kind)) return tx.id;
  }
  return 0;
}
function once(key) {
  if (done.has(key)) return false;
  done.add(key);
  if (done.size > 500) done.delete(done.values().next().value);
  return true;
}

function owned(st, pid, pred) {
  return G.BOARD.filter((t) => st.props[t.id] && st.props[t.id].owner === pid && (!pred || pred(t)));
}
const landmark = (st, t) => !!(st.props[t.id] && st.props[t.id].built && st.props[t.id].built.landmark);
const toll = (st, t) => G.tollInfo(st, t.id).amount;

// 돈이 허락하는 만큼 지을 건물 (싼 것부터 차례대로, 턴 제한 안에서)
function buildPlan(st, p, t, budget) {
  const pr = st.props[t.id];
  const built = (pr && pr.built) || {};
  const items = [];
  let cost = 0;
  for (const k of ['villa', 'building', 'hotel']) {
    if (built[k] || !G.canBuild(p, k)) continue;
    if (cost + t.cost[k] > budget) break;
    items.push(k);
    cost += t.cost[k];
  }
  if (pr && built.villa && built.building && built.hotel && !built.landmark && G.canBuild(p, 'landmark') && t.cost.landmark <= budget) {
    items.push('landmark');
    cost += t.cost.landmark;
  }
  return { items, cost };
}

// 돈이 모자라면: 매각비용이 가장 싼 도시부터 팔고, 팔 게 없으면 파산
function raise(st, p, creditor) {
  const mine = owned(st, p.id).sort((a, b) => G.sellPrice(st, a.id) - G.sellPrice(st, b.id));
  if (mine.length) return act({ type: 'sell', tileId: mine[0].id });
  return act({ type: 'bankrupt', to: creditor || undefined });
}

// 뽑은 공격·명령 카드 쓰기
function useCard(st, p) {
  const opp = (pred) => G.BOARD.filter((t) => st.props[t.id] && st.props[t.id].owner !== p.id && pred(t));
  const best = (list, score) => list.sort((a, b) => score(b) - score(a))[0];
  const pass = act({ type: 'passCard' });
  const key = p.use;
  if (key === 'olympicHost') {
    const cities = owned(st, p.id, (t) => t.kind === 'city');
    if (!cities.length || p.money < G.OLYMPIC_COST) return pass;
    return act({ type: 'olympic', tileId: best(cities, (t) => toll(st, t)).id });
  }
  if (key === 'donate') {
    const mine = owned(st, p.id, (t) => !landmark(st, t));
    const to = st.players.filter((x) => x.id !== p.id && !x.bankrupt).sort((a, b) => a.money - b.money)[0];
    if (!mine.length || !to) return pass;
    return act({ type: 'donate', tileId: best(mine, (t) => -G.sellPrice(st, t.id)).id, to: to.id });
  }
  if (key === 'swap') {
    const theirs = opp((t) => !landmark(st, t));
    const mine = owned(st, p.id, (t) => !landmark(st, t));
    if (!theirs.length || !mine.length) return pass;
    const a = best(theirs, (t) => toll(st, t));
    const b = best(mine, (t) => -toll(st, t));
    if (toll(st, a) <= toll(st, b)) return pass;
    return act({ type: 'swap', tileId: a.id, mineId: b.id });
  }
  const hasBuilding = (t) => { const b = st.props[t.id].built || {}; return b.villa || b.building || b.hotel; };
  const filters = {
    epidemic: (t) => t.kind === 'city',
    alien: (t) => t.kind === 'city' && !landmark(st, t) && hasBuilding(t),
    quake: (t) => t.kind === 'city' && !landmark(st, t) && hasBuilding(t),
    forceSell: (t) => !landmark(st, t),
    blackout: () => true,
    dust: () => true,
  };
  if (!filters[key]) return pass;
  const list = opp(filters[key]);
  if (!list.length) return pass;
  return act({ type: key, tileId: best(list, (t) => toll(st, t)).id });
}

// 세계여행으로 갈 도시: 내 도시에 더 지을 수 있으면 그곳, 아니면 살 수 있는 가장 비싼 빈 도시
function travelTarget(st, p) {
  const budget = p.money - G.TRAVEL - RESERVE;
  if (budget < 0) return null;
  let pick = null;
  let score = 0;
  for (const t of G.BOARD) {
    const pr = st.props[t.id];
    let s = 0;
    if (!pr) {
      const price = t.kind === 'tour' ? G.TOUR_PRICE : t.cost.land;
      if (price <= budget) s = price + 1;
    } else if (pr.owner === p.id && t.kind === 'city') {
      s = buildPlan(st, p, t, budget).cost;
    }
    if (s > score) {
      score = s;
      pick = t;
    }
  }
  return pick;
}

function next(st, pid) {
  const p = st.players.find((x) => x.id === pid);
  if (!p || !p.bot || p.bankrupt || st.status !== 'playing' || st.mode !== 'app') return null;
  if (st.phase === 'order') return st.orderRolls[pid] === null ? act({ type: 'orderRoll', dice: [d6(), d6()] }, 4800) : null;
  const t = st.turn;
  if (!t || t.pid !== pid) return null;
  const key = `${st.code}:${pid}:${landId(st)}`;

  // 보관 카드가 2장이면 더 좋은 것만
  if (p.pendingCard) {
    const keepNew = KEEP_RANK.indexOf(p.pendingCard) < KEEP_RANK.indexOf(p.card);
    return act({ type: 'keepCard', keep: keepNew ? 'new' : 'old' });
  }

  // 꼭 해야 하는 일
  if (t.owe === 'toll') {
    const tile = G.SPACES[t.spot];
    const owner = st.props[tile.id].owner;
    const base = G.tollInfo(st, tile.id).amount;
    const opts = {};
    if (p.card === 'angel' && (base >= 30 * G.MAN || base > p.money)) opts.angel = true;
    else if (p.card === 'coupon' && base >= 10 * G.MAN) opts.coupon = true;
    const amount = G.tollInfo(st, tile.id, opts).amount;
    if (p.money < amount) return raise(st, p, owner);
    return act({ type: 'toll', tileId: tile.id, ...opts });
  }
  if (t.owe === 'tax') {
    if (p.money < G.TAX) return raise(st, p, null);
    return act({ type: 'pay', what: 'tax' });
  }
  if (t.mustDraw) return act({ type: 'draw', pick: Math.random() }, 4600);
  if (p.use) return useCard(st, p);

  // 도착한 칸에서 할 수 있는 일
  const at = t.spot !== undefined && t.spot !== null && (p.pos || 0) === t.spot ? G.SPACES[t.spot] : null;
  const did = t.did || {};
  if (at && at.kind !== 'special') {
    const pr = st.props[at.id];
    if (!pr && once(key + ':buy')) {
      const price = at.kind === 'tour' ? G.TOUR_PRICE : at.cost.land;
      if (p.money - price >= RESERVE) {
        const items = at.kind === 'city' ? buildPlan(st, p, at, p.money - price - RESERVE).items.filter((k) => k !== 'landmark') : [];
        return act({ type: 'buy', tileId: at.id, items });
      }
    } else if (pr && pr.owner === pid) {
      if ((at.tour === 'beach' || st.effects[at.id]) && !did.arrive) return act({ type: 'arrive', tileId: at.id });
      if (at.kind === 'city' && once(key + ':build')) {
        const plan = buildPlan(st, p, at, p.money - RESERVE);
        if (plan.items.length) return act({ type: 'build', tileId: at.id, items: plan.items });
      }
    } else if (pr && t.paid === at.id && at.kind === 'city' && !landmark(st, at) && once(key + ':take')) {
      if (p.money - G.takeoverPrice(st, at.id) >= RESERVE * 2) return act({ type: 'takeover', tileId: at.id });
    }
  }
  if (at && at.key === 'start' && !did.startBuild && once(key + ':start')) {
    // 출발지 도착: 내 도시 한 곳에 건설
    let pick = null;
    for (const c of owned(st, pid, (x) => x.kind === 'city')) {
      const plan = buildPlan(st, p, c, p.money - RESERVE);
      if (plan.items.length && (!pick || plan.cost > pick.plan.cost)) pick = { c, plan };
    }
    if (pick) return act({ type: 'build', tileId: pick.c.id, items: pick.plan.items });
  }
  if (at && at.key === 'olympic' && !did.olympic && once(key + ':olympic')) {
    const cities = owned(st, pid, (x) => x.kind === 'city');
    if (cities.length && p.money - G.OLYMPIC_COST >= RESERVE) {
      return act({ type: 'olympic', tileId: cities.sort((a, b) => toll(st, b) - toll(st, a))[0].id });
    }
  }
  if (at && at.key === 'bonus' && !did.bonus) {
    // 코인 앞뒤 맞히기: 두 번 성공하면 멈춤
    let wins = 0;
    for (let i = 0; i < 2; i++) {
      if (Math.random() < 0.5) wins++;
      else { wins = 0; break; }
    }
    return act({ type: 'bonus', wins }, 2200);
  }

  // 세계여행: 갈 만한 도시가 있으면 가고, 없으면 주사위
  if (G.canTravelNow(st, p) && once(key + ':travel')) {
    const target = travelTarget(st, p);
    if (target) return act({ type: 'travelTo', to: target.pos }, 2600);
  }
  // 무인도: 탈출 카드 → 돈이 넉넉하면 보석금 → 아니면 주사위로 더블 노리기
  if (p.jail > 0 && !t.rolled) {
    if (p.card === 'escape') return act({ type: 'useEscape' });
    if (p.money - G.BAIL >= 60 * G.MAN && once(key + ':bail')) return act({ type: 'pay', what: 'bail' });
  }
  if (!t.rolled || t.again) {
    const dice = [d6(), d6()];
    return act({ type: 'roll', dice }, 5600 + (dice[0] + dice[1]) * 240);
  }
  return act({ type: 'endTurn' }, 1200);
}

const api = { next, RESERVE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.MarbleBot = api;
})(typeof self !== 'undefined' ? self : this);
