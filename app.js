'use strict';

(() => {
  const MAN = 10000;
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');
  const $toasts = document.getElementById('toasts');

  // ---------- 상태 ----------
  let session = loadSession(); // { code, playerId, token, name }
  let state = null; // 서버에서 받은 방 상태
  let connected = false;
  let lastSeenTx = 0;
  let firstState = true;

  function loadSession() {
    try { return JSON.parse(localStorage.getItem('marble-session')) || null; } catch { return null; }
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem('marble-session', JSON.stringify(s));
      else localStorage.removeItem('marble-session');
    } catch {}
  }
  function lastName() {
    try { return localStorage.getItem('marble-name') || ''; } catch { return ''; }
  }

  // ---------- 유틸 ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmt(n) {
    const sign = n < 0 ? '-' : '';
    n = Math.abs(n);
    const eok = Math.floor(n / 1e8);
    const man = (n % 1e8) / MAN;
    const manStr = man.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
    if (eok && man) return `${sign}${eok}억 ${manStr}만`;
    if (eok) return `${sign}${eok}억`;
    if (n === 0) return '0';
    if (n < MAN) return n % 1000 === 0 ? `${sign}${n / 1000}천` : `${sign}${n.toLocaleString('ko-KR')}`;
    return `${sign}${manStr}만`;
  }
  function parseMan(v) {
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n * MAN) : NaN;
  }
  function me() {
    return state && state.players.find((p) => p.id === session.playerId);
  }
  function isHost() {
    return state && session && state.hostId === session.playerId;
  }
  function others(includeBankrupt) {
    return state.players.filter((p) => p.id !== session.playerId && (includeBankrupt || !p.bankrupt));
  }
  function pname(id) {
    const p = state.players.find((x) => x.id === id);
    return p ? p.name : '?';
  }
  function toast(msg, cls) {
    const el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    el.textContent = msg;
    $toasts.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
  function vibrate(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch {}
  }

  async function act(action) {
    if (!conn) throw new Error('아직 연결되지 않았습니다.');
    return conn.act(action);
  }

  // ---------- 연결 ----------
  let hostAlive = true;
  let conn = null;

  function disconnect() {
    if (conn) conn.close();
    conn = null;
  }

  function goHome(msg) {
    disconnect();
    saveSession(null);
    state = null;
    history.replaceState(null, '', location.pathname);
    if (msg) toast(msg, 'err');
    render();
  }

  // client: 방 만들기/참가에서 이미 연결된 브로커 연결(있으면 재사용)
  async function connect(client) {
    stopRoomWatch();
    disconnect();
    state = null;
    firstState = true;
    connected = false;
    render();
    const c = new MarbleNet.Connection(session, {
      onState,
      onStatus: (st) => {
        connected = st.connected;
        hostAlive = st.hostAlive;
        renderConn();
      },
      onClosed: () => goHome('방장이 방을 닫았습니다.'),
    });
    conn = c;
    try {
      await c.open(client);
    } catch (e) {
      if (conn !== c) return;
      if (e.data && e.data.code === 'NO_ROOM') return goHome(e.message);
      // 연결 실패: 잠시 뒤 다시 시도
      setTimeout(() => { if (conn === c && session) connect(); }, 3000);
    }
  }

  function onState(s) {
    const prevStatus = state && state.status;
    state = s;
    if (!me()) return goHome('방에서 나가게 되었습니다.');
    // 새 거래 알림 (내 돈이 바뀐 거래)
    const newest = s.log.length ? s.log[s.log.length - 1].id : 0;
    if (!firstState) {
      for (const tx of s.log) {
        if (tx.id <= lastSeenTx) continue;
        const d = tx.deltas[session.playerId];
        if (d && tx.actorId !== session.playerId && tx.kind !== 'start') {
          toast(`${d > 0 ? '+' : ''}${fmt(d)} · ${tx.text}`, d > 0 ? 'plus' : 'minus');
          vibrate(d > 0 ? [60, 40, 60] : 200);
        }
      }
      if (prevStatus === 'playing' && s.status === 'ended') vibrate([100, 50, 100, 50, 200]);
    }
    lastSeenTx = newest;
    firstState = false;
    render();
  }

  // ---------- 화면 ----------
  function render() {
    if (!session) return renderHome();
    if (!state) {
      $app.innerHTML = `${topbar()}<div class="wrap"><div class="card center">연결 중...</div>
        <button class="btn secondary" id="bk">처음으로</button></div>`;
      $app.querySelector('#bk').onclick = () => goHome();
      return;
    }
    if (state.status === 'lobby') return renderLobby();
    if (state.status === 'playing') return renderGame();
    return renderEnded();
  }

  function topbar() {
    const code = session ? session.code : '';
    return `<div class="topbar"><h1>🎲 모두의 마블 은행</h1>
      <div class="row" style="flex:none;align-items:center;gap:6px">
        <span id="conn">${connHtml()}</span>
        ${code ? `<button class="code" id="share">${esc(code)}</button>` : ''}
      </div></div>`;
  }
  function connHtml() {
    if (!session || !state) return '';
    if (!connected) return '<span class="conn">재연결 중</span>';
    if (!hostAlive) return '<span class="conn">방장 연결 끊김</span>';
    return '';
  }
  function renderConn() {
    const el = document.getElementById('conn');
    if (el) el.innerHTML = connHtml();
  }
  function bindShare() {
    const b = document.getElementById('share');
    if (b) b.onclick = share;
  }
  async function share() {
    const url = MarbleNet.shareUrl(session);
    const text = `모두의 마블 은행 방 번호: ${session.code}\n${url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: '모두의 마블 은행', text, url });
        return;
      }
    } catch { return; }
    try {
      await navigator.clipboard.writeText(url);
      toast('참가 링크를 복사했습니다.');
    } catch {
      prompt('이 링크를 보내세요', url);
    }
  }

  // 처음 화면: 방 만들기 / 참가
  function renderHome() {
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room') || '';
    $app.innerHTML = `${topbar()}<div class="wrap">
      <div class="hero"><div class="logo">🎲💰</div><h1>모두의 마블 은행</h1>
        <p>보드게임 돈 계산을 각자 휴대폰으로!</p></div>
      <div class="card">
        <label class="field"><span>내 이름</span><input type="text" id="name" maxlength="12" placeholder="예: 엄마" value="${esc(lastName())}"></label>
      </div>
      <div class="card">
        <h2>열려 있는 방</h2>
        <div id="rooms"></div>
      </div>
      <div class="card">
        <h2>방 번호로 참가하기</h2>
        <label class="field"><span>방 번호 (4자리)</span><input type="tel" id="code" inputmode="numeric" maxlength="4" placeholder="1234" value="${esc(roomParam)}"></label>
        <button class="btn" id="join">참가하기</button>
      </div>
      <div class="card">
        <h2>새 방 만들기 <small>· 방장이 됩니다</small></h2>
        <button class="btn accent" id="create">방 만들기</button>
      </div>
      <div class="err center" id="err"></div>
      <button class="btn secondary" id="rules">규칙 보기</button>
    </div>`;
    const $name = $app.querySelector('#name');
    const $err = $app.querySelector('#err');
    const busy = (on, msg) => {
      $app.querySelectorAll('button').forEach((b) => (b.disabled = on));
      $err.textContent = on ? msg : '';
    };
    const getName = () => {
      const n = $name.value.trim();
      if (!n) { $err.textContent = '이름을 입력해 주세요.'; $name.focus(); return null; }
      try { localStorage.setItem('marble-name', n); } catch {}
      return n;
    };
    $app.querySelector('#create').onclick = async () => {
      const name = getName(); if (!name) return;
      try {
        busy(true, '방을 만드는 중...');
        const r = await MarbleNet.createRoom(name, loadTemplate());
        saveSession(r.session);
        history.replaceState(null, '', MarbleNet.shareUrl(r.session));
        connect(r.client);
      } catch (e) { busy(false); $err.textContent = e.message; }
    };
    joinFromHome = async (code, broker) => {
      const name = getName(); if (!name) return;
      try {
        busy(true, '방에 들어가는 중...');
        const r = await MarbleNet.joinRoom(code, name, broker);
        saveSession(r.session);
        history.replaceState(null, '', MarbleNet.shareUrl(r.session));
        connect(r.client);
      } catch (e) { busy(false); $err.textContent = e.message; renderRoomList(); }
    };
    $app.querySelector('#join').onclick = () => {
      const code = $app.querySelector('#code').value.trim();
      if (!/^\d{4}$/.test(code)) { $err.textContent = '방 번호 4자리를 입력해 주세요.'; return; }
      joinFromHome(code, MarbleNet.brokerFromIndex(params.get('b')));
    };
    $app.querySelector('#rules').onclick = showRules;
    startRoomWatch();
    renderRoomList();
  }
  let joinFromHome = () => {};

  function settingsRows(s) {
    return [
      ['시작 자금', fmt(s.startMoney) + ' 마블'],
      ['월급 (출발지 통과)', fmt(s.salary) + ' 마블'],
      ['무인도 보석금', fmt(s.bail) + ' 마블'],
      ['컬러 독점 통행료', '×' + s.monopolyMultiplier],
      ['올림픽 통행료', '×' + s.olympicMultiplier + ' (개최할 때마다)'],
      ['인수 가격', '건설가 ×' + s.takeoverMultiplier],
      ['은행 매각', s.sellRate + '%'],
    ];
  }

  // 대기실
  function renderLobby() {
    const host = isHost();
    $app.innerHTML = `${topbar()}<div class="wrap">
      <div class="card center">
        <div class="muted">방 번호</div>
        <div class="bigcode">${esc(state.code)}</div>
        <div class="muted">다른 사람은 이 번호로 참가하세요</div>
        <button class="btn secondary mt" id="share2">📤 참가 링크 보내기</button>
      </div>
      <div class="card">
        <h2>참가자 ${state.players.length}/4</h2>
        <ul class="plist">${state.players.map((p) => `<li>
          <span class="dot" style="background:${p.color}"></span>
          <span class="name">${esc(p.name)}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${p.id === session.playerId ? '<span class="tag">나</span>' : ''}</span>
          ${host && p.id !== state.hostId ? `<button class="link" data-kick="${p.id}">내보내기</button>` : ''}
        </li>`).join('')}</ul>
      </div>
      <div class="card">
        <h2>게임 설정 ${host ? '<small>· 방장만 변경 가능</small>' : ''}</h2>
        <ul class="plist">${settingsRows(state.settings).map(([k, v]) => `<li><span class="name">${k}</span><span>${v}</span></li>`).join('')}</ul>
        ${host ? '<button class="btn secondary mt" id="edit">설정 바꾸기</button>' : ''}
      </div>
      <div class="card">
        <h2>🗺️ 도시 가격표</h2>
        ${hasBoard()
          ? `<div>도시 ${board().filter((t) => t.kind === 'city').length}곳 · 관광지 ${board().filter((t) => t.kind === 'tour').length}곳</div>
             <div class="muted">칸만 누르면 구매·건설비, 통행료, 인수 가격이 자동 계산돼요.</div>`
          : `<div class="muted">비어 있어요. ${host ? '도시 카드에 적힌 가격을 한 번 입력해 두면 자동 계산이 돼요. (이 기기에 저장되어 다음에도 쓰여요)' : '방장이 입력하면 자동 계산이 돼요.'} 비어 있으면 금액을 직접 입력해서 계산해요.</div>`}
        <button class="btn secondary mt" id="boardBtn">${host ? '가격표 입력·수정' : '가격표 보기'}</button>
      </div>
      ${host
        ? `<button class="btn accent" id="start" ${state.players.length < 2 ? 'disabled' : ''}>게임 시작 (모두 ${fmt(state.settings.startMoney)} 지급)</button>`
        : '<div class="card center muted">방장이 게임을 시작하기를 기다리는 중...</div>'}
      ${host ? '<div class="card muted">📱 방장 기기가 은행 역할을 해요. 게임하는 동안 <b>방장 휴대폰은 이 화면을 켜 둔 채로</b> 두세요. 잠깐 꺼져도 다시 켜면 이어집니다.</div>' : ''}
      <button class="btn secondary mt" id="leave">나가기</button>
    </div>`;
    bindShare();
    $app.querySelector('#share2').onclick = share;
    $app.querySelector('#boardBtn').onclick = boardEditor;
    $app.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = () => confirmBox(`${pname(b.dataset.kick)}님을 내보낼까요?`, () => act({ type: 'kick', playerId: b.dataset.kick }));
    });
    if (host) {
      $app.querySelector('#edit').onclick = editSettings;
      $app.querySelector('#start').onclick = () => run(() => act({ type: 'start' }));
    }
    $app.querySelector('#leave').onclick = () => confirmBox('방에서 나갈까요?', async () => {
      if (conn) await conn.leave();
      goHome();
    });
  }

  // 게임 화면
  function renderGame() {
    const m = me();
    const s = state.settings;
    const host = isHost();
    const sorted = [...state.players];
    $app.innerHTML = `${topbar()}<div class="wrap">
      <div class="me ${m.bankrupt ? 'bankrupt' : ''}" style="background:${m.color}">
        <div class="who">${esc(m.name)}${host ? ' · 방장' : ''}${m.bankrupt ? ' · 파산' : ''}</div>
        <div class="bal">${fmt(m.money)} <small>마블</small></div>
      </div>
      ${m.bankrupt ? '<div class="card center muted">파산했습니다. 다른 사람들의 게임을 지켜보세요.</div>' : `
      ${hasBoard() ? '<button class="btn accent big" id="arrive">🗺️ 도착한 칸 고르기<small>구매 · 건설 · 통행료 · 인수 자동 계산</small></button>' : ''}
      <div class="actions">
        <button class="act" data-a="salary"><span class="ic">🏁</span>월급<small>+${fmt(s.salary)}</small></button>
        <button class="act" data-a="toll"><span class="ic">🧾</span>통행료<small>내기</small></button>
        <button class="act" data-a="takeover"><span class="ic">🤝</span>인수<small>건설가×${s.takeoverMultiplier}</small></button>
        <button class="act" data-a="buy"><span class="ic">🏠</span>구매·건설<small>은행에 내기</small></button>
        <button class="act" data-a="bail"><span class="ic">🏝️</span>보석금<small>-${fmt(s.bail)}</small></button>
        <button class="act" data-a="payBank"><span class="ic">🏦</span>은행에<small>내기</small></button>
        <button class="act" data-a="receiveBank"><span class="ic">🎁</span>은행에서<small>받기</small></button>
        <button class="act" data-a="transfer"><span class="ic">💸</span>송금<small>플레이어에게</small></button>
        <button class="act" data-a="sell"><span class="ic">🏚️</span>매각<small>${s.sellRate}% 받기</small></button>
      </div>`}
      ${m.bankrupt ? '' : myTilesHtml()}
      <div class="card">
        <h2>모든 플레이어</h2>
        <ul class="plist">${sorted.map((p) => `<li>
          <span class="dot" style="background:${p.color}"></span>
          <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${p.id === session.playerId ? '<span class="tag">나</span>' : ''}${p.bankrupt ? '<span class="tag">파산</span>' : ''}</span>
          ${hasBoard() && !p.bankrupt ? `<span class="muted">땅 ${myTiles(p.id).length}${monopolyCount(p.id) ? ` · 독점 ${monopolyCount(p.id)}` : ''}</span>` : ''}
          <span class="money">${fmt(p.money)}</span>
        </li>`).join('')}</ul>
      </div>
      <div class="card">
        <h2>거래 기록</h2>
        ${logHtml()}
      </div>
      ${host ? `<div class="card"><h2>방장 메뉴</h2>
        <button class="btn secondary" id="boardEdit">🗺️ 도시 가격표 입력·수정</button>
        <button class="btn secondary mt" id="adjust">잔액 직접 수정</button>
        <button class="btn secondary mt" id="hbk">다른 플레이어 파산 처리</button>
        <button class="btn mt" id="end">🏆 승리 선언 / 게임 종료</button>
      </div>` : ''}
      ${m.bankrupt ? '' : '<button class="btn danger" id="bankrupt">파산하기</button>'}
      ${!host && hasBoard() ? '<button class="btn secondary mt" id="boardView">🗺️ 가격표 보기</button>' : ''}
      <button class="btn secondary mt" id="rules">규칙 보기</button>
      <div style="height:24px"></div>
    </div>`;
    bindShare();
    bindLog();
    const AUTO = ['toll', 'takeover', 'buy', 'sell'];
    $app.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => (hasBoard() && AUTO.includes(b.dataset.a) ? tilePicker() : ACTIONS[b.dataset.a]())));
    $app.querySelectorAll('[data-tile]').forEach((b) => (b.onclick = () => tileSheet(b.dataset.tile)));
    const q = (id) => $app.querySelector(id);
    if (q('#arrive')) q('#arrive').onclick = tilePicker;
    if (q('#boardView')) q('#boardView').onclick = boardEditor;
    if (q('#boardEdit')) q('#boardEdit').onclick = boardEditor;
    q('#rules').onclick = showRules;
    if (q('#bankrupt')) q('#bankrupt').onclick = () => bankruptDialog();
    if (host) {
      q('#adjust').onclick = adjustDialog;
      q('#hbk').onclick = hostBankruptDialog;
      q('#end').onclick = endDialog;
    }
  }

  function logHtml() {
    const items = [...state.log].reverse().slice(0, 60);
    if (!items.length) return '<div class="muted">아직 거래가 없습니다.</div>';
    const host = isHost();
    return `<ul class="log">${items.map((tx) => {
      const d = tx.deltas[session.playerId];
      const canUndo = (state.status === 'playing' || (state.status === 'ended' && tx.endsGame)) && !tx.undone && !tx.noUndo && (tx.actorId === session.playerId || host);
      const time = new Date(tx.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      return `<li class="${tx.undone ? 'undone' : ''}">
        <span class="t ${d ? 'mine' : ''}">${esc(tx.text)}${d && !tx.undone ? ` <span style="color:var(--${d > 0 ? 'plus' : 'minus'})">(${d > 0 ? '+' : ''}${fmt(d)})</span>` : ''}</span>
        <span class="time">${time}</span>
        ${canUndo ? `<button class="undo" data-undo="${tx.id}">취소</button>` : ''}
      </li>`;
    }).join('')}</ul>`;
  }
  function bindLog() {
    $app.querySelectorAll('[data-undo]').forEach((b) => {
      const tx = state.log.find((t) => t.id === Number(b.dataset.undo));
      b.onclick = () => confirmBox(`이 거래를 취소할까요?\n\n${tx ? tx.text : ''}`, () => act({ type: 'undo', txId: Number(b.dataset.undo) }));
    });
  }

  function renderEnded() {
    const r = state.result || {};
    const ranking = [...state.players].sort((a, b) => (a.id === r.winnerId ? -1 : b.id === r.winnerId ? 1 : (a.bankrupt - b.bankrupt) || b.money - a.money));
    $app.innerHTML = `${topbar()}<div class="wrap">
      <div class="card winner"><div class="trophy">🏆</div>
        <h2>${esc(pname(r.winnerId))} 승리!</h2><div class="muted">${esc(r.reason || '')}</div></div>
      <div class="card"><h2>최종 결과</h2>
        <ul class="plist">${ranking.map((p, i) => `<li><b>${i + 1}</b><span class="dot" style="background:${p.color}"></span>
          <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}</span><span class="money">${p.bankrupt ? '파산' : fmt(p.money)}</span></li>`).join('')}</ul>
      </div>
      <div class="card"><h2>거래 기록</h2>${logHtml()}</div>
      ${state.log.some((t) => t.endsGame && !t.undone) ? '<div class="muted center">잘못 끝났다면 게임을 끝낸 거래를 "취소"하면 이어서 할 수 있어요.</div>' : ''}
      ${isHost() ? '<button class="btn accent" id="again">같은 사람들과 다시 하기</button>' : ''}
      <button class="btn secondary mt" id="home">처음으로</button>
    </div>`;
    bindShare();
    bindLog();
    if (isHost()) $app.querySelector('#again').onclick = () => confirmBox('새 게임을 준비할까요? (기록이 지워집니다)', () => act({ type: 'reset' }));
    $app.querySelector('#home').onclick = () => {
      if (isHost()) confirmBox('방을 닫을까요? 다른 사람들도 방에서 나가게 됩니다.', async () => { if (conn) await conn.leave(); goHome(); });
      else goHome();
    };
  }

  // ---------- 모달 ----------
  function openModal(html, onMount) {
    $modal.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
    const bg = $modal.firstElementChild;
    bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
    const root = bg.firstElementChild;
    root.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
    onMount && onMount(root);
    return root;
  }
  function closeModal() { $modal.innerHTML = ''; }

  function confirmBox(msg, onYes, yesLabel) {
    openModal(`<h3 style="white-space:pre-line;font-size:18px">${esc(msg)}</h3>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>아니요</button><button class="btn" id="yes">${esc(yesLabel || '네')}</button></div>`,
    (root) => {
      root.querySelector('#yes').onclick = async () => {
        try { await onYes(); closeModal(); } catch (e) { handleError(e, root); }
      };
    });
  }

  // 잔액 부족 시: 매각하거나 파산
  function handleError(e, root, creditorId) {
    if (e.data && e.data.code === 'INSUFFICIENT') {
      openModal(`<h3>잔액이 부족해요 😥</h3>
        <p>${fmt(e.data.shortfall)} 마블이 부족합니다.<br>땅이나 건물을 은행에 팔아 돈을 마련하거나, 파산해야 합니다.</p>
        <button class="btn accent" id="s">🏚️ 매각해서 돈 마련하기</button>
        <button class="btn danger mt" id="b">파산하기</button>
        <button class="btn secondary mt" data-close>취소</button>`,
      (r) => {
        r.querySelector('#s').onclick = () => (hasBoard() && myTiles(session.playerId).length ? tilePicker() : ACTIONS.sell());
        r.querySelector('#b').onclick = () => bankruptDialog(creditorId);
      });
      return;
    }
    const el = root && root.querySelector('#err');
    if (el) el.textContent = e.message; else toast(e.message, 'err');
  }

  async function run(fn, root, creditorId) {
    try {
      await fn();
      closeModal();
      return true;
    } catch (e) {
      handleError(e, root, creditorId);
      return false;
    }
  }

  function amountInput(id, label, chips) {
    const c = chips || [1, 5, 10, 50, 100];
    return `<div class="sub">${label}</div>
      <div class="amount"><input type="number" inputmode="decimal" min="0" step="any" id="${id}" placeholder="0"><span class="unit">만 마블</span></div>
      <div class="chips mt">${c.map((v) => `<button class="chip" data-add="${id}" data-v="${v}">+${v}만</button>`).join('')}<button class="chip" data-clear="${id}">지우기</button></div>`;
  }
  function bindAmount(root, onChange) {
    root.querySelectorAll('[data-add]').forEach((b) => {
      b.onclick = () => {
        const inp = root.querySelector('#' + b.dataset.add);
        const cur = Number(inp.value) || 0;
        inp.value = Math.round((cur + Number(b.dataset.v)) * 10) / 10;
        onChange && onChange();
      };
    });
    root.querySelectorAll('[data-clear]').forEach((b) => {
      b.onclick = () => { root.querySelector('#' + b.dataset.clear).value = ''; onChange && onChange(); };
    });
    root.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => onChange && onChange()));
  }
  function playerChips(name, list, selected) {
    return `<div class="chips">${list.map((p) => `<button class="chip pchip ${p.id === selected ? 'on' : ''}" data-${name}="${p.id}">
      <span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>`;
  }
  function bindChoice(root, name, onPick) {
    const btns = root.querySelectorAll(`[data-${name}]`);
    btns.forEach((b) => {
      b.onclick = () => {
        btns.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onPick(b.dataset[name]);
      };
    });
  }

  const ACTIONS = {
    salary() {
      confirmBox(`출발지를 지나 월급 ${fmt(state.settings.salary)} 마블을 받을까요?`, () => act({ type: 'salary' }), '받기');
    },

    bail() {
      confirmBox(`무인도 보석금 ${fmt(state.settings.bail)} 마블을 내고 탈출할까요?`, () => act({ type: 'bail' }), '내기');
    },

    toll() {
      const list = others();
      if (!list.length) return toast('다른 플레이어가 없습니다.', 'err');
      let to = list.length === 1 ? list[0].id : null;
      let olympics = 0;
      const s = state.settings;
      openModal(`<h3>🧾 통행료 내기</h3>
        <div class="sub">누구의 땅인가요?</div>
        ${playerChips('to', list, to)}
        ${amountInput('base', '땅 카드에 적힌 통행료 (지어진 건물 기준 합계)')}
        <label class="check"><input type="checkbox" id="mono"> 컬러 독점 도시 (×${s.monopolyMultiplier})</label>
        <div class="check" style="justify-content:space-between"><span>올림픽 개최 횟수 (×${s.olympicMultiplier}씩)</span>
          <span class="stepper"><button id="om">−</button><b id="ov">0</b><button id="op">+</button></span></div>
        <div class="preview"><span>낼 금액</span><b id="pv">0</b></div>
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">내기</button></div>`,
      (root) => {
        const calc = () => {
          const base = parseMan(root.querySelector('#base').value) || 0;
          let mult = 1;
          if (root.querySelector('#mono').checked) mult *= s.monopolyMultiplier;
          mult *= Math.pow(s.olympicMultiplier, olympics);
          root.querySelector('#pv').textContent = fmt(Math.round(base * mult));
          root.querySelector('#ov').textContent = olympics;
        };
        bindAmount(root, calc);
        bindChoice(root, 'to', (v) => (to = v));
        root.querySelector('#mono').onchange = calc;
        root.querySelector('#om').onclick = () => { olympics = Math.max(0, olympics - 1); calc(); };
        root.querySelector('#op').onclick = () => { olympics = Math.min(5, olympics + 1); calc(); };
        root.querySelector('#ok').onclick = () => {
          if (!to) return (root.querySelector('#err').textContent = '땅 주인을 골라 주세요.');
          run(() => act({ type: 'toll', to, base: parseMan(root.querySelector('#base').value), monopoly: root.querySelector('#mono').checked, olympics }), root, to);
        };
      });
    },

    takeover() {
      const list = others();
      if (!list.length) return toast('다른 플레이어가 없습니다.', 'err');
      let to = list.length === 1 ? list[0].id : null;
      const k = state.settings.takeoverMultiplier;
      openModal(`<h3>🤝 인수하기</h3>
        <div class="sub">통행료를 낸 뒤, 원하면 그 땅을 인수할 수 있어요. 랜드마크가 있는 도시는 인수할 수 없어요.</div>
        <div class="sub mt">누구의 땅인가요?</div>
        ${playerChips('to', list, to)}
        ${amountInput('val', '현재 건설가 (땅 + 지어진 건물 가격의 합)')}
        <div class="preview"><span>인수 금액 (×${k})</span><b id="pv">0</b></div>
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">인수하기</button></div>`,
      (root) => {
        const calc = () => {
          root.querySelector('#pv').textContent = fmt(Math.round((parseMan(root.querySelector('#val').value) || 0) * k));
        };
        bindAmount(root, calc);
        bindChoice(root, 'to', (v) => (to = v));
        root.querySelector('#ok').onclick = () => {
          if (!to) return (root.querySelector('#err').textContent = '땅 주인을 골라 주세요.');
          run(() => act({ type: 'takeover', to, value: parseMan(root.querySelector('#val').value) }), root, to);
        };
      });
    },

    buy() {
      bankDialog('🏠 구매·건설', ['땅 구매', '빌라 건설', '빌딩 건설', '호텔 건설', '랜드마크 건설', '관광지 구매'], 'payBank');
    },
    payBank() {
      bankDialog('🏦 은행에 내기', ['세금(국세청)', '찬스카드', '올림픽 개최', '세계여행', '기타'], 'payBank');
    },
    receiveBank() {
      bankDialog('🎁 은행에서 받기', ['찬스카드', '기타'], 'receiveBank');
    },

    transfer() {
      const list = others();
      if (!list.length) return toast('다른 플레이어가 없습니다.', 'err');
      let to = list.length === 1 ? list[0].id : null;
      openModal(`<h3>💸 송금하기</h3>
        <div class="sub">받는 사람</div>
        ${playerChips('to', list, to)}
        ${amountInput('amt', '금액')}
        <label class="field mt"><span>메모 (선택)</span><input type="text" id="memo" maxlength="30" placeholder="예: 찬스카드"></label>
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">보내기</button></div>`,
      (root) => {
        bindAmount(root);
        bindChoice(root, 'to', (v) => (to = v));
        root.querySelector('#ok').onclick = () => {
          if (!to) return (root.querySelector('#err').textContent = '받는 사람을 골라 주세요.');
          run(() => act({ type: 'transfer', to, amount: parseMan(root.querySelector('#amt').value), reason: root.querySelector('#memo').value }), root, to);
        };
      });
    },

    sell() {
      const rate = state.settings.sellRate;
      openModal(`<h3>🏚️ 은행에 매각</h3>
        <div class="sub">돈이 부족할 때 내 땅·건물을 은행에 팔아요. 팔린 땅은 보드에서 내 표시를 치워 주세요.</div>
        <label class="field mt"><span>도시 이름 (선택)</span><input type="text" id="city" maxlength="12"></label>
        ${amountInput('val', '매각할 땅·건물의 건설가 합계')}
        <div class="preview"><span>받을 금액 (${rate}%)</span><b id="pv">0</b></div>
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">매각하기</button></div>`,
      (root) => {
        const calc = () => {
          root.querySelector('#pv').textContent = fmt(Math.floor(((parseMan(root.querySelector('#val').value) || 0) * rate) / 100));
        };
        bindAmount(root, calc);
        root.querySelector('#ok').onclick = () =>
          run(() => act({ type: 'sell', value: parseMan(root.querySelector('#val').value), city: root.querySelector('#city').value }), root);
      });
    },
  };

  function bankDialog(title, reasons, type) {
    let reason = reasons[0];
    openModal(`<h3>${title}</h3>
      <div class="sub">항목</div>
      <div class="chips">${reasons.map((r, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
      ${amountInput('amt', '금액 (카드에 적힌 가격)')}
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">${type === 'payBank' ? '내기' : '받기'}</button></div>`,
    (root) => {
      bindAmount(root);
      bindChoice(root, 'r', (v) => (reason = v));
      root.querySelector('#ok').onclick = () =>
        run(() => act({ type, amount: parseMan(root.querySelector('#amt').value), reason }), root);
    });
  }

  function bankruptDialog(creditorId) {
    const list = others();
    let to = creditorId || '';
    const m = me();
    openModal(`<h3>☠️ 파산하기</h3>
      <p>파산하면 게임에서 빠집니다. 남은 돈 ${fmt(m.money)}은(는) 빚진 상대에게 넘어가고, 부족한 금액은 내지 않습니다.
      가지고 있던 땅과 건물은 보드에서 치워 주세요.</p>
      <div class="sub">누구에게 빚을 졌나요?</div>
      <div class="chips"><button class="chip ${to ? '' : 'on'}" data-to="">🏦 은행</button>
      ${list.map((p) => `<button class="chip pchip ${p.id === to ? 'on' : ''}" data-to="${p.id}"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn danger" id="ok">파산</button></div>`,
    (root) => {
      bindChoice(root, 'to', (v) => (to = v));
      root.querySelector('#ok').onclick = () => run(() => act({ type: 'bankrupt', to: to || undefined }), root);
    });
  }

  function hostBankruptDialog() {
    const list = others();
    if (!list.length) return;
    let who = null;
    let to = '';
    openModal(`<h3>다른 플레이어 파산 처리</h3>
      <div class="sub">파산할 사람</div>
      ${playerChips('who', list, null)}
      <div class="sub">남은 돈을 받을 사람</div>
      <div class="chips"><button class="chip on" data-to="">🏦 은행</button>
      ${state.players.filter((p) => !p.bankrupt).map((p) => `<button class="chip pchip" data-to="${p.id}"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn danger" id="ok">파산 처리</button></div>`,
    (root) => {
      bindChoice(root, 'who', (v) => (who = v));
      bindChoice(root, 'to', (v) => (to = v));
      root.querySelector('#ok').onclick = () => {
        if (!who) return (root.querySelector('#err').textContent = '파산할 사람을 골라 주세요.');
        if (to === who) return (root.querySelector('#err').textContent = '같은 사람을 고를 수 없습니다.');
        run(() => act({ type: 'bankrupt', playerId: who, to: to || undefined }), root);
      };
    });
  }

  function adjustDialog() {
    let who = null;
    openModal(`<h3>잔액 직접 수정</h3>
      <div class="sub">실수를 바로잡을 때만 쓰세요. 기록에 남습니다.</div>
      ${playerChips('who', state.players, null)}
      ${amountInput('amt', '새 잔액', [10, 50, 100])}
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">수정</button></div>`,
    (root) => {
      bindAmount(root);
      bindChoice(root, 'who', (v) => {
        who = v;
        root.querySelector('#amt').value = state.players.find((p) => p.id === v).money / MAN;
      });
      root.querySelector('#ok').onclick = () => {
        if (!who) return (root.querySelector('#err').textContent = '사람을 골라 주세요.');
        run(() => act({ type: 'adjust', playerId: who, money: parseMan(root.querySelector('#amt').value) }), root);
      };
    });
  }

  function endDialog() {
    let who = null;
    let reason = 'triple';
    openModal(`<h3>🏆 승리 선언</h3>
      <div class="sub">승리 조건</div>
      <div class="chips">
        <button class="chip on" data-r="triple">트리플 독점</button>
        <button class="chip" data-r="line">라인 독점</button>
        <button class="chip" data-r="tour">관광지 독점</button>
        <button class="chip" data-r="other">기타 종료</button>
      </div>
      <div class="sub">승리한 사람</div>
      ${playerChips('who', state.players.filter((p) => !p.bankrupt), null)}
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn accent" id="ok">게임 종료</button></div>`,
    (root) => {
      bindChoice(root, 'r', (v) => (reason = v));
      bindChoice(root, 'who', (v) => (who = v));
      root.querySelector('#ok').onclick = () => {
        if (!who) return (root.querySelector('#err').textContent = '승리한 사람을 골라 주세요.');
        run(() => act({ type: 'end', winnerId: who, reason }), root);
      };
    });
  }

  function editSettings() {
    const s = state.settings;
    const f = (id, label, val, unit) => `<label class="field"><span>${label}</span>
      <div class="amount"><input type="number" inputmode="decimal" step="any" id="${id}" value="${val}"><span class="unit">${unit}</span></div></label>`;
    openModal(`<h3>게임 설정</h3>
      <div class="sub">기본값은 모두의 마블 보드게임 규칙 기준이에요. 가진 게임 설명서와 다르면 바꿔 주세요.</div>
      ${f('startMoney', '시작 자금', s.startMoney / MAN, '만')}
      ${f('salary', '월급 (출발지 통과)', s.salary / MAN, '만')}
      ${f('bail', '무인도 보석금', s.bail / MAN, '만')}
      ${f('monopolyMultiplier', '컬러 독점 통행료 배수', s.monopolyMultiplier, '배')}
      ${f('olympicMultiplier', '올림픽 통행료 배수', s.olympicMultiplier, '배')}
      ${f('takeoverMultiplier', '인수 가격 배수', s.takeoverMultiplier, '배')}
      ${f('sellRate', '은행 매각 시 받는 비율', s.sellRate, '%')}
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" id="def">기본값</button><button class="btn" id="ok">저장</button></div>`,
    (root) => {
      const v = (id) => Number(root.querySelector('#' + id).value);
      root.querySelector('#def').onclick = () =>
        run(() => act({ type: 'updateSettings', settings: { startMoney: 200 * MAN, salary: 30 * MAN, bail: 20 * MAN, monopolyMultiplier: 2, olympicMultiplier: 2, takeoverMultiplier: 2, sellRate: 50 } }), root);
      root.querySelector('#ok').onclick = () =>
        run(() => act({ type: 'updateSettings', settings: {
          startMoney: Math.round(v('startMoney') * MAN),
          salary: Math.round(v('salary') * MAN),
          bail: Math.round(v('bail') * MAN),
          monopolyMultiplier: v('monopolyMultiplier'),
          olympicMultiplier: v('olympicMultiplier'),
          takeoverMultiplier: v('takeoverMultiplier'),
          sellRate: v('sellRate'),
        } }), root);
    });
  }

  function showRules() {
    openModal(`<h3>📖 돈 관련 규칙</h3>
      <div class="rules">
        <b>준비</b><ul><li>2~4명. 모두 <b>200만 마블</b>씩 받고 시작합니다.</li><li>보드·말·주사위·카드는 실물로, 돈만 이 앱으로 주고받습니다.</li></ul>
        <b>월급</b><ul><li>출발지를 <b>지나갈 때마다 30만 마블</b> (세계여행으로 출발지를 지나도 받음).</li>
          <li>순간이동 카드로 출발지를 거치지 않으면 받지 않습니다.</li></ul>
        <b>땅·건물</b><ul><li>빈 땅에 도착하면 카드에 적힌 가격으로 구매하고 빌라·빌딩·호텔을 지을 수 있습니다 → <b>구매·건설</b>.</li>
          <li>빌라·빌딩·호텔이 모두 지어진 내 도시에 다시 오면 랜드마크를 지을 수 있습니다.</li></ul>
        <b>통행료</b><ul><li>다른 사람 땅에 도착하면 카드의 통행료(지어진 건물 기준)를 땅 주인에게 냅니다.</li>
          <li>같은 색 도시를 모두 가지면(컬러 독점) <b>통행료 2배</b>, 올림픽이 열린 도시는 <b>배수가 추가</b>되고 효과는 겹칩니다.</li></ul>
        <b>인수</b><ul><li>통행료를 낸 뒤 그 땅을 <b>현재 건설가의 2배</b>를 주인에게 주고 인수할 수 있습니다.</li>
          <li><b>랜드마크가 있는 도시는 인수할 수 없습니다.</b> 인수한 뒤에는 추가로 건물을 지을 수 있습니다.</li></ul>
        <b>🗺️ 도시 가격표 (자동 계산)</b><ul><li>방장이 도시 카드에 적힌 건설비와 통행료를 한 번 입력해 두면, 칸을 눌러 구매·건설·통행료·인수·매각을 자동으로 계산해요.</li>
          <li>통행료 = 지어진 것(땅·빌라·빌딩·호텔·랜드마크)의 통행료 합 × 컬러 독점 × 올림픽</li>
          <li>트리플·라인·관광지 독점이 되면 자동으로 승리 처리돼요.</li>
          <li>관광지: 땅·파라솔·방갈로 각 10만, 통행료는 지어진 단계에 따라 8만 → 16만 → 32만. 관광지는 인수할 수 없어요.</li></ul>
        <b>무인도</b><ul><li>3턴 동안 갇힙니다. 더블이 나오거나, <b>보석금</b>을 내거나, 탈출 카드를 쓰면 나옵니다.</li></ul>
        <b>파산</b><ul><li>돈이 모자라면 땅·건물을 은행에 팔아 마련합니다. 그래도 모자라면 파산하고, 부족한 금액은 내지 않습니다.</li></ul>
        <b>승리</b><ul><li><b>트리플 독점</b>: 컬러 독점 3곳 (관광지는 포함 안 됨)</li>
          <li><b>라인 독점</b>: 보드 한 줄의 도시·관광지를 모두 소유</li>
          <li><b>관광지 독점</b>: 모든 관광지 소유</li><li>또는 나머지 모두 파산</li></ul>
        <div class="muted">판본(베이직·이코노미·메가디럭스)에 따라 금액이 다를 수 있어요. 방장이 방을 만든 뒤 설정에서 바꿀 수 있습니다.</div>
      </div>
      <button class="btn mt" data-close>닫기</button>`);
  }

  // ---------- 도시 가격표 / 땅 ----------
  const G = window.MarbleGame;
  const ICON = { land: '🚩', villa: '🏠', building: '🏢', hotel: '🏨', landmark: '🗼', parasol: '⛱️', bungalow: '🛖' };
  const LINE_NAMES = ['1번째 줄', '2번째 줄', '3번째 줄', '4번째 줄'];

  function board() { return (state && state.board) || []; }
  function props() { return (state && state.props) || {}; }
  function hasBoard() { return board().length > 0; }
  function tileById(id) { return board().find((t) => t.id === id); }
  function tileColor(t) { return t.kind === 'tour' ? '#c9a227' : G.GROUPS[t.group].color; }
  function myTiles(pid) { return board().filter((t) => props()[t.id] && props()[t.id].owner === pid); }
  function builtIcons(t, pr) {
    if (!pr) return '';
    return ['land', ...G.buildingsOf(t).filter((k) => pr.built && pr.built[k])].map((k) => ICON[k]).join('') + (pr.olympic ? `🏅${pr.olympic > 1 ? '×' + pr.olympic : ''}` : '');
  }
  function monopolyCount(pid) {
    let n = 0;
    for (let g = 0; g < G.GROUPS.length; g++) if (G.hasMonopoly(state, pid, g)) n++;
    return n;
  }

  function loadTemplate() {
    // 직접 고친 가격표가 없으면 실물 카드 가격을 씀
    try {
      const b = JSON.parse(localStorage.getItem('marble-board'));
      if (Array.isArray(b) && b.length) return b;
    } catch {}
    return G.defaultBoard();
  }
  function saveTemplate(b) {
    try { localStorage.setItem('marble-board', JSON.stringify(b)); } catch {}
  }

  // 도착한 칸 고르기
  function tilePicker() {
    if (!hasBoard()) {
      return openModal(`<h3>🗺️ 도시 가격표가 비어 있어요</h3>
        <p>방장이 도시 카드(도시증서)에 적힌 가격을 한 번 입력해 두면, 칸만 누르면 구매·건설비, 통행료, 인수 가격이 자동으로 계산돼요.</p>
        ${isHost() ? '<button class="btn accent" id="ed">도시 가격표 입력하기</button>' : '<div class="muted">방장에게 입력을 부탁하세요.</div>'}
        <div class="sub mt">그 전에는 금액을 직접 입력해서 쓸 수 있어요.</div>
        ${manualRow()}
        <button class="btn secondary mt" data-close>닫기</button>`, (root) => {
        if (root.querySelector('#ed')) root.querySelector('#ed').onclick = () => boardEditor();
        bindManualRow(root);
      });
    }
    const lines = [0, 1, 2, 3].map((l) => board().filter((t) => t.line === l)).map((list, l) => list.length ? `
      <div class="sub">${LINE_NAMES[l]}</div>
      <div class="tiles">${list.map((t) => {
        const pr = props()[t.id];
        const owner = pr && state.players.find((p) => p.id === pr.owner);
        return `<button class="tile" data-tile="${esc(t.id)}" style="--c:${tileColor(t)}">
          <span class="tn">${esc(t.name)}</span>
          ${owner ? `<span class="to"><span class="dot" style="background:${owner.color}"></span>${builtIcons(t, pr)}</span>` : `<span class="tp">${fmt(t.cost.land)}</span>`}
        </button>`;
      }).join('')}</div>` : '').join('');
    openModal(`<h3>🗺️ 어느 칸에 도착했나요?</h3>${lines}
      <div class="sub mt">가격표에 없는 경우 직접 입력</div>
      ${manualRow()}
      <button class="btn secondary mt" data-close>닫기</button>`, (root) => {
      root.querySelectorAll('[data-tile]').forEach((b) => (b.onclick = () => tileSheet(b.dataset.tile)));
      bindManualRow(root);
    });
  }
  function manualRow() {
    return `<div class="chips"><button class="chip" data-m="toll">통행료</button><button class="chip" data-m="takeover">인수</button>
      <button class="chip" data-m="buy">구매·건설</button><button class="chip" data-m="sell">매각</button></div>`;
  }
  function bindManualRow(root) {
    root.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => ACTIONS[b.dataset.m]()));
  }

  function priceTable(t) {
    const items = G.itemsOf(t);
    const pr = props()[t.id];
    return `<table class="ptable"><tr><th></th><th>건설비</th><th>통행료</th></tr>
      ${items.map((k) => `<tr class="${pr && (k === 'land' || (pr.built && pr.built[k])) ? 'have' : ''}">
        <td>${ICON[k]} ${G.ITEM_NAMES[k]}</td><td>${fmt(t.cost[k])}</td><td>${fmt(t.toll[k])}</td></tr>`).join('')}
    </table>`;
  }

  function buildChecks(t, pr) {
    const built = (pr && pr.built) || {};
    const ready = built.villa && built.building && built.hotel;
    return G.buildingsOf(t).filter((k) => !built[k]).map((k) => {
      const disabled = k === 'landmark' && !ready;
      return `<label class="check ${disabled ? 'muted' : ''}"><input type="checkbox" data-item="${k}" ${disabled ? 'disabled' : ''}>
        ${ICON[k]} ${G.ITEM_NAMES[k]} <span class="muted">${fmt(t.cost[k])}</span>
        ${disabled ? '<small>(빌라·빌딩·호텔이 모두 있어야 함)</small>' : ''}
        ${k === 'bungalow' && !built.parasol ? '<small>(파라솔과 함께 또는 그 다음에)</small>' : ''}</label>`;
    }).join('');
  }

  // 칸 하나에 대한 화면: 구매 / 건설 / 통행료 / 인수 / 매각 / 올림픽
  function tileSheet(tileId) {
    const t = tileById(tileId);
    if (!t) return closeModal();
    const pr = props()[t.id];
    const m = me();
    const owner = pr && state.players.find((p) => p.id === pr.owner);
    const head = `<h3><span class="dot" style="background:${tileColor(t)};display:inline-block"></span> ${esc(t.name)}
      <small class="muted">${t.kind === 'tour' ? '관광지' : G.GROUPS[t.group].name + ' 도시'}</small></h3>
      <div class="sub">${owner ? `주인: <b>${esc(owner.name)}</b> ${builtIcons(t, pr)}` : '주인 없는 땅'}</div>`;
    const back = '<button class="btn secondary mt" id="back">← 칸 목록</button>';

    if (!pr) {
      openModal(`${head}${priceTable(t)}
        <div class="sub mt">같이 지을 건물</div>${buildChecks(t, null)}
        <div class="preview"><span>낼 금액</span><b id="pv">${fmt(t.cost.land)}</b></div>
        <div class="err" id="err"></div>
        <button class="btn accent" id="buy">구매하기</button>${back}`, (root) => {
        const items = () => [...root.querySelectorAll('[data-item]:checked')].map((c) => c.dataset.item);
        const calc = () => (root.querySelector('#pv').textContent = fmt(t.cost.land + items().reduce((s, k) => s + t.cost[k], 0)));
        root.querySelectorAll('[data-item]').forEach((c) => (c.onchange = calc));
        root.querySelector('#buy').onclick = () => run(() => act({ type: 'buyTile', tileId: t.id, items: items() }), root);
        root.querySelector('#back').onclick = tilePicker;
      });
      return;
    }

    if (pr.owner === m.id) {
      const toll = G.tollInfo(state, t.id);
      openModal(`${head}${priceTable(t)}
        <div class="preview"><span>지금 이 땅 통행료</span><b>${fmt(toll.amount)}</b></div>
        ${toll.parts.length ? `<div class="sub">${fmt(toll.base)} ${toll.parts.join(' ')}</div>` : ''}
        ${G.buildingsOf(t).some((k) => !(pr.built && pr.built[k])) ? `<div class="sub mt">추가로 지을 건물</div>${buildChecks(t, pr)}
          <div class="preview"><span>건설비</span><b id="pv">0</b></div>
          <button class="btn accent" id="build">건설하기</button>` : ''}
        <div class="err" id="err"></div>
        ${t.kind === 'city' ? '<button class="btn secondary mt" id="oly">🏅 올림픽 개최 (통행료 ×' + state.settings.olympicMultiplier + ')</button>' : ''}
        <button class="btn secondary mt" id="sell">🏚️ 은행에 매각 (+${fmt(G.sellPrice(state, t.id))})</button>
        ${back}`, (root) => {
        const items = () => [...root.querySelectorAll('[data-item]:checked')].map((c) => c.dataset.item);
        root.querySelectorAll('[data-item]').forEach((c) => (c.onchange = () => (root.querySelector('#pv').textContent = fmt(items().reduce((s, k) => s + t.cost[k], 0)))));
        if (root.querySelector('#build')) root.querySelector('#build').onclick = () => {
          if (!items().length) return (root.querySelector('#err').textContent = '지을 건물을 골라 주세요.');
          run(() => act({ type: 'buildTile', tileId: t.id, items: items() }), root);
        };
        if (root.querySelector('#oly')) root.querySelector('#oly').onclick = () => run(() => act({ type: 'olympicTile', tileId: t.id }), root);
        root.querySelector('#sell').onclick = () => confirmBox(`${t.name}을(를) 은행에 팔고 ${fmt(G.sellPrice(state, t.id))}을 받을까요?\n땅과 건물은 보드에서 치워 주세요.`, () => act({ type: 'sellTile', tileId: t.id }), '매각');
        root.querySelector('#back').onclick = tilePicker;
      });
      return;
    }

    // 다른 사람 땅
    const toll = G.tollInfo(state, t.id);
    const canTake = t.kind === 'city' && !(pr.built && pr.built.landmark);
    const price = G.takeoverPrice(state, t.id);
    openModal(`${head}${priceTable(t)}
      <div class="preview"><span>낼 통행료</span><b>${fmt(toll.amount)}</b></div>
      ${toll.parts.length ? `<div class="sub">${fmt(toll.base)} ${toll.parts.join(' ')}</div>` : ''}
      <div class="err" id="err"></div>
      <button class="btn" id="pay">🧾 ${esc(owner.name)}에게 통행료 내기</button>
      ${canTake ? `<button class="btn secondary mt" id="take">🤝 인수하기 (${fmt(price)})</button>` : `<div class="sub mt center">${t.kind === 'tour' ? '🏖️ 관광지는 인수할 수 없어요' : '🗼 랜드마크가 있어 인수할 수 없어요'}</div>`}
      ${back}`, (root) => {
      root.querySelector('#pay').onclick = async () => {
        const ok = await run(() => act({ type: 'payTollTile', tileId: t.id }), root, owner.id);
        if (ok && canTake && state.status === 'playing') {
          const p2 = G.takeoverPrice(state, t.id);
          confirmBox(`통행료를 냈어요.\n${t.name}을(를) ${fmt(p2)}에 인수할까요?`, () => act({ type: 'takeoverTile', tileId: t.id }), '인수하기');
        }
      };
      if (canTake) root.querySelector('#take').onclick = () =>
        confirmBox(`${owner.name}의 ${t.name}을(를) ${fmt(price)}에 인수할까요?\n(통행료를 먼저 내야 해요)`, () => act({ type: 'takeoverTile', tileId: t.id }), '인수하기');
      root.querySelector('#back').onclick = tilePicker;
    });
  }

  // 내 땅 카드
  function myTilesHtml() {
    if (!hasBoard()) return '';
    const list = myTiles(session.playerId);
    return `<div class="card"><h2>내 땅 ${list.length}곳 ${monopolyCount(session.playerId) ? `<small>· 컬러 독점 ${monopolyCount(session.playerId)}</small>` : ''}</h2>
      ${list.length ? `<div class="tiles">${list.map((t) => `<button class="tile" data-tile="${esc(t.id)}" style="--c:${tileColor(t)}">
        <span class="tn">${esc(t.name)}</span><span class="to">${builtIcons(t, props()[t.id])}</span>
        <span class="tp">통행료 ${fmt(G.tollInfo(state, t.id).amount)}</span></button>`).join('')}</div>` : '<div class="muted">아직 땅이 없어요.</div>'}
    </div>`;
  }

  // 가격표 보기(모두) / 편집(방장)
  function boardEditor() {
    const host = isHost() || !state;
    let draft = JSON.parse(JSON.stringify(state ? board() : loadTemplate()));
    const show = () => {
      const rows = draft.map((t, i) => `<li data-i="${i}">
        <span class="dot" style="background:${tileColor(t)}"></span>
        <span class="name">${esc(t.name)} <span class="tag">${t.kind === 'tour' ? '관광지' : G.GROUPS[t.group].name}</span><span class="tag">${t.line + 1}줄</span></span>
        <span class="muted">${fmt(t.cost.land)}</span></li>`).join('');
      openModal(`<h3>🗺️ 도시 가격표</h3>
        <div class="sub">${host ? '실물 도시 카드 가격이 들어 있어요. 판본이 달라 가격이 다르면 고쳐 주세요. 고친 가격표는 이 기기에 저장되어 다음 게임에도 쓰여요.' : '방장이 입력한 가격표예요.'}</div>
        <ul class="plist editable">${rows || '<li class="muted">아직 칸이 없어요.</li>'}</ul>
        ${host ? `<div class="row mt"><button class="btn secondary" id="addc">+ 도시</button><button class="btn secondary" id="addt">+ 관광지</button></div>
          <div class="row mt"><button class="btn secondary" id="exp">내보내기</button><button class="btn secondary" id="imp">가져오기</button></div>
          <button class="btn secondary mt" id="def">실물 카드 가격으로 되돌리기</button>
          <div class="err" id="err"></div>
          <div class="row mt"><button class="btn secondary" data-close>취소</button><button class="btn accent" id="save">저장</button></div>`
          : '<button class="btn secondary mt" data-close>닫기</button>'}`, (root) => {
        root.querySelectorAll('[data-i]').forEach((li) => (li.onclick = () => host ? tileForm(Number(li.dataset.i)) : tileView(draft[Number(li.dataset.i)])));
        if (!host) return;
        const add = (kind) => {
          const prev = draft[draft.length - 1];
          const t = { id: 't' + Date.now().toString(36), name: '', kind, line: prev ? prev.line : 0, group: prev && prev.kind === 'city' ? prev.group : 0, cost: {}, toll: {} };
          draft.push(t);
          tileForm(draft.length - 1, true);
        };
        root.querySelector('#addc').onclick = () => add('city');
        root.querySelector('#addt').onclick = () => add('tour');
        root.querySelector('#exp').onclick = async () => {
          const text = JSON.stringify(draft);
          try { await navigator.clipboard.writeText(text); toast('가격표를 복사했어요. 다른 방장에게 보내 주세요.'); }
          catch { prompt('이 내용을 복사하세요', text); }
        };
        root.querySelector('#imp').onclick = () => importBoard((b) => { draft = b; show(); });
        root.querySelector('#def').onclick = () => { draft = G.defaultBoard(); show(); toast('실물 카드 가격을 불러왔어요. 저장을 눌러야 적용돼요.'); };
        root.querySelector('#save').onclick = async () => {
          try {
            const clean = G.sanitizeBoard(draft);
            saveTemplate(clean);
            if (state) await act({ type: 'updateBoard', board: clean });
            closeModal();
            toast('가격표를 저장했어요.', 'plus');
          } catch (e) { root.querySelector('#err').textContent = e.message; }
        };
      });
    };
    const tileView = (t) => openModal(`<h3>${esc(t.name)}</h3>${priceTable(t)}<button class="btn secondary mt" id="bk">← 목록</button>`,
      (root) => (root.querySelector('#bk').onclick = show));

    const tileForm = (i, isNew) => {
      const t = draft[i];
      const items = () => G.itemsOf(t);
      const field = (k, which) => `<input type="number" inputmode="decimal" step="any" min="0" data-f="${which}.${k}" value="${t[which] && t[which][k] ? t[which][k] / MAN : ''}" placeholder="0">`;
      openModal(`<h3>${isNew ? '칸 추가' : '칸 수정'}</h3>
        <label class="field"><span>이름</span><input type="text" id="nm" maxlength="12" value="${esc(t.name)}" placeholder="예: 방콕"></label>
        <div class="sub">종류</div>
        <div class="chips"><button class="chip ${t.kind === 'city' ? 'on' : ''}" data-k="city">도시</button><button class="chip ${t.kind === 'tour' ? 'on' : ''}" data-k="tour">관광지</button></div>
        <div id="grp" ${t.kind === 'tour' ? 'hidden' : ''}><div class="sub">색 (같은 색을 모두 가지면 컬러 독점)</div>
          <div class="chips">${G.GROUPS.map((g, gi) => `<button class="chip pchip ${t.group === gi ? 'on' : ''}" data-g="${gi}"><span class="dot" style="background:${g.color}"></span>${g.name}</button>`).join('')}</div></div>
        <div class="sub">보드의 몇 번째 줄 (라인 독점 판정)</div>
        <div class="chips">${[0, 1, 2, 3].map((l) => `<button class="chip ${t.line === l ? 'on' : ''}" data-l="${l}">${l + 1}번째 줄</button>`).join('')}</div>
        <div class="sub">금액 (만 마블)</div>
        <table class="ptable form"><tr><th></th><th>건설비</th><th>통행료</th></tr>
          ${items().map((k) => `<tr><td>${ICON[k]} ${G.ITEM_NAMES[k]}</td><td>${field(k, 'cost')}</td><td>${field(k, 'toll')}</td></tr>`).join('')}
        </table>
        <div class="err" id="err"></div>
        <div class="row mt">
          ${i > 0 ? '<button class="btn secondary" id="up">↑ 위로</button>' : ''}
          ${i < draft.length - 1 ? '<button class="btn secondary" id="down">↓ 아래로</button>' : ''}
          <button class="btn danger" id="del">삭제</button>
        </div>
        <div class="row mt"><button class="btn secondary" id="cancel">← 목록</button><button class="btn" id="ok">확인</button></div>`, (root) => {
        const collect = () => {
          t.name = root.querySelector('#nm').value.trim();
          t.cost = t.cost || {};
          t.toll = t.toll || {};
          root.querySelectorAll('[data-f]').forEach((inp) => {
            const [which, k] = inp.dataset.f.split('.');
            t[which][k] = Math.round((Number(inp.value) || 0) * MAN);
          });
        };
        bindChoice(root, 'k', (v) => { collect(); t.kind = v; tileForm(i, isNew); });
        bindChoice(root, 'g', (v) => (t.group = Number(v)));
        bindChoice(root, 'l', (v) => (t.line = Number(v)));
        const move = (d) => { collect(); const [x] = draft.splice(i, 1); draft.splice(i + d, 0, x); show(); };
        if (root.querySelector('#up')) root.querySelector('#up').onclick = () => move(-1);
        if (root.querySelector('#down')) root.querySelector('#down').onclick = () => move(1);
        root.querySelector('#del').onclick = () => { draft.splice(i, 1); show(); };
        root.querySelector('#cancel').onclick = () => { if (isNew && !t.name) draft.splice(i, 1); else collect(); show(); };
        root.querySelector('#ok').onclick = () => {
          collect();
          if (!t.name) return (root.querySelector('#err').textContent = '이름을 입력해 주세요.');
          if (!t.cost.land) return (root.querySelector('#err').textContent = '땅(구매) 가격을 입력해 주세요.');
          show();
        };
        if (isNew) root.querySelector('#nm').focus();
      });
    };
    show();
  }

  function importBoard(onDone) {
    openModal(`<h3>가격표 가져오기</h3>
      <div class="sub">다른 방장이 "내보내기"로 보낸 내용을 붙여 넣으세요.</div>
      <textarea id="txt" rows="6" class="ta"></textarea>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn" id="ok">가져오기</button></div>`, (root) => {
      root.querySelector('#ok').onclick = () => {
        try {
          const b = G.sanitizeBoard(JSON.parse(root.querySelector('#txt').value));
          if (!b.length) throw new Error('비어 있어요.');
          onDone(b);
        } catch (e) {
          root.querySelector('#err').textContent = '가져올 수 없는 내용이에요. (' + e.message + ')';
        }
      };
    });
  }

  // 처음 화면의 열려 있는 방 목록
  let stopWatch = null;
  let roomList = null;
  function startRoomWatch() {
    if (stopWatch) return;
    stopWatch = MarbleNet.watchRooms((list, ok) => {
      roomList = ok ? list : 'error';
      renderRoomList();
    });
  }
  function stopRoomWatch() {
    if (stopWatch) stopWatch();
    stopWatch = null;
    roomList = null;
  }
  function renderRoomList() {
    const el = document.getElementById('rooms');
    if (!el) return;
    if (roomList === null) { el.innerHTML = '<div class="muted">방 목록을 불러오는 중...</div>'; return; }
    if (roomList === 'error') { el.innerHTML = '<div class="muted">방 목록을 불러올 수 없어요. 방 번호로 참가해 주세요.</div>'; return; }
    if (!roomList.length) { el.innerHTML = '<div class="muted">지금 열려 있는 방이 없어요. 새 방을 만들어 보세요!</div>'; return; }
    el.innerHTML = `<ul class="plist">${roomList.map((r) => `<li>
      <span class="name">${esc(r.host)}의 방 <span class="tag">${esc(r.code)}</span>
        <div class="muted">${r.players.map(esc).join(', ')} · ${r.players.length}/4</div></span>
      ${r.status === 'lobby' && r.players.length < 4
        ? `<button class="btn small" data-join="${esc(r.code)}" data-broker="${esc(r.broker)}">참가</button>`
        : `<span class="tag">${r.status === 'lobby' ? '가득 참' : '게임 중'}</span>`}
    </li>`).join('')}</ul>`;
    el.querySelectorAll('[data-join]').forEach((b) => (b.onclick = () => joinFromHome(b.dataset.join, b.dataset.broker)));
  }

  // ---------- 화면 꺼짐 방지 ----------
  let wakeLock = null;
  async function keepAwake() {
    try {
      if (session && 'wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('click', keepAwake);

  // ---------- 시작 ----------
  if (session) {
    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam && roomParam !== session.code) saveSession(null);
  }
  if (session) connect(); else render();
})();
