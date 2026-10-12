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

test('컴퓨터 추가는 앱으로만 하는 방의 방장만, 시작하면 남은 색', () => {
  const room = g.createRoom('1', '엄마', 'a', 'app');
  g.addPlayer(room, '아빠', 'b');
  assert.throws(() => g.applyAction(room, 'b', { type: 'addBot' }), /방장/);
  g.applyAction(room, 'a', { type: 'addBot' });
  assert.strictEqual(room.players[2].name, '컴퓨터1');
  g.applyAction(room, 'a', { type: 'pickColor', color: g.PIECES[0].color });
  g.applyAction(room, 'b', { type: 'pickColor', color: g.PIECES[1].color });
  g.applyAction(room, 'a', { type: 'start' });
  assert.strictEqual(room.players[2].color, g.PIECES[2].color);
  const mixed = g.createRoom('2', '엄마', 'a', 'mixed');
  assert.throws(() => g.applyAction(mixed, 'a', { type: 'addBot' }), /앱으로만/);
});
