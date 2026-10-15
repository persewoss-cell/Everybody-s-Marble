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

test('랜드마크 도시는 인수·공격·기부 불가', () => {
  const room = setup();
  give(room, 'a', 3);
  act(room, 'a', 'buy', { tileId: id('로마'), items: ['villa', 'building', 'hotel'] });
  act(room, 'a', 'build', { tileId: id('로마'), items: ['landmark'] });
  assert.throws(() => act(room, 'b', 'takeover', { tileId: id('로마') }));
  assert.throws(() => act(room, 'b', 'quake', { tileId: id('로마') }));
  assert.throws(() => act(room, 'b', 'forceSell', { tileId: id('로마') }));
  assert.throws(() => act(room, 'a', 'donate', { tileId: id('로마'), to: 'b' }), /기부/);
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
  act(room, 'b', 'travelTo', { to: 5 }); // 출발지 지나서 월급
  assert.strictEqual(room.players[1].pos, 5);
  assert.strictEqual(money(room, 'b'), 220 * M);
});

test('앱 모드: 포춘카드 뽑기, 보관 카드는 1장, 방패로 공격 방어', () => {
  const room = appRoom();
  const pick = (key) => { const d = g.deck(room); return (d.indexOf(key) + 0.5) / d.length; };
  assert.strictEqual(g.deck(room).length, 27);
  assert.throws(() => act(room, 'b', 'draw', { pick: 0.5 }), /포춘카드 칸/);
  room.players[1].pos = 10;
  act(room, 'b', 'roll', { dice: [1, 1] }); // → 12 포춘카드
  assert.throws(() => act(room, 'b', 'roll', { dice: [1, 2] }), /포춘카드를 뽑아/);
  act(room, 'b', 'draw', { pick: pick('shield') });
  assert.strictEqual(room.players[1].card, 'shield');
  assert.strictEqual(g.deck(room).length, 26);
  assert.throws(() => act(room, 'b', 'draw', { pick: 0.5 }), /포춘카드 칸/); // 한 번만
  act(room, 'b', 'roll', { dice: [4, 4] }); // → 20 포춘카드
  act(room, 'b', 'draw', { pick: pick('coupon') });
  assert.strictEqual(room.players[1].pendingCard, 'coupon');
  act(room, 'b', 'keepCard', { keep: 'old' });
  assert.strictEqual(room.players[1].card, 'shield');
  act(room, 'b', 'roll', { dice: [1, 2] }); // → 23 로마
  act(room, 'b', 'buy', { tileId: id('로마') });
  act(room, 'b', 'endTurn');
  act(room, 'a', 'quake', { tileId: id('로마') }); // 방패를 가진 아빠에게 막을지 물어봄 (방장은 바로잡기용으로 언제든)
  assert.strictEqual(room.turn.awaitDefense.victim, 'b');
  act(room, 'b', 'defend', { use: true });
  assert.strictEqual(room.players[1].card, null);
  assert.ok(/방패 카드로 엄마의 지진 공격을 막았어요/.test(room.log[room.log.length - 1].text));
  act(room, 'a', 'draw', { pick: pick('goStart') });
  assert.strictEqual(room.players[0].pos, 0);
});

test('매각: 원할 때 할 수 있고, 앱으로만 하는 방은 내 차례에만', () => {
  const room = appRoom();
  room.players[1].pos = 29;
  act(room, 'b', 'roll', { dice: [1, 1] }); // → 31 서울
  act(room, 'b', 'buy', { tileId: id('서울') });
  act(room, 'b', 'roll', { dice: [1, 2] });
  act(room, 'b', 'endTurn');
  assert.throws(() => act(room, 'b', 'sell', { tileId: id('서울') }), /엄마님 차례/);
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  act(room, 'b', 'sell', { tileId: id('서울') });
  assert.strictEqual(money(room, 'b'), 219 * M); // 200 - 22 + 30(서울에서 출발지 통과) + 11
});

test('앱 모드: 세계여행 비용이 모자라면 주사위로 이동', () => {
  const room = appRoom();
  room.players[1].pos = 20;
  act(room, 'b', 'roll', { dice: [1, 3] });
  act(room, 'b', 'endTurn');
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  room.players[1].money = 5 * M;
  assert.throws(() => act(room, 'b', 'travelTo', { to: 5 }), /부족/);
  act(room, 'b', 'roll', { dice: [2, 3] });
  assert.strictEqual(room.players[1].pos, 29);
  assert.strictEqual(room.players[1].travel, false);
});

test('선생님 관리 방: 방장은 참여하지 않고 시작·되돌리기·잔액 수정만', () => {
  const room = g.createRoom('1', '선생님', 't', 'mixed', { play: false, title: '1조' });
  assert.strictEqual(room.players.length, 0);
  g.addPlayer(room, '민수', 'a');
  g.addPlayer(room, '지영', 'b');
  act(room, 'b', 'pickColor', { color: g.PIECES[1].color }); // 방장을 기다리지 않음
  act(room, 'a', 'pickColor', { color: g.PIECES[0].color });
  assert.throws(() => act(room, 'a', 'start'), /방장만/);
  act(room, 't', 'start');
  act(room, 'a', 'salary');
  assert.throws(() => act(room, 't', 'salary'), /플레이어/);
  act(room, 't', 'adjust', { playerId: 'b', money: 150 * M });
  act(room, 't', 'undo');
  assert.strictEqual(money(room, 'b'), 200 * M);
  act(room, 't', 'undo'); // 민수 월급도 선생님이 되돌릴 수 있음
  assert.strictEqual(money(room, 'a'), 200 * M);
  act(room, 't', 'end', { reason: 'time' });
  assert.strictEqual(room.status, 'ended');
});

test('앱 모드: 통행료를 내야 차례가 끝나고, 인수는 통행료 낸 도시만', () => {
  const room = appRoom();
  room.props[id('도쿄')] = { owner: 'a', built: {}, visits: 0 };
  room.players[1].pos = 7;
  act(room, 'b', 'roll', { dice: [1, 2] }); // → 10 도쿄 (엄마 땅)
  assert.strictEqual(room.turn.owe, 'toll');
  assert.throws(() => act(room, 'b', 'endTurn'), /통행료/);
  assert.throws(() => act(room, 'b', 'takeover', { tileId: id('도쿄') }), /통행료를 낸/);
  assert.throws(() => act(room, 'b', 'buy', { tileId: id('서울') }), /도착한 칸/);
  act(room, 'b', 'toll', { tileId: id('도쿄') });
  assert.throws(() => act(room, 'b', 'toll', { tileId: id('도쿄') }), /이미 통행료/);
  act(room, 'b', 'takeover', { tileId: id('도쿄') });
  assert.strictEqual(room.props[id('도쿄')].owner, 'b');
  act(room, 'b', 'endTurn');
  assert.strictEqual(room.turn.pid, 'a');
});

test('앱 모드: 세금은 꼭 내고, 마음대로 말 옮기기·송금·월급·되돌리기는 방장만', () => {
  const room = appRoom();
  room.players[1].pos = 27;
  act(room, 'b', 'roll', { dice: [1, 2] }); // → 30 국세청
  assert.throws(() => act(room, 'b', 'endTurn'), /세금/);
  assert.throws(() => act(room, 'b', 'move', { to: 31 }), /방장/);
  assert.throws(() => act(room, 'b', 'transfer', { to: 'a', amount: 10 * M }), /방장/);
  assert.throws(() => act(room, 'b', 'salary'), /방장/);
  assert.throws(() => act(room, 'b', 'undo'), /방장/);
  assert.throws(() => act(room, 'b', 'pay', { what: 'bail' }), /무인도/);
  act(room, 'b', 'pay', { what: 'tax' });
  assert.strictEqual(money(room, 'b'), 180 * M);
  // 방장은 잘못을 바로잡을 수 있음: 말 옮기기 → 그 칸에 도착한 것으로
  act(room, 'a', 'move', { playerId: 'b', to: 31 });
  assert.strictEqual(room.players[1].pos, 31);
  act(room, 'b', 'buy', { tileId: id('서울') });
  act(room, 'a', 'undo');
  act(room, 'a', 'undo');
  assert.strictEqual(room.players[1].pos, 30);
  act(room, 'b', 'endTurn');
});

test('앱 모드: 세계여행은 도착한 차례엔 못 떠나고 다음 차례에, 안 가고 주사위를 굴려도 됨', () => {
  const room = appRoom();
  room.players[1].pos = 20;
  act(room, 'b', 'roll', { dice: [1, 3] }); // 세계여행 도착 (더블 아님)
  assert.throws(() => act(room, 'b', 'travelTo', { to: 5 }), /다음 차례/);
  act(room, 'b', 'endTurn');
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  room.props[id('서울')] = { owner: 'a', built: {}, visits: 0 };
  act(room, 'b', 'travelTo', { to: 31 }); // 엄마 땅 서울로 → 통행료
  assert.strictEqual(room.turn.owe, 'toll');
  assert.throws(() => act(room, 'b', 'endTurn'), /통행료/);
  act(room, 'b', 'toll', { tileId: id('서울') });
  act(room, 'b', 'endTurn');
  // 다음에 또 세계여행에 서면, 이번엔 안 가고 주사위
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  room.players[1].pos = 20;
  act(room, 'b', 'roll', { dice: [1, 3] });
  act(room, 'b', 'endTurn');
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  act(room, 'b', 'roll', { dice: [2, 3] }); // 여행 안 함
  assert.strictEqual(room.players[1].pos, 29);
  assert.strictEqual(room.players[1].travel, false);
});

test('앱 모드: 더블로 세계여행에 서면 지금 여행하거나 한 번 더 굴림', () => {
  const room = appRoom();
  room.players[1].pos = 20;
  act(room, 'b', 'roll', { dice: [2, 2] }); // 더블로 세계여행 도착
  assert.strictEqual(room.turn.again, true);
  assert.throws(() => act(room, 'b', 'endTurn'), /더블/);
  act(room, 'b', 'travelTo', { to: 10 }); // 바로 도쿄로
  assert.strictEqual(room.players[1].pos, 10);
  act(room, 'b', 'buy', { tileId: id('도쿄') });
  assert.throws(() => act(room, 'b', 'endTurn'), /더블/); // 여행한 도시에서 한 번 더
  act(room, 'b', 'roll', { dice: [1, 2] });
  act(room, 'b', 'endTurn');
  // 여행 안 하고 한 번 더
  room.players[0].pos = 20;
  act(room, 'a', 'roll', { dice: [2, 2] });
  act(room, 'a', 'roll', { dice: [1, 2] });
  assert.strictEqual(room.players[0].pos, 27);
  assert.strictEqual(room.players[0].travel, false);
});

test('앱 모드: 뽑은 공격 카드는 그 카드만 쓰고, 도시기부는 꼭', () => {
  const room = appRoom();
  const pick = (key) => { const d = g.deck(room); return (d.indexOf(key) + 0.5) / d.length; };
  room.props[id('도쿄')] = { owner: 'a', built: { villa: true }, visits: 0 };
  room.props[id('서울')] = { owner: 'b', built: {}, visits: 0 };
  room.players[1].pos = 10;
  act(room, 'b', 'roll', { dice: [1, 1] }); // → 12 포춘카드
  act(room, 'b', 'draw', { pick: pick('donate') });
  assert.strictEqual(room.players[1].use, 'donate');
  assert.throws(() => act(room, 'b', 'quake', { tileId: id('도쿄') }), /지진 카드를 뽑았을 때만/);
  assert.throws(() => act(room, 'b', 'passCard'), /꼭/);
  assert.throws(() => act(room, 'b', 'roll', { dice: [1, 2] }), /도시기부/); // 더블 한 번 더 — 카드를 먼저 써야 함
  act(room, 'b', 'donate', { tileId: id('서울'), to: 'a' });
  assert.strictEqual(room.players[1].use, null);
  act(room, 'b', 'roll', { dice: [1, 2] });
  act(room, 'b', 'endTurn');
});

test('앱 모드: 세계여행은 도시로만 (특수칸·출발지 불가), 도착한 도시에서 건설', () => {
  const room = appRoom();
  room.props[id('도쿄')] = { owner: 'b', built: {}, visits: 0 };
  room.players[1].pos = 20;
  act(room, 'b', 'roll', { dice: [1, 3] });
  act(room, 'b', 'endTurn');
  act(room, 'a', 'roll', { dice: [1, 2] });
  act(room, 'a', 'endTurn');
  for (const pos of [0, 12, 8, 2, 16, 30]) assert.throws(() => act(room, 'b', 'travelTo', { to: pos }), /도시로만/);
  act(room, 'b', 'travelTo', { to: 10 }); // 출발지 지나 월급
  assert.strictEqual(money(room, 'b'), 220 * M);
  act(room, 'b', 'build', { tileId: id('도쿄'), items: ['villa'] });
  act(room, 'b', 'endTurn');
});

test('시간 종료: 마블 + 땅·건물 건설비용이 가장 많은 사람, 타이머는 방장만', () => {
  const room = setup();
  assert.throws(() => act(room, 'b', 'timer', { minutes: 30 }), /방장/);
  act(room, 'a', 'timer', { minutes: 30 });
  assert.ok(room.endAt > Date.now());
  act(room, 'b', 'buy', { tileId: id('서울'), items: ['villa'] }); // 30만 써도 자산은 그대로
  act(room, 'a', 'transfer', { to: 'bank', amount: 10 * M });
  act(room, 'a', 'end', { reason: 'time' });
  assert.strictEqual(room.result.winnerId, 'b');
  assert.match(room.result.detail, /200만/);
});

test('파산하면 보관 카드도 버림', () => {
  const room = appRoom();
  room.players[1].card = 'shield';
  act(room, 'b', 'bankrupt');
  assert.strictEqual(room.players[1].card, null);
});

test('앱 + 실물: 출발지를 지나 도착한 칸에서 거래하면 월급 자동, 턴도 올라감', () => {
  const room = setup();
  act(room, 'a', 'buy', { tileId: id('두바이') });
  act(room, 'a', 'buy', { tileId: id('퀘벡') });
  act(room, 'a', 'buy', { tileId: id('타히티') });
  assert.strictEqual(room.players[0].laps, 0);
  // 방콕(1)은 타히티(25)보다 앞 → 출발지를 지났음: 월급 +30만, 2번째 턴이라 빌딩까지
  act(room, 'a', 'buy', { tileId: id('방콕'), items: ['villa', 'building'] });
  assert.strictEqual(room.players[0].laps, 1);
  const auto = room.log.find((t) => t.auto);
  assert.ok(auto && /자동/.test(auto.text));
  // 돈이 모자라 거래가 안 되면 월급도 없던 일
  room.players[1].pos = 30;
  room.players[1].money = 1 * M;
  assert.throws(() => act(room, 'b', 'buy', { tileId: id('런던'), items: ['villa', 'building'] }), /부족/); // 월급 30만을 받아도 46만이 안 됨
  assert.strictEqual(room.players[1].laps, 0);
  assert.strictEqual(money(room, 'b'), 1 * M);
  // 월급 버튼을 누르면 출발지로 본 것 → 같은 바퀴에 두 번 안 줌
  room.players[1].money = 200 * M;
  act(room, 'b', 'salary');
  act(room, 'b', 'buy', { tileId: id('독도') });
  assert.strictEqual(room.players[1].laps, 1);
  // 무인도 탐험은 출발지를 지나도 월급 없음
  room.players[1].pos = 28;
  act(room, 'b', 'move', { to: 8, noSalary: true });
  assert.strictEqual(room.players[1].laps, 1);
});

test('랜드마크: 4번째 턴부터 빌라·빌딩·호텔과 함께 한 번에 지을 수 있음', () => {
  const room = setup();
  room.players[0].laps = 3;
  act(room, 'a', 'buy', { tileId: id('서울'), items: ['villa', 'building', 'hotel', 'landmark'] });
  assert.ok(room.props[id('서울')].built.landmark);
  assert.throws(() => act(room, 'a', 'buy', { tileId: id('뉴욕'), items: ['villa', 'landmark'] }), /빌라·빌딩·호텔/);
  room.players[1].laps = 2;
  assert.throws(() => act(room, 'b', 'buy', { tileId: id('뉴욕'), items: ['villa', 'building', 'hotel', 'landmark'] }), /3번째 턴/);
});

test('앱 모드: 공격받은 사람은 다른 사람 차례라도 방어 카드를 쓸지 고름, 안 쓰면 공격이 들어감', () => {
  const room = appRoom(); // 아빠(b) 차례, 방장은 엄마(a)
  room.props[id('로마')] = { owner: 'a', built: { villa: true }, visits: 0 };
  room.players[0].card = 'angel';
  room.players[1].use = 'quake';
  room.turn.rolled = true;
  act(room, 'b', 'quake', { tileId: id('로마') });
  assert.strictEqual(room.turn.awaitDefense.victim, 'a');
  assert.ok(room.props[id('로마')].built.villa); // 아직 안 들어감
  assert.throws(() => act(room, 'b', 'endTurn'), /고르는 중/);
  act(room, 'a', 'defend', { use: false });
  assert.ok(!room.props[id('로마')].built.villa); // 지진이 들어감
  assert.strictEqual(room.players[0].card, 'angel'); // 천사는 그대로
});
