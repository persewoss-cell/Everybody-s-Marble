'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../game');

const M = g.MAN;
const id = (name) => g.BOARD.find((t) => t.name === name).id;

function setup(n = 3) {
  const room = g.createRoom('1234', '엄마', 'a');
  g.addPlayer(room, '아빠', 'b');
  if (n > 2) g.addPlayer(room, '아들', 'c');
  room.players.forEach((p, i) => g.applyAction(room, p.id, { type: 'pickColor', color: g.PIECES[i].color }));
  g.applyAction(room, 'a', { type: 'start' });
  room.festival = []; // 축제도시는 테스트마다 직접 정함
  return room;
}
const act = (room, who, type, extra) => g.applyAction(room, who, { type, ...extra });
const money = (room, who) => room.players.find((p) => p.id === who).money;
const give = (room, who, laps, cash) => Object.assign(room.players.find((p) => p.id === who), { laps, money: cash ?? 1000 * M });

test('보드: 일반도시 18곳, 관광지 섬 3 · 해변 2, 색 8가지', () => {
  assert.strictEqual(g.BOARD.filter((t) => t.kind === 'city').length, 18);
  assert.strictEqual(g.BOARD.filter((t) => t.tour === 'island').length, 3);
  assert.strictEqual(g.BOARD.filter((t) => t.tour === 'beach').length, 2);
  assert.strictEqual(new Set(g.BOARD.filter((t) => t.kind === 'city').map((t) => t.group)).size, 8);
});

test('시작 200만, 월급 30만과 턴, 월급 부스터 2배', () => {
  const room = setup();
  assert.strictEqual(money(room, 'a'), 200 * M);
  assert.strictEqual(room.festival.length, 0);
  act(room, 'a', 'salary');
  act(room, 'a', 'salary', { booster: true });
  assert.strictEqual(money(room, 'a'), 290 * M);
  assert.strictEqual(room.players[0].laps, 2);
});

test('턴 제한: 첫 턴 빌라, 두 번째 빌딩, 세 번째 호텔까지', () => {
  const room = setup();
  assert.throws(() => act(room, 'a', 'buy', { tileId: id('서울'), items: ['villa', 'building'] }), /빌라까지만/);
  act(room, 'a', 'buy', { tileId: id('서울'), items: ['villa'] }); // 22+8 = 30만 (룰북 예시)
  assert.strictEqual(money(room, 'a'), 170 * M);
  give(room, 'a', 1);
  assert.throws(() => act(room, 'a', 'build', { tileId: id('서울'), items: ['hotel'] }));
  act(room, 'a', 'build', { tileId: id('서울'), items: ['building'] });
  give(room, 'a', 2);
  act(room, 'a', 'build', { tileId: id('서울'), items: ['hotel'] });
  assert.throws(() => act(room, 'a', 'build', { tileId: id('서울'), items: ['landmark'] }));
  give(room, 'a', 3);
  act(room, 'a', 'build', { tileId: id('서울'), items: ['landmark'] });
});

test('룰북 예시: 방콕 통행료 3만5천 / 랜드마크까지 34만5천 / 호텔만 6만5천', () => {
  const room = setup();
  give(room, 'a', 3);
  act(room, 'a', 'buy', { tileId: id('방콕'), items: ['villa', 'building'] });
  assert.strictEqual(g.tollInfo(room, id('방콕')).amount, 3.5 * M);
  assert.strictEqual(g.takeoverPrice(room, id('방콕')), 14 * M); // 인수비용 14만
  act(room, 'a', 'build', { tileId: id('방콕'), items: ['hotel'] });
  assert.strictEqual(g.takeoverPrice(room, id('방콕')), 26 * M); // 인수비용 26만
  act(room, 'a', 'build', { tileId: id('방콕'), items: ['landmark'] });
  assert.strictEqual(g.tollInfo(room, id('방콕')).amount, 34.5 * M);
  assert.strictEqual(g.sellPrice(room, id('방콕')), 9.5 * M); // 매각비용 9만5천
  act(room, 'a', 'buy', { tileId: id('베이징'), items: ['hotel'] });
  // 베이징까지 가지면 연두 컬러독점 → 2배. 호텔만: (5천 + 6만) × 2
  assert.strictEqual(g.tollInfo(room, id('베이징')).amount, 13 * M);
  assert.strictEqual(g.fmt(6.5 * M), '6만 5천');
});

test('통행료 상승: 축제 ×2, 올림픽 ×2→×5, 한 곳에만', () => {
  const room = setup();
  give(room, 'a', 0);
  act(room, 'a', 'buy', { tileId: id('서울') }); // 땅 통행료 8만
  act(room, 'a', 'buy', { tileId: id('파리') });
  room.festival = [id('서울')];
  assert.strictEqual(g.tollInfo(room, id('서울')).amount, 16 * M);
  act(room, 'a', 'olympic', { tileId: id('서울') });
  assert.strictEqual(g.tollInfo(room, id('서울')).amount, 32 * M); // 8 × 2 × 2
  for (let i = 0; i < 3; i++) act(room, 'a', 'olympic', { tileId: id('서울') });
  assert.strictEqual(g.tollInfo(room, id('서울')).amount, 80 * M); // 8 × 2 × 5
  assert.throws(() => act(room, 'a', 'olympic', { tileId: id('서울') }));
  act(room, 'a', 'olympic', { tileId: id('파리') }); // 다른 도시로 옮기면 ×2부터
  assert.deepStrictEqual(room.olympic, { tileId: id('파리'), count: 1 });
  assert.strictEqual(g.tollInfo(room, id('서울')).amount, 16 * M);
});

test('통행료 내기, 천사 면제, 할인쿠폰 반값, 인수', () => {
  const room = setup();
  give(room, 'a', 1);
  act(room, 'a', 'buy', { tileId: id('뉴욕'), items: ['villa', 'building'] }); // 통행료 7+15+32 = 54
  act(room, 'b', 'toll', { tileId: id('뉴욕'), coupon: true });
  assert.strictEqual(money(room, 'b'), 173 * M);
  act(room, 'c', 'toll', { tileId: id('뉴욕'), angel: true });
  assert.strictEqual(money(room, 'c'), 200 * M);
  act(room, 'b', 'takeover', { tileId: id('뉴욕') }); // 40+16+48 = 104
  assert.strictEqual(money(room, 'b'), 69 * M);
  assert.strictEqual(room.props[id('뉴욕')].owner, 'b');
});

test('관광지: 섬은 보유 개수, 해변은 방문 횟수로 단계가 오르고 인수 불가', () => {
  const room = setup();
  act(room, 'a', 'buy', { tileId: id('독도') });
  assert.strictEqual(g.tollInfo(room, id('독도')).amount, 8 * M);
  act(room, 'a', 'buy', { tileId: id('하와이') });
  assert.strictEqual(g.tollInfo(room, id('독도')).amount, 16 * M);
  act(room, 'a', 'buy', { tileId: id('푸켓') });
  assert.strictEqual(g.tollInfo(room, id('하와이')).amount, 32 * M);
  assert.throws(() => act(room, 'b', 'takeover', { tileId: id('독도') }), /관광지는 인수/);
  act(room, 'b', 'buy', { tileId: id('발리') });
  act(room, 'c', 'toll', { tileId: id('발리') }); // 깃발 8만을 내고 파라솔로
  assert.strictEqual(money(room, 'c'), 192 * M);
  assert.strictEqual(g.tollInfo(room, id('발리')).amount, 16 * M);
  act(room, 'b', 'arrive', { tileId: id('발리') }); // 주인 방문도 포함 → 방갈로
  assert.strictEqual(g.tollInfo(room, id('발리')).amount, 32 * M);
  assert.strictEqual(g.sellPrice(room, id('발리')), 5 * M);
});

test('잔액 부족: 통행료·세금만 매각 가능', () => {
  const room = setup();
  give(room, 'b', 0, 3 * M);
  assert.throws(() => act(room, 'b', 'pay', { what: 'tax' }), (e) => e.extra.code === 'INSUFFICIENT' && e.extra.sellable);
  assert.throws(() => act(room, 'b', 'pay', { what: 'travel' }), (e) => e.extra.code === 'INSUFFICIENT' && !e.extra.sellable);
});

test('포춘카드: 전염병·황사·정전, 방문하면 해제', () => {
  const room = setup();
  act(room, 'a', 'buy', { tileId: id('서울') });
  act(room, 'a', 'buy', { tileId: id('뉴욕') }); // 빨강 독점 → 서울 땅 8 × 2 = 16
  act(room, 'b', 'epidemic', { tileId: id('서울') });
  assert.strictEqual(g.tollInfo(room, id('서울')).amount, 8 * M);
  assert.strictEqual(g.tollInfo(room, id('뉴욕')).amount, 7 * M);
  act(room, 'b', 'dust', { tileId: id('서울') });
  assert.strictEqual(g.tollInfo(room, id('서울')).amount, 4 * M);
  act(room, 'c', 'toll', { tileId: id('서울') }); // 방문하면 효과 해제
  assert.strictEqual(g.tollInfo(room, id('서울')).amount, 16 * M);
  act(room, 'b', 'blackout', { tileId: id('뉴욕') });
  assert.strictEqual(g.tollInfo(room, id('뉴욕')).amount, 0);
});

test('포춘카드: 지진·외계인 침공·강제매각·도시체인지·도시기부·후원금', () => {
  const room = setup();
  give(room, 'a', 3);
  act(room, 'a', 'buy', { tileId: id('프라하'), items: ['villa', 'building', 'hotel'] });
  act(room, 'a', 'buy', { tileId: id('베를린'), items: ['villa'] });
  act(room, 'b', 'quake', { tileId: id('프라하') });
  assert.strictEqual(room.props[id('프라하')].built.hotel, false);
  act(room, 'b', 'alien', { tileId: id('베를린') });
  assert.strictEqual(room.props[id('프라하')].built.building, false);
  assert.strictEqual(room.props[id('베를린')].built.villa, false);
  act(room, 'b', 'buy', { tileId: id('방콕') });
  act(room, 'b', 'swap', { tileId: id('프라하'), mineId: id('방콕') });
  assert.strictEqual(room.props[id('프라하')].owner, 'b');
  assert.strictEqual(room.props[id('방콕')].owner, 'a');
  const before = money(room, 'a');
  act(room, 'c', 'forceSell', { tileId: id('방콕') });
  assert.strictEqual(money(room, 'a'), before + 1 * M);
  assert.strictEqual(room.props[id('방콕')], undefined);
  act(room, 'b', 'donate', { tileId: id('프라하'), to: 'c' });
  assert.strictEqual(room.props[id('프라하')].owner, 'c');
  give(room, 'b', 0, 4 * M);
  const c = money(room, 'c');
  act(room, 'c', 'sponsor');
  assert.strictEqual(money(room, 'c'), c + 14 * M); // 아빠는 4만뿐이라 4만만
});

test('랜드마크 도시는 인수·공격 불가, 도시기부는 가능', () => {
  const room = setup();
  give(room, 'a', 3);
  act(room, 'a', 'buy', { tileId: id('로마'), items: ['villa', 'building', 'hotel'] });
  act(room, 'a', 'build', { tileId: id('로마'), items: ['landmark'] });
  assert.throws(() => act(room, 'b', 'takeover', { tileId: id('로마') }));
  assert.throws(() => act(room, 'b', 'quake', { tileId: id('로마') }));
  assert.throws(() => act(room, 'b', 'forceSell', { tileId: id('로마') }));
  act(room, 'a', 'donate', { tileId: id('로마'), to: 'b' });
});

test('되돌리기: 가장 최근 거래부터, 땅과 턴까지 원래대로', () => {
  const room = setup();
  act(room, 'a', 'salary');
  act(room, 'a', 'buy', { tileId: id('서울'), items: ['villa', 'building'] });
  assert.throws(() => act(room, 'b', 'undo'), /엄마님 것/);
  act(room, 'a', 'undo');
  assert.strictEqual(room.props[id('서울')], undefined);
  assert.strictEqual(money(room, 'a'), 230 * M);
  assert.throws(() => act(room, 'b', 'undo')); // 남은 최근 거래(월급)도 엄마 것
  act(room, 'a', 'undo');
  assert.strictEqual(room.players[0].laps, 0);
});

test('승리독점 자동 판정과 파산', () => {
  const room = setup();
  for (const n of ['방콕', '베이징', '독도', '타이페이', '두바이']) act(room, 'a', 'buy', { tileId: id(n) });
  give(room, 'a', 0);
  assert.strictEqual(room.status, 'playing');
  act(room, 'a', 'buy', { tileId: id('카이로') });
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(room.result.reason, '라인 독점');
  act(room, 'a', 'undo');
  assert.strictEqual(room.status, 'playing');
  act(room, 'b', 'buy', { tileId: id('서울') });
  act(room, 'b', 'bankrupt', { to: 'a' });
  assert.strictEqual(room.props[id('서울')], undefined);
  act(room, 'c', 'bankrupt');
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(room.result.winnerId, 'a');
});

test('시간 종료면 마블이 가장 많은 사람 승리', () => {
  const room = setup();
  act(room, 'b', 'salary');
  act(room, 'a', 'end', { reason: 'time' });
  assert.strictEqual(room.result.winnerId, 'b');
});

test('다른 기기에서 미리 계산해도 방장과 같은 결과', () => {
  const room = setup();
  act(room, 'a', 'buy', { tileId: id('서울') });
  const copy = g.roomFromPublic(g.publicState(room));
  g.applyAction(copy, 'b', { type: 'toll', tileId: id('서울') });
  g.applyAction(room, 'b', { type: 'toll', tileId: id('서울') });
  assert.deepStrictEqual(g.publicState(copy).players, g.publicState(room).players);
});

test('송금: 은행에도 낼 수 있음', () => {
  const room = setup();
  act(room, 'a', 'transfer', { to: 'bank', amount: 15 * M });
  assert.strictEqual(money(room, 'a'), 185 * M);
  act(room, 'a', 'undo');
  assert.strictEqual(money(room, 'a'), 200 * M);
});

test('말 색: 방장부터, 겹치지 않게, 다 골라야 시작', () => {
  const room = g.createRoom('1', '엄마', 'a');
  g.addPlayer(room, '아빠', 'b');
  const red = g.PIECES[0].color;
  assert.throws(() => act(room, 'b', 'pickColor', { color: red }), /방장이 먼저/);
  act(room, 'a', 'pickColor', { color: red });
  assert.throws(() => act(room, 'b', 'pickColor', { color: red }), /이미 고른/);
  assert.throws(() => act(room, 'a', 'start'), /아빠님이 아직/);
  act(room, 'b', 'pickColor', { color: g.PIECES[3].color });
  act(room, 'a', 'start');
});

test('게임판 32칸과 말 위치', () => {
  assert.strictEqual(g.SPACES.length, 32);
  assert.deepStrictEqual(g.SPACES.filter((s) => s.kind === 'special').map((s) => s.key),
    ['start', 'bonus', 'island', 'card', 'olympic', 'card', 'travel', 'card', 'tax']);
  assert.deepStrictEqual(g.SPACES.slice(25, 28).map((s) => s.name), ['타히티', '런던', '파리']);
  const room = setup();
  act(room, 'b', 'buy', { tileId: id('서울') });
  assert.strictEqual(room.players[1].pos, 31);
  act(room, 'b', 'pay', { what: 'tax' });
  assert.strictEqual(room.players[1].pos, 30);
  act(room, 'b', 'move', { to: 8 });
  act(room, 'b', 'undo'); // 되돌려도 말 위치는 그대로
  assert.strictEqual(room.players[1].pos, 8);
  act(room, 'b', 'salary', { at: 0 });
  assert.strictEqual(room.players[1].pos, 0);
});

// ---- 앱으로만 하는 방 ----
function appRoom() {
  const room = g.createRoom('1', '엄마', 'a', 'app');
  g.addPlayer(room, '아빠', 'b');
  room.players.forEach((p, i) => g.applyAction(room, p.id, { type: 'pickColor', color: g.PIECES[i].color }));
  g.applyAction(room, 'a', { type: 'start' });
  room.festival = [];
  act(room, 'a', 'orderRoll', { dice: [2, 3] });
  act(room, 'b', 'orderRoll', { dice: [6, 6] });
  return room;
}

test('앱 모드: 순서 정하기는 높은 사람부터, 동점이면 다시', () => {
  const room = g.createRoom('1', '엄마', 'a', 'app');
  g.addPlayer(room, '아빠', 'b');
  room.players.forEach((p, i) => g.applyAction(room, p.id, { type: 'pickColor', color: g.PIECES[i].color }));
  act(room, 'a', 'start');
  act(room, 'a', 'orderRoll', { dice: [3, 4] });
  act(room, 'b', 'orderRoll', { dice: [5, 2] });
  assert.strictEqual(room.phase, 'order'); // 7:7 동점
  act(room, 'b', 'orderRoll', { dice: [1, 1] });
  act(room, 'a', 'orderRoll', { dice: [6, 1] });
  assert.deepStrictEqual(room.order, ['a', 'b']);
  assert.strictEqual(room.turn.pid, 'a');
});

test('앱 모드: 내 차례만, 출발지 지나면 월급, 더블이면 한 번 더', () => {
  const room = appRoom();
  assert.strictEqual(room.turn.pid, 'b');
  assert.throws(() => act(room, 'a', 'roll', { dice: [1, 2] }), /아빠님 차례/);
  act(room, 'b', 'roll', { dice: [2, 2] });
  assert.strictEqual(room.players[1].pos, 4);
  act(room, 'b', 'roll', { dice: [6, 5] }); // 더블이라 한 번 더 → 15
  assert.strictEqual(room.players[1].pos, 15);
  assert.throws(() => act(room, 'b', 'roll', { dice: [1, 2] }), /이미 굴렸어요/);
  act(room, 'b', 'endTurn');
  assert.strictEqual(room.turn.pid, 'a');
  room.players[0].pos = 30;
  act(room, 'a', 'roll', { dice: [1, 2] }); // 30 → 1, 출발지 통과
  assert.strictEqual(room.players[0].pos, 1);
  assert.strictEqual(money(room, 'a'), 230 * M);
});

test('앱 모드: 더블 3번이면 무인도, 무인도는 더블이나 보석금으로 탈출', () => {
  const room = appRoom();
  act(room, 'b', 'roll', { dice: [1, 1] });
  act(room, 'b', 'roll', { dice: [1, 1] });
  act(room, 'b', 'roll', { dice: [1, 1] });
  assert.strictEqual(room.players[1].pos, 8);
  assert.strictEqual(room.players[1].jail, 3);
  act(room, 'b', 'endTurn');
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  act(room, 'b', 'roll', { dice: [1, 2] }); // 실패
  assert.strictEqual(room.players[1].pos, 8);
  assert.strictEqual(room.players[1].jail, 2);
  act(room, 'b', 'endTurn');
  act(room, 'a', 'endTurn');
  act(room, 'b', 'pay', { what: 'bail' });
  act(room, 'b', 'roll', { dice: [1, 2] });
  assert.strictEqual(room.players[1].pos, 11);
});

test('앱 모드: 세계여행은 다음 차례에 원하는 곳으로', () => {
  const room = appRoom();
  room.players[1].pos = 20;
  act(room, 'b', 'roll', { dice: [1, 3] });
  assert.strictEqual(room.players[1].travel, true);
  act(room, 'b', 'endTurn');
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  assert.throws(() => act(room, 'b', 'roll', { dice: [1, 2] }), /세계여행/);
  act(room, 'b', 'travelTo', { to: 5 }); // 출발지 지나서 월급
  assert.strictEqual(room.players[1].pos, 5);
  assert.strictEqual(money(room, 'b'), 220 * M);
});

test('앱 모드: 포춘카드 뽑기, 보관 카드는 1장, 방패로 공격 방어', () => {
  const room = appRoom();
  const pick = (key) => { const d = g.deck(room); return (d.indexOf(key) + 0.5) / d.length; };
  assert.strictEqual(g.deck(room).length, 27);
  act(room, 'b', 'draw', { pick: pick('shield') });
  assert.strictEqual(room.players[1].card, 'shield');
  assert.strictEqual(g.deck(room).length, 26);
  act(room, 'b', 'draw', { pick: pick('coupon') });
  assert.strictEqual(room.players[1].pendingCard, 'coupon');
  act(room, 'b', 'keepCard', { keep: 'old' });
  assert.strictEqual(room.players[1].card, 'shield');
  act(room, 'b', 'buy', { tileId: id('서울') });
  act(room, 'b', 'roll', { dice: [1, 2] });
  act(room, 'b', 'endTurn');
  act(room, 'a', 'quake', { tileId: id('서울') }); // 건물이 없어도 방패가 먼저 막음
  assert.strictEqual(room.players[1].card, null);
  act(room, 'a', 'draw', { pick: pick('goStart') });
  assert.strictEqual(room.players[0].pos, 0);
});

test('매각: 원할 때 할 수 있고, 앱으로만 하는 방은 내 차례에만', () => {
  const room = appRoom();
  act(room, 'b', 'buy', { tileId: id('서울') });
  act(room, 'b', 'roll', { dice: [1, 2] });
  act(room, 'b', 'endTurn');
  assert.throws(() => act(room, 'b', 'sell', { tileId: id('서울') }), /엄마님 차례/);
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  act(room, 'b', 'sell', { tileId: id('서울') });
  assert.strictEqual(money(room, 'b'), 219 * M); // 200 - 22 + 30(서울에서 출발지 통과) + 11
});
