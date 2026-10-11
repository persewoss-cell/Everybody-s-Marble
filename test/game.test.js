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

// ---- 도시 가격표 자동 계산 ----
const city = (id, group, line, land) => ({
  id, name: id, kind: 'city', group, line,
  cost: { land, villa: 5 * M, building: 10 * M, hotel: 20 * M, landmark: 30 * M },
  toll: { land: 2 * M, villa: 4 * M, building: 8 * M, hotel: 16 * M, landmark: 40 * M },
});
const tour = (id, line) => ({ id, name: id, kind: 'tour', line, cost: { land: 20 * M }, toll: { land: 10 * M } });
const BOARD = [
  city('a1', 0, 0, 10 * M), city('a2', 0, 1, 10 * M),
  city('b1', 1, 2, 10 * M), city('b2', 1, 0, 10 * M),
  city('c1', 2, 1, 10 * M), city('c2', 2, 2, 10 * M),
  city('x0', 3, 0, 10 * M), city('x1', 3, 1, 10 * M), city('x2', 3, 2, 10 * M),
  tour('t1', 3), tour('t2', 3),
];
function setupBoard() {
  const room = g.createRoom('1', '방장', 'a', { startMoney: 1000 * M }, BOARD);
  g.addPlayer(room, '둘', 'b');
  g.addPlayer(room, '셋', 'c');
  g.applyAction(room, 'a', { type: 'start' });
  return room;
}

test('땅 구매와 건설, 통행료 자동 계산', () => {
  const room = setupBoard();
  g.applyAction(room, 'a', { type: 'buyTile', tileId: 'a1', items: ['villa'] });
  assert.strictEqual(money(room, 'a'), 985 * M);
  assert.throws(() => g.applyAction(room, 'a', { type: 'buildTile', tileId: 'a1', items: ['landmark'] }));
  g.applyAction(room, 'a', { type: 'buildTile', tileId: 'a1', items: ['building', 'hotel'] });
  assert.strictEqual(money(room, 'a'), 955 * M);
  g.applyAction(room, 'b', { type: 'payTollTile', tileId: 'a1' });
  assert.strictEqual(money(room, 'b'), 970 * M); // 2+4+8+16 = 30
  // 컬러 독점 → 2배, 올림픽 → 2배 더
  g.applyAction(room, 'a', { type: 'buyTile', tileId: 'a2' });
  g.applyAction(room, 'a', { type: 'olympicTile', tileId: 'a1' });
  assert.strictEqual(g.tollInfo(room, 'a1').amount, 120 * M);
});

test('인수: 건설가 2배로 땅과 건물을 가져오고, 랜드마크는 불가', () => {
  const room = setupBoard();
  g.applyAction(room, 'a', { type: 'buyTile', tileId: 'b1', items: ['villa'] });
  g.applyAction(room, 'b', { type: 'takeoverTile', tileId: 'b1' });
  assert.strictEqual(money(room, 'b'), 970 * M); // (10+5)*2
  assert.strictEqual(room.props.b1.owner, 'b');
  g.applyAction(room, 'b', { type: 'buildTile', tileId: 'b1', items: ['building', 'hotel'] });
  g.applyAction(room, 'b', { type: 'buildTile', tileId: 'b1', items: ['landmark'] });
  assert.throws(() => g.applyAction(room, 'a', { type: 'takeoverTile', tileId: 'b1' }));
});

test('매각과 되돌리기', () => {
  const room = setupBoard();
  g.applyAction(room, 'a', { type: 'buyTile', tileId: 'c1', items: ['villa', 'building'] });
  g.applyAction(room, 'a', { type: 'sellTile', tileId: 'c1' });
  assert.strictEqual(money(room, 'a'), (1000 - 25 + 12.5) * M);
  assert.strictEqual(room.props.c1, undefined);
  const tx = room.log[room.log.length - 1];
  g.applyAction(room, 'a', { type: 'undo', txId: tx.id });
  assert.strictEqual(room.props.c1.owner, 'a');
  assert.strictEqual(money(room, 'a'), 975 * M);
});

test('트리플 독점 자동 승리, 취소하면 게임 계속', () => {
  const room = setupBoard();
  for (const id of ['a1', 'a2', 'b1', 'b2', 'c1']) g.applyAction(room, 'b', { type: 'buyTile', tileId: id });
  assert.strictEqual(room.status, 'playing');
  g.applyAction(room, 'b', { type: 'buyTile', tileId: 'c2' });
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(room.result.reason, '트리플 독점');
  g.applyAction(room, 'a', { type: 'undo', txId: room.log[room.log.length - 1].id });
  assert.strictEqual(room.status, 'playing');
  assert.strictEqual(room.props.c2, undefined);
});

test('관광지 독점과 라인 독점', () => {
  const room = setupBoard();
  g.applyAction(room, 'c', { type: 'buyTile', tileId: 't1' });
  g.applyAction(room, 'c', { type: 'buyTile', tileId: 't2' });
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(room.result.reason, '라인 독점'); // t1, t2가 같은 줄이라 라인 독점이 먼저
});

test('파산하면 땅은 은행으로', () => {
  const room = setupBoard();
  g.applyAction(room, 'b', { type: 'buyTile', tileId: 'a1' });
  g.applyAction(room, 'b', { type: 'bankrupt', to: 'a' });
  assert.strictEqual(room.props.a1, undefined);
});

test('실물 카드 기본 가격표', () => {
  const room = g.createRoom('1', '방장', 'a', { startMoney: 1000 * M }, g.defaultBoard());
  g.addPlayer(room, '둘', 'b');
  g.applyAction(room, 'a', { type: 'start' });
  const id = (name) => room.board.find((t) => t.name === name).id;
  assert.strictEqual(room.board.length, 23);
  assert.strictEqual(room.board.filter((t) => t.kind === 'tour').length, 5);
  // 서울: 땅+빌라+빌딩+호텔 = 22+8+24+40 = 94만, 통행료 8+16+34+70 = 128만
  g.applyAction(room, 'a', { type: 'buyTile', tileId: id('서울'), items: ['villa', 'building', 'hotel'] });
  assert.strictEqual(money(room, 'a'), 906 * M);
  assert.strictEqual(g.tollInfo(room, id('서울')).amount, 128 * M);
  assert.strictEqual(g.takeoverPrice(room, id('서울')), 188 * M); // 카드 인수비용 44+16+48+80
  assert.strictEqual(g.sellPrice(room, id('서울')), 47 * M); // 카드 매각비용 11+4+12+20
  // 관광지: 단계별 통행료 8 → 16 → 32, 인수 불가
  g.applyAction(room, 'a', { type: 'buyTile', tileId: id('독도') });
  assert.strictEqual(g.tollInfo(room, id('독도')).amount, 8 * M);
  assert.throws(() => g.applyAction(room, 'a', { type: 'buildTile', tileId: id('독도'), items: ['bungalow'] }));
  g.applyAction(room, 'a', { type: 'buildTile', tileId: id('독도'), items: ['parasol', 'bungalow'] });
  assert.strictEqual(g.tollInfo(room, id('독도')).amount, 32 * M);
  assert.throws(() => g.applyAction(room, 'b', { type: 'takeoverTile', tileId: id('독도') }));
  // 방콕 통행료 5천
  g.applyAction(room, 'b', { type: 'buyTile', tileId: id('방콕') });
  assert.strictEqual(g.fmt(g.tollInfo(room, id('방콕')).amount), '5천');
});
