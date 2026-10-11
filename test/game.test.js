'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../game');

const M = g.MAN;

function setup(n = 3) {
  const room = g.createRoom('1234', '방장', 'a', null);
  if (n > 1) g.addPlayer(room, '둘', 'b');
  if (n > 2) g.addPlayer(room, '셋', 'c');
  g.applyAction(room, 'a', { type: 'start' });
  return room;
}
const money = (room, id) => room.players.find((p) => p.id === id).money;

test('시작 자금과 월급', () => {
  const room = setup();
  assert.strictEqual(money(room, 'a'), 200 * M);
  g.applyAction(room, 'b', { type: 'salary' });
  assert.strictEqual(money(room, 'b'), 230 * M);
});

test('통행료: 독점 2배, 올림픽 배수 중첩', () => {
  const room = setup();
  g.applyAction(room, 'b', { type: 'toll', to: 'a', base: 10 * M, monopoly: true, olympics: 1 });
  assert.strictEqual(money(room, 'b'), 160 * M);
  assert.strictEqual(money(room, 'a'), 240 * M);
});

test('인수: 건설가 2배, 랜드마크 불가', () => {
  const room = setup();
  g.applyAction(room, 'b', { type: 'takeover', to: 'c', value: 30 * M });
  assert.strictEqual(money(room, 'b'), 140 * M);
  assert.strictEqual(money(room, 'c'), 260 * M);
  assert.throws(() => g.applyAction(room, 'b', { type: 'takeover', to: 'c', value: 30 * M, landmark: true }));
});

test('잔액 부족이면 거래되지 않음', () => {
  const room = setup();
  assert.throws(
    () => g.applyAction(room, 'b', { type: 'payBank', amount: 300 * M }),
    (e) => e.extra.code === 'INSUFFICIENT' && e.extra.shortfall === 100 * M,
  );
  assert.strictEqual(money(room, 'b'), 200 * M);
});

test('매각은 설정 비율만큼 받음', () => {
  const room = setup();
  g.applyAction(room, 'b', { type: 'sell', value: 40 * M });
  assert.strictEqual(money(room, 'b'), 220 * M);
});

test('파산: 남은 돈은 채권자에게, 마지막 1명이 남으면 승리', () => {
  const room = setup();
  g.applyAction(room, 'b', { type: 'bankrupt', to: 'a' });
  assert.strictEqual(money(room, 'a'), 400 * M);
  assert.strictEqual(money(room, 'b'), 0);
  assert.strictEqual(room.status, 'playing');
  g.applyAction(room, 'c', { type: 'bankrupt' });
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(room.result.winnerId, 'a');
});

test('되돌리기: 본인 또는 방장만, 파산도 복구', () => {
  const room = setup(2);
  g.applyAction(room, 'b', { type: 'transfer', to: 'a', amount: 5 * M });
  const tx = room.log[room.log.length - 1];
  g.applyAction(room, 'b', { type: 'bankrupt', to: 'a' });
  assert.strictEqual(room.status, 'ended');
  const bk = room.log[room.log.length - 1];
  g.applyAction(room, 'a', { type: 'undo', txId: bk.id });
  assert.strictEqual(room.status, 'playing');
  assert.strictEqual(money(room, 'b'), 195 * M);
  g.applyAction(room, 'a', { type: 'undo', txId: tx.id });
  assert.strictEqual(money(room, 'b'), 200 * M);
  assert.throws(() => g.applyAction(room, 'a', { type: 'undo', txId: tx.id }));
});

test('방장 권한과 인원 제한', () => {
  const room = g.createRoom('1', 'x', 'a', null);
  g.addPlayer(room, 'b', 'b');
  assert.throws(() => g.applyAction(room, 'b', { type: 'start' }));
  g.addPlayer(room, 'c', 'c');
  g.addPlayer(room, 'd', 'd');
  assert.throws(() => g.addPlayer(room, 'e', 'e'));
  assert.throws(() => g.addPlayer(room, 'b', 'f'));
});

test('금액 표시', () => {
  assert.strictEqual(g.fmt(200 * M), '200만');
  assert.strictEqual(g.fmt(12345 * M), '1억 2,345만');
  assert.strictEqual(g.fmt(25000), '2.5만');
});
