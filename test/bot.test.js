'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../game.js');
const bot = require('../bot.js');

// 컴퓨터 4명만으로 게임을 끝까지: 규칙에 어긋난 동작(오류)이 없어야 함
function play(seedGames) {
  const stats = { ended: 0, errors: [], steps: 0, reasons: {} };
  for (let n = 0; n < seedGames; n++) {
    const room = g.createRoom('1', '선생님', 't', 'app', { play: false });
    for (let i = 0; i < 4; i++) g.applyAction(room, 't', { type: 'addBot' });
    g.applyAction(room, 't', { type: 'start' });
    let idle = 0;
    for (let step = 0; step < 4000 && room.status === 'playing'; step++) {
      const st = g.publicState(room);
      let moved = false;
      for (const p of st.players) {
        const s = bot.next(st, p.id);
        if (!s) continue;
        try {
          g.applyAction(room, p.id, s.action);
        } catch (e) {
          stats.errors.push(`${s.action.type}: ${e.message}`);
          g.applyAction(room, 't', { type: 'endTurn' }); // 방장이 넘김 (앱의 안전장치와 같음)
        }
        moved = true;
        stats.steps++;
        break;
      }
      idle = moved ? 0 : idle + 1;
      if (idle > 3) throw new Error('컴퓨터가 멈춤: ' + JSON.stringify(st.turn));
    }
    if (room.status === 'ended') {
      stats.ended++;
      stats.reasons[room.result.reason] = (stats.reasons[room.result.reason] || 0) + 1;
    }
  }
  return stats;
}

test('컴퓨터끼리 게임: 멈추지 않고, 규칙 오류 없이 진행', () => {
  const s = play(40);
  console.log(s.steps, 'steps', s.ended, 'ended', JSON.stringify(s.reasons), s.errors.slice(0, 5));
  assert.deepStrictEqual(s.errors, []);
  assert.ok(s.ended >= 30, `끝난 게임 ${s.ended}/40`);
});

test('컴퓨터 추가는 방장만, 시작하면 남은 색', () => {
  const room = g.createRoom('1', '엄마', 'a', 'app');
  g.addPlayer(room, '아빠', 'b');
  assert.throws(() => g.applyAction(room, 'b', { type: 'addBot' }), /방장/);
  g.applyAction(room, 'a', { type: 'addBot' });
  assert.strictEqual(room.players[2].name, '컴퓨터1');
  g.applyAction(room, 'a', { type: 'pickColor', color: g.PIECES[0].color });
  g.applyAction(room, 'b', { type: 'pickColor', color: g.PIECES[1].color });
  g.applyAction(room, 'a', { type: 'start' });
  assert.strictEqual(room.players[2].color, g.PIECES[2].color);
});

test('앱 + 실물 + 컴퓨터: 순서 정하기(실물 숫자 가능), 사람은 자기 차례에만 거래, 컴퓨터 공격은 실물 방패로 막기', () => {
  const room = g.createRoom('1', '엄마', 'a', 'mixed');
  g.addPlayer(room, '아빠', 'b');
  g.applyAction(room, 'a', { type: 'addBot' });
  g.applyAction(room, 'a', { type: 'pickColor', color: g.PIECES[0].color });
  g.applyAction(room, 'b', { type: 'pickColor', color: g.PIECES[1].color });
  g.applyAction(room, 'a', { type: 'start' });
  assert.strictEqual(room.withBots, true);
  assert.strictEqual(room.phase, 'order');
  const c = room.players[2];
  g.applyAction(room, 'a', { type: 'orderRoll', sum: 12 });
  g.applyAction(room, 'b', { type: 'orderRoll', dice: [1, 2] });
  g.applyAction(room, c.id, { type: 'orderRoll', dice: [3, 3] });
  assert.deepStrictEqual(room.order, ['a', c.id, 'b']);
  const id = (n) => g.BOARD.find((t) => t.name === n).id;
  // 엄마 차례: 실물로 자유롭게, 아빠는 기다림
  assert.throws(() => g.applyAction(room, 'b', { type: 'buy', tileId: id('도쿄') }), /엄마님 차례/);
  g.applyAction(room, 'a', { type: 'buy', tileId: id('도쿄'), items: ['villa'] });
  g.applyAction(room, 'a', { type: 'endTurn' }); // 굴리지 않아도 끝낼 수 있음
  assert.strictEqual(room.turn.pid, c.id);
  // 컴퓨터가 엄마 도쿄를 지진으로 공격 → 엄마가 막을지 고를 때까지 기다림
  c.use = 'quake';
  g.applyAction(room, c.id, { type: 'quake', tileId: id('도쿄') });
  assert.ok(!room.props[id('도쿄')].built.villa);
  assert.deepStrictEqual(room.turn.awaitBlock.victim, 'a');
  assert.strictEqual(bot.next(g.publicState(room), c.id), null);
  assert.throws(() => g.applyAction(room, 'b', { type: 'blockAttack', block: true }), /막을 공격/);
  g.applyAction(room, 'a', { type: 'blockAttack', block: true });
  assert.ok(room.props[id('도쿄')].built.villa);
  assert.ok(!room.turn.awaitBlock);
  assert.ok(bot.next(g.publicState(room), c.id));
});

// 컴퓨터 차례로 만들고 그 칸에 도착한 상태
function botAt(tileName, money) {
  const room = g.createRoom('1', '엄마', 'a', 'app');
  g.applyAction(room, 'a', { type: 'addBot' });
  g.applyAction(room, 'a', { type: 'pickColor', color: g.PIECES[0].color });
  g.applyAction(room, 'a', { type: 'start' });
  const b = room.players[1];
  const t = g.BOARD.find((x) => x.name === tileName);
  Object.assign(room, { phase: 'turns', order: ['a', b.id], festival: [] });
  room.turn = { pid: b.id, rolled: true, again: false, doubles: 0, spot: t.pos, did: {}, owe: null, paid: null };
  b.pos = t.pos;
  b.money = money;
  b.laps = 3;
  return { room, b, t };
}
const cityGroups = [...new Set(g.BOARD.filter((x) => x.kind === 'city').map((x) => x.group))];
const groupOf = (gr) => g.BOARD.filter((x) => x.kind === 'city' && x.group === gr);

test('컴퓨터: 인수하면 이기면 돈이 빠듯해도 인수, 의미 없는 인수는 돈이 빠듯하면 안 함', () => {
  const [g1, g2, g3] = cityGroups;
  const target = groupOf(g3)[0];
  const { room, b } = botAt(target.name, 0);
  for (const x of [...groupOf(g1), ...groupOf(g2), ...groupOf(g3).slice(1)]) room.props[x.id] = { owner: b.id, built: {}, visits: 0 };
  room.props[target.id] = { owner: 'a', built: { villa: true }, visits: 0 };
  room.turn.paid = target.id;
  const price = g.takeoverPrice(room, target.id);
  b.money = price + 1 * g.MAN; // 인수하면 1만 남음
  assert.strictEqual(bot.next(g.publicState(room), b.id).action.type, 'takeover');
  g.applyAction(room, b.id, { type: 'takeover', tileId: target.id });
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(room.result.reason, '트리플 독점');

  // 아무 의미 없는 도시 + 돈 빠듯 → 인수 안 함
  const lone = groupOf(g1)[0];
  const r2 = botAt(lone.name, 0);
  r2.room.props[lone.id] = { owner: 'a', built: { villa: true }, visits: 0 };
  r2.room.turn.paid = lone.id;
  r2.b.money = g.takeoverPrice(r2.room, lone.id) + 5 * g.MAN;
  assert.notStrictEqual(bot.next(g.publicState(r2.room), r2.b.id).action.type, 'takeover');
});

test('컴퓨터: 돈이 적으면 땅·건물을 사지 않고, 짓더라도 최소한의 돈은 남김', () => {
  const t = g.BOARD.find((x) => x.name === '서울');
  const poor = botAt('서울', t.cost.land + 3 * g.MAN);
  assert.notStrictEqual(bot.next(g.publicState(poor.room), poor.b.id).action.type, 'buy');
  const rich = botAt('서울', 200 * g.MAN);
  const s = bot.next(g.publicState(rich.room), rich.b.id);
  assert.strictEqual(s.action.type, 'buy');
  const cost = t.cost.land + s.action.items.reduce((sum, k) => sum + t.cost[k], 0);
  assert.ok(200 * g.MAN - cost >= 20 * g.MAN, `남은 돈 ${(200 * g.MAN - cost) / g.MAN}만`);
});

test('앱 + 실물 + 컴퓨터: 사람이 앱 주사위로 더블이면 차례를 못 끝내고 한 번 더', () => {
  const room = g.createRoom('1', '엄마', 'a', 'mixed');
  g.applyAction(room, 'a', { type: 'addBot' });
  g.applyAction(room, 'a', { type: 'pickColor', color: g.PIECES[0].color });
  g.applyAction(room, 'a', { type: 'start' });
  g.applyAction(room, 'a', { type: 'orderRoll', dice: [6, 6] });
  g.applyAction(room, room.players[1].id, { type: 'orderRoll', dice: [1, 2] });
  assert.strictEqual(room.turn.pid, 'a');
  room.hostId = 'x'; // 방장 권한 없이 확인
  g.applyAction(room, 'a', { type: 'roll', dice: [2, 2] });
  assert.strictEqual(room.turn.again, true);
  assert.throws(() => g.applyAction(room, 'a', { type: 'endTurn' }), /더블/);
  g.applyAction(room, 'a', { type: 'roll', dice: [1, 2] });
  g.applyAction(room, 'a', { type: 'endTurn' });
  assert.strictEqual(room.turn.pid, room.players[1].id);
});

test('앱 + 실물 + 컴퓨터: 컴퓨터가 포춘카드 칸에 서면 사람이 랜덤 또는 실물 카드로 정해 줌', () => {
  const room = g.createRoom('1', '엄마', 'a', 'mixed');
  g.applyAction(room, 'a', { type: 'addBot' });
  g.applyAction(room, 'a', { type: 'pickColor', color: g.PIECES[0].color });
  g.applyAction(room, 'a', { type: 'start' });
  const c = room.players[1];
  g.applyAction(room, 'a', { type: 'orderRoll', dice: [1, 1] });
  g.applyAction(room, c.id, { type: 'orderRoll', dice: [6, 6] });
  assert.strictEqual(room.turn.pid, c.id);
  c.pos = 10;
  g.applyAction(room, c.id, { type: 'roll', dice: [1, 1] }); // → 12 포춘카드
  assert.strictEqual(room.turn.mustDraw, true);
  assert.strictEqual(bot.next(g.publicState(room), c.id), null); // 사람이 정할 때까지 기다림
  room.hostId = 'x';
  g.applyAction(room, 'a', { type: 'botDraw', key: 'shield' }); // 실물로 뽑은 방패
  assert.strictEqual(c.card, 'shield');
  assert.strictEqual(room.turn.mustDraw, false);
  assert.ok(bot.next(g.publicState(room), c.id));
  assert.throws(() => g.applyAction(room, 'a', { type: 'botDraw', pick: 0.5 }), /뽑을 차례가 아니/);
});
