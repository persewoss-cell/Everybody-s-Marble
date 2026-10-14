'use strict';

(() => {
  const G = window.MarbleGame;
  const N = window.MarbleNet;
  const MAN = G.MAN;
  const fmt = G.fmt;
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');
  const $toasts = document.getElementById('toasts');

  // ---------- 상태 ----------
  let session = loadSession(); // { code, playerId, token, cid, host, name, broker }
  let state = null;       // 화면에 보이는 상태 (내 동작은 미리 계산해서 먼저 반영)
  let serverState = null; // 방장 기기에서 마지막으로 받은 상태
  let conn = null;
  let connected = false;
  let hostAlive = true;
  let pending = 0;
  let predictedNext = 0;
  let lastSeenTx = 0;
  let firstState = true;
  // 주사위·포춘카드 장면이 끝날 때까지 화면에 보여 줄 이전 상태 (결과가 미리 보이지 않게)
  let heldState = null;
  let heldToasts = [];

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
  const me = () => state && state.players.find((p) => p.id === session.playerId);
  const isHost = () => state && session && state.hostId === session.playerId;
  const player = (id) => state.players.find((p) => p.id === id);
  const others = () => state.players.filter((p) => p.id !== session.playerId && !p.bankrupt);
  const prop = (id) => state.props[id];
  const myTiles = (pid) => G.BOARD.filter((t) => prop(t.id) && prop(t.id).owner === (pid || session.playerId));
  const pc = (p) => (p && p.color) || '#a9b0c0';
  // 2명 이상, 사람은 모두 말 색을 골랐을 때 (컴퓨터는 시작할 때 남은 색)
  const readyToStart = (st) => st.players.length >= 2 && st.players.every((p) => p.color || p.bot);
  const BOT_TAG = '<span class="tag bot">🤖 컴퓨터</span>';
  const appMode = () => !!state && state.mode === 'app';
  // 차례를 관리하는 방 (앱으로만, 또는 컴퓨터가 함께하는 앱 + 실물 방)
  const turnsOn = () => !!state && (state.mode === 'app' || !!state.withBots);
  // 실물로 자유롭게 하는 차례 (컴퓨터가 함께하는 앱 + 실물 방의 사람)
  const freeTurn = () => !!state && state.mode !== 'app' && !!state.withBots;
  // 앱으로만 하는 방: 지금 내 차례면 차례 정보, 아니면 null
  const myTurn = () => {
    const t = state && state.turn;
    return appMode() && state.phase === 'turns' && t && t.pid === session.playerId ? t : null;
  };
  // 이번 차례에 말이 도착한 칸인지
  const landed = (t, pos) => !!t && t.spot === pos && (me().pos || 0) === pos;
  const did = (t, k) => !!(t && t.did && t.did[k]);
  const tileColor = (t) => (t.kind === 'tour' ? (t.tour === 'island' ? '#2bb3a3' : '#e98aa5') : G.GROUPS[t.group].color);
  const ICON = { land: '🚩', villa: '🏠', building: '🏢', hotel: '🏨', landmark: '🗼' };
  const TOUR_ICON = ['🚩', '⛱️', '🛖'];

  function toast(msg, cls) {
    const el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    el.textContent = msg;
    $toasts.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
  function vibrate(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch {}
  }

  // ---------- 동작 보내기 (누르자마자 내 화면에 먼저 반영) ----------
  // 규칙 위반(잔액 부족 등)은 내 기기에서 바로 알려 주고, 방장 기기가 확정하면 그 결과로 맞춤
  function act(action) {
    if (!conn || !state) throw new Error('아직 연결되지 않았습니다.');
    if (!session.host && action.type !== 'undo' && action.type !== 'blockAttack') {
      const copy = G.roomFromPublic(state);
      G.applyAction(copy, session.playerId, action); // 안 되는 동작이면 여기서 바로 오류
      const next = G.publicState(copy);
      predictedNext = next.nextTxId;
      adopt(next);
      render();
    }
    pending++;
    renderConn();
    return conn.act(action)
      .catch((e) => {
        if (serverState) state = serverState;
        render();
        throw e;
      })
      .finally(() => {
        pending--;
        if (!pending && serverState && state !== serverState) {
          state = serverState;
          render();
        }
        renderConn();
      });
  }

  // 버튼 동작 실행: 미리 계산이 되면 창을 바로 닫고, 결과는 뒤에서 확정
  function run(action, opts) {
    const o = opts || {};
    const fromTx = state ? state.nextTxId : 0;
    let p;
    try {
      p = act(action);
    } catch (e) {
      handleError(e, action, o);
      return false;
    }
    if (!o.keepOpen) closeModal();
    salaryNotice(fromTx);
    p.catch((e) => handleError(e, action, o));
    if (!NO_END_ASK.includes(action.type) && !(freeTurn() && midTurn(action))) scheduleEnd();
    return true;
  }

  // 앱으로만 하는 방: 주사위를 굴리고 할 일을 한 뒤 차례를 끝낼지 물어봄
  const NO_END_ASK = ['roll', 'orderRoll', 'endTurn', 'undo', 'move', 'travelTo', 'draw', 'keepCard', 'kick', 'start', 'pickColor', 'reset', 'end', 'adjust', 'syncDone', 'botDraw', 'blockAttack', 'passCard', 'timer', 'addBot'];
  // 앱 + 실물(컴퓨터 함께) 방의 사람: 차례 중간에 하는 일이면 끝낼지 묻지 않음
  // (월급·매각·송금·보석금·세계여행 비용은 그 뒤에 칸에서 할 일이 남음)
  const midTurn = (a) => ['salary', 'sell', 'transfer', 'useEscape', 'passCard', 'blockAttack'].includes(a.type)
    || (a.type === 'pay' && a.what !== 'tax');
  // 한 번에 하나만 기다리도록 타이머 하나로 관리
  let endTimer = null;
  let askOnClose = false; // 도착·포춘카드 뒤 뜬 창을 닫으면 차례 끝을 물어봄
  function scheduleEnd(title, delay) {
    clearTimeout(endTimer);
    endTimer = setTimeout(() => askEndTurn(0, title), delay || 400);
  }
  function askEndTurn(tries, title) {
    endTimer = null;
    if (tries > 150 || !state || !turnsOn() || state.phase !== 'turns' || state.status !== 'playing') return;
    const t = state.turn;
    const m = me();
    if (!m || !t || t.pid !== m.id) return;
    if (t.again) return; // 더블이면 한 번 더 굴려야 함
    if (freeTurn()) {
      // 이번 차례에 내가 실제로 한 일이 있을 때만 (차례가 넘어온 직후·확인 버튼 뒤에는 묻지 않음)
      let start = 0;
      for (let i = state.log.length - 1; i >= 0; i--) if (state.log[i].kind === 'turn') { start = state.log[i].id; break; }
      const acted = state.log.some((x) => x.id > start && x.actorId === m.id && !x.undone && !['info', 'orderRoll'].includes(x.kind));
      if (!acted) return;
    }
    if (!freeTurn() && (!t.rolled || m.pendingCard || (m.travel && !t.rolled))) return;
    if (t.owe || t.mustDraw || m.use) return; // 통행료·세금·포춘카드가 남았으면 차례 표시줄 버튼으로
    if ($modal.querySelector('#endask')) return;
    if ($modal.innerHTML || anim.busy || anim.queue.length) {
      endTimer = setTimeout(() => askEndTurn(tries + 1, title), 600);
      return;
    }
    askOnClose = false;
    openModal(`<h3 id="endask">${title || '차례를 끝낼까요?'}</h3><div class="sub">할 일을 다 했으면 다음 사람 차례로 넘겨요.</div>
      <div class="row"><button class="btn secondary" data-close>아직이요</button><button class="btn accent" id="yes">차례 끝</button></div>`, (root) => {
      root.querySelector('#yes').onclick = () => run({ type: 'endTurn' });
    });
  }

  function handleError(e, action, o) {
    const extra = (e && (e.extra || e.data)) || {};
    if (extra.code === 'INSUFFICIENT') return insufficient(action, extra, o || {});
    const el = $modal.querySelector('#err');
    if (el) el.textContent = e.message;
    else toast(e.message, 'err');
  }

  // 잔액 부족: 통행료·세금이면 도시를 매각해서 마련하거나 파산
  function insufficient(action, extra, o) {
    if (!extra.sellable) {
      closeModal();
      return toast(`마블이 ${fmt(extra.shortfall)} 부족해요.`, 'err');
    }
    const need = me().money + extra.shortfall;
    const show = () => {
      const m = me();
      if (m.money >= need) {
        closeModal();
        return run(action, o);
      }
      const list = myTiles();
      const owed = () => { const t = myTurn(); return !!t && !!t.owe && !me().bankrupt; };
      const lock = appMode() && owed();
      openModal(`<h3>마블이 ${fmt(need - m.money)} 부족해요</h3>
        <div class="sub">도시를 매각해서 마련하세요. 매각한 도시는 건물을 모두 치우고 도시증서를 반납해요.</div>
        ${list.length ? `<div class="tiles">${list.map((t) => `<button class="tile" data-sell="${t.id}" style="--c:${tileColor(t)}">
          <b>${esc(t.name)}</b><span class="tp">매각 +${fmt(G.sellPrice(state, t.id))}</span></button>`).join('')}</div>` : '<p>매각할 도시가 없어요.</p>'}
        <div class="err" id="err"></div>
        <div class="row">${lock ? '' : '<button class="btn secondary" data-close>취소</button>'}<button class="btn danger" id="bk">파산하기</button></div>`, (root) => {
        root.querySelectorAll('[data-sell]').forEach((b) => (b.onclick = () => {
          if (run({ type: 'sell', tileId: b.dataset.sell }, { keepOpen: true })) show();
        }));
        root.querySelector('#bk').onclick = () => bankruptDialog(o.creditor);
      }, lock ? { lock: owed } : null);
    };
    show();
  }

  // ---------- 연결 ----------
  function disconnect() {
    if (conn) conn.close();
    conn = null;
  }
  function goHome(msg) {
    disconnect();
    saveSession(null);
    state = serverState = null;
    const broker = new URLSearchParams(location.search).get('broker');
    history.replaceState(null, '', location.pathname + (broker ? `?broker=${encodeURIComponent(broker)}` : ''));
    if (msg) toast(msg, 'err');
    closeModal();
    render();
  }

  async function connect(client) {
    stopRoomWatch();
    disconnect();
    state = serverState = null;
    firstState = true;
    connected = false;
    render();
    const c = new N.Connection(session, {
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
      setTimeout(() => { if (conn === c && session) connect(); }, 3000);
    }
  }

  function onState(s) {
    const prevStatus = serverState && serverState.status;
    serverState = s;
    if (!s.players.some((p) => p.id === session.playerId)) return goHome('방에서 나가게 되었습니다.');
    // 내 동작이 아직 확정 전이면, 그 동작이 들어간 상태가 올 때까지 미리 계산한 화면을 유지
    if (!(pending && s.nextTxId < predictedNext)) adopt(s);
    if (!firstState) {
      for (const tx of s.log) {
        if (tx.id <= lastSeenTx || tx.actorId === session.playerId || tx.kind === 'start') continue;
        const d = tx.deltas[session.playerId];
        if (d) {
          const show = () => {
            toast(`${d > 0 ? '+' : ''}${fmt(d)} · ${tx.text}`, d > 0 ? 'plus' : 'minus');
            vibrate(d > 0 ? [60, 40, 60] : 200);
          };
          // 주사위·카드 장면 중이면 장면이 끝난 뒤에 알림
          if (heldState) heldToasts.push(show);
          else show();
        }
      }
      if (prevStatus === 'playing' && s.status === 'ended') vibrate([100, 50, 100, 50, 200]);
    }
    lastSeenTx = s.log.length ? s.log[s.log.length - 1].id : 0;
    if (firstState) anim.seen = lastSeenTx; // 들어오기 전 장면은 다시 보여 주지 않음
    firstState = false;
    render();
  }

  // ---------- 화면 공통 ----------
  const ANIM_KINDS = ['roll', 'orderRoll', 'fortune'];
  const newAnim = (st) => !!st && st.log.some((tx) => tx.id > anim.seen && ANIM_KINDS.includes(tx.kind) && !tx.undone);
  const animPending = () => anim.busy || anim.queue.length > 0 || newAnim(state);
  // 새 상태 받기: 아직 안 보여 준 주사위·카드 장면이 있으면 장면이 끝날 때까지 이전 화면을 유지
  function adopt(next) {
    if (state && !heldState && !firstState && newAnim(next) && state.status !== 'lobby') heldState = state;
    state = next;
  }
  function render() {
    if (heldState && !(state && animPending())) {
      heldState = null;
      const list = heldToasts;
      heldToasts = [];
      list.forEach((f) => f());
    }
    if (!heldState || !state) return renderNow();
    const real = state;
    state = heldState;
    try { renderNow(); } finally { state = real; }
  }
  function renderNow() {
    if (modalLock && $modal.innerHTML && !(state && modalLock())) closeModal();
    if (teacher && !T.focus) return renderTeacher();
    if (teacher && !state) return renderTeacher();
    if (teacher && state.status === 'lobby') return renderTeacherLobby();
    if (!session) return renderHome();
    if (!state) {
      $app.innerHTML = `${topbar()}<div class="wrap narrow"><div class="card center">연결 중...</div>
        <button class="btn secondary" id="bk">처음으로</button></div>`;
      bindTop();
      $app.querySelector('#bk').onclick = () => goHome();
      return;
    }
    if (state.status === 'lobby') return renderLobby();
    if (!anim.busy) setTimeout(scanAnimations, 0);
    if (state.status === 'playing') return renderGame();
    return renderEnded();
  }

  function topbar() {
    return `<div class="topbar">${teacher && T.focus ? '<button class="code" id="tback">← 전체</button>' : ''}<b>🎲 모두의 마블 보조앱</b>
      <span class="grow"></span>
      ${state && state.status === 'playing' && state.endAt ? `<span class="timer" data-endat="${state.endAt}">⏰ ${timeLeft(state.endAt)}</span>` : ''}
      <span id="conn">${connHtml()}</span>
      ${session ? `<button class="code" id="share" title="참가 링크 보내기">${esc(session.code)}</button>` : ''}
      <button class="icon" id="fs" title="전체화면">⛶</button></div>`;
  }
  function connHtml() {
    if (!session || !state) return '';
    if (!connected) return '<span class="conn bad">재연결 중</span>';
    if (!hostAlive) return '<span class="conn bad">방장 연결 끊김</span>';
    if (pending) return '<span class="conn">전송 중</span>';
    return '';
  }
  function renderConn() {
    const el = document.getElementById('conn');
    if (el) el.innerHTML = connHtml();
  }
  function bindTop() {
    const tb = document.getElementById('tback');
    if (tb) tb.onclick = teacherBack;
    const s = document.getElementById('share');
    if (s) s.onclick = share;
    document.getElementById('fs').onclick = toggleFullscreen;
  }

  // 전체화면 (주소창 없이 게임 화면만)
  function toggleFullscreen() {
    const d = document;
    const el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      return;
    }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) Promise.resolve(req.call(el)).catch(fsHelp);
    else fsHelp();
  }
  function fsHelp() {
    toast('이 기기는 전체화면 버튼을 지원하지 않아요. 공유 버튼 → "홈 화면에 추가"로 열면 주소창 없이 쓸 수 있어요.');
  }

  async function share() {
    const url = N.shareUrl(session);
    const text = `모두의 마블 보조앱 방 번호: ${session.code}\n${url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: '모두의 마블 보조앱', text, url });
        return;
      }
    } catch { return; }
    try {
      await navigator.clipboard.writeText(url);
      toast('참가 링크를 복사했어요.');
    } catch {
      prompt('이 링크를 보내세요', url);
    }
  }

  // ---------- 처음 화면 ----------
  let joinFromHome = () => {};
  let newMode = 'mixed';
  const MODE_NAME = { app: '📱 앱으로만', mixed: '🎲 앱 + 실물' };
  const MODE_HELP = {
    mixed: '실물 보드·주사위로 하면서 돈 계산은 앱으로. 순서는 자유롭게, 앱 주사위도 쓸 수 있어요.',
    app: '주사위·차례·포춘카드까지 앱이 관리해요. 시작하면 주사위로 순서를 정해요.',
  };
  function renderHome() {
    const params = new URLSearchParams(location.search);
    $app.innerHTML = `${topbar()}<div class="wrap narrow">
      <div class="hero"><div class="logo">🎲💰</div><h1>모두의 마블 보조앱</h1><p>보드게임 돈 계산을 각자 휴대폰·태블릿으로</p></div>
      <div class="card">
        <label class="field"><span>내 이름</span><input type="text" id="name" maxlength="12" placeholder="예: 홍길동" value="${esc(lastName())}"></label>
        <div class="sub">튕겼다면 같은 이름으로 같은 방에 들어가면 그대로 이어져요.</div>
      </div>
      <div class="card"><h2>열려 있는 방</h2><div id="rooms"></div></div>
      <div class="card">
        <h2>방 번호로 들어가기</h2>
        <div class="row"><input type="tel" id="code" inputmode="numeric" maxlength="4" placeholder="1234" value="${esc(params.get('room') || '')}">
          <button class="btn" id="join">들어가기</button></div>
      </div>
      <div class="card"><h2>새 방 만들기 <small class="muted">방장이 됩니다</small></h2>
        <div class="chips modes"><button class="chip on" data-mode="mixed">🎲 앱 + 실물</button><button class="chip" data-mode="app">📱 앱으로만</button></div>
        <div class="sub" id="modehelp"></div>
        <button class="btn accent" id="create">방 만들기</button>
      </div>
      <div class="err center" id="err"></div>
      <div class="card mt"><h2>👩‍🏫 선생님 관리 모드 <small class="muted">게임에 참여하지 않고 조별 방을 만들어 관리</small></h2>
        <div class="sub">방 개수</div>
        <div class="chips">${[2, 3, 4, 5, 6].map((n) => `<button class="chip ${n === 4 ? 'on' : ''}" data-tn="${n}">${n}개</button>`).join('')}</div>
        <div class="chips"><button class="chip on" data-tm="mixed">🎲 앱 + 실물</button><button class="chip" data-tm="app">📱 앱으로만</button></div>
        <button class="btn" id="tcreate">조별 방 만들기</button>
      </div>
      <div class="row mt"><button class="btn secondary" id="rules">규칙 요약</button>
        <a class="btn secondary" href="rulebook.pdf" download="모두의마블_보조앱_룰북.pdf" target="_blank">📖 룰북 PDF</a></div>
      <div class="maker">만든이: 강형권 선생님</div>
    </div>`;
    bindTop();
    let tn = 4;
    let tm = 'mixed';
    bindChoice($app, 'tn', (v) => (tn = Number(v)));
    bindChoice($app, 'tm', (v) => (tm = v));
    $app.querySelector('#tcreate').onclick = async () => {
      $app.querySelectorAll('.wrap button').forEach((b) => (b.disabled = true));
      $app.querySelector('#err').textContent = `방 ${tn}개를 만드는 중...`;
      try {
        await teacherCreate(tn, tm);
      } catch (e) {
        $app.querySelectorAll('.wrap button').forEach((b) => (b.disabled = false));
        $app.querySelector('#err').textContent = e.message;
      }
    };
    const $name = $app.querySelector('#name');
    const $err = $app.querySelector('#err');
    const busy = (on, msg) => {
      $app.querySelectorAll('.wrap button').forEach((b) => (b.disabled = on));
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
        const r = await N.createRoom(name, newMode);
        saveSession(r.session);
        history.replaceState(null, '', N.shareUrl(r.session));
        connect(r.client);
      } catch (e) { busy(false); $err.textContent = e.message; }
    };
    joinFromHome = async (code, broker) => {
      const name = getName(); if (!name) return;
      try {
        busy(true, '방에 들어가는 중...');
        const r = await N.joinRoom(code, name, broker);
        saveSession(r.session);
        history.replaceState(null, '', N.shareUrl(r.session));
        connect(r.client);
      } catch (e) { busy(false); $err.textContent = e.message; renderRoomList(); }
    };
    $app.querySelector('#join').onclick = () => {
      const code = $app.querySelector('#code').value.trim();
      if (!/^\d{4}$/.test(code)) { $err.textContent = '방 번호 4자리를 입력해 주세요.'; return; }
      joinFromHome(code, N.brokerFromIndex(params.get('b')));
    };
    $app.querySelector('#rules').onclick = showRules;
    const help = () => ($app.querySelector('#modehelp').textContent = MODE_HELP[newMode]);
    bindChoice($app, 'mode', (v) => { newMode = v; help(); });
    help();
    startRoomWatch();
    renderRoomList();
  }

  let stopWatch = null;
  let roomList = null;
  function startRoomWatch() {
    if (stopWatch) return;
    stopWatch = N.watchRooms((list, ok) => {
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
    if (roomList === null) { el.innerHTML = '<div class="muted">불러오는 중...</div>'; return; }
    if (roomList === 'error') { el.innerHTML = '<div class="muted">방 목록을 불러올 수 없어요. 방 번호로 들어가 주세요.</div>'; return; }
    if (!roomList.length) { el.innerHTML = '<div class="muted">지금 열려 있는 방이 없어요.</div>'; return; }
    el.innerHTML = `<ul class="plist">${roomList.map((r) => `<li>
      <span class="name">${r.title ? `<b>${esc(r.title)}</b> · ${esc(r.host)}` : `${esc(r.host)}의 방`} <span class="tag">${esc(r.code)}</span>
        <span class="muted">${MODE_NAME[r.mode] || MODE_NAME.mixed} · ${r.players.length ? `${r.players.map(esc).join(', ')} · ` : ''}${r.players.length}/4${r.status === 'playing' ? ' · 게임 중' : ''}</span></span>
      ${r.status === 'playing'
        ? `<button class="btn small secondary" data-join="${esc(r.code)}" data-broker="${esc(r.broker)}">이어하기</button>`
        : r.players.length < 4 ? `<button class="btn small" data-join="${esc(r.code)}" data-broker="${esc(r.broker)}">참가</button>` : '<span class="tag">가득 참</span>'}
    </li>`).join('')}</ul>`;
    el.querySelectorAll('[data-join]').forEach((b) => (b.onclick = () => joinFromHome(b.dataset.join, b.dataset.broker)));
  }

  // ---------- 선생님 관리 모드 ----------
  // 이 컴퓨터가 방 여러 개의 은행(방장) 역할을 함. 선생님은 게임에 참여하지 않음
  let teacher = (() => { try { return JSON.parse(localStorage.getItem('marble-teacher')) || null; } catch { return null; } })();
  const T = { rooms: {}, focus: null };
  function saveTeacher() {
    try {
      if (teacher) localStorage.setItem('marble-teacher', JSON.stringify(teacher));
      else localStorage.removeItem('marble-teacher');
    } catch {}
  }
  let renderQueued = false;
  function renderSoon() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  async function teacherCreate(count, mode) {
    const taken = [];
    const made = await Promise.all(Array.from({ length: count }, (_, i) =>
      N.createRoom('선생님', mode, { play: false, title: `${i + 1}조` }, taken)));
    teacher = { rooms: made.map((r) => r.session) };
    saveTeacher();
    stopRoomWatch();
    for (const r of made) teacherConnect(r.session, r.client);
    history.replaceState(null, '', location.pathname + location.search.replace(/[?&]room=\d+/, ''));
    render();
  }

  function teacherConnect(sess, client) {
    const entry = (T.rooms[sess.code] = { session: sess, state: null, connected: false, conn: null });
    const c = new N.Connection(sess, {
      onState: (st) => {
        entry.state = st;
        if (T.focus === sess.code) {
          adopt(st);
          serverState = st;
        }
        renderSoon();
      },
      onStatus: (st) => { entry.connected = st.connected; },
      onClosed: () => {},
    });
    entry.conn = c;
    c.open(client).catch((e) => {
      if (e.data && e.data.code === 'NO_ROOM') {
        delete T.rooms[sess.code];
        teacher.rooms = teacher.rooms.filter((x) => x.code !== sess.code);
        saveTeacher();
        renderSoon();
      }
    });
  }

  // 방 하나 자세히 보기: 그 방을 지금 화면의 방으로 삼음
  function teacherOpen(code) {
    const e = T.rooms[code];
    if (!e || !e.state) return;
    T.focus = code;
    session = e.session;
    conn = e.conn;
    state = serverState = e.state;
    connected = true;
    hostAlive = true;
    anim.queue = [];
    anim.seen = state.log.length ? state.log[state.log.length - 1].id : 0;
    closeModal();
    render();
  }
  function teacherBack() {
    T.focus = null;
    session = null;
    conn = null;
    state = serverState = null;
    closeModal();
    render();
  }

  // 조별 작은 상자 (한 줄에 모두)
  function teacherRoomCard(e) {
    const st = e.state;
    const title = (st && st.title) || e.session.code;
    if (!st) return `<div class="troom"><b class="tname">${esc(title)}</b><span class="bigno">${esc(e.session.code)}</span><span class="muted">연결 중...</span></div>`;
    const ready = readyToStart(st);
    const status = st.status === 'lobby' ? `대기 ${st.players.length}/4` : st.status === 'playing' ? '게임 중' : '끝남';
    return `<div class="troom ${st.status}">
      <div class="thead"><b class="tname">${esc(title)}</b><span class="tag ${st.status === 'playing' ? 'now' : ''}">${status}</span></div>
      <span class="bigno">${esc(st.code)}</span>
      ${st.status === 'playing' && st.endAt ? `<span class="ttime" data-endat="${st.endAt}">⏰ ${timeLeft(st.endAt)}</span>` : st.status === 'lobby' && st.timeLimit ? `<span class="ttime">⏰ ${st.timeLimit}분</span>` : ''}
      <div class="tdots">${st.players.map((p) => p.bot && !p.color ? '<span class="tbot" title="컴퓨터">🤖</span>'
        : `<span class="dot ${p.bankrupt ? 'out' : ''}" style="background:${pc(p)}" title="${esc(p.name)}"></span>`).join('') || '<span class="muted">아직 없음</span>'}</div>
      ${st.status === 'lobby' ? `<div class="row tbots"><button class="btn small secondary" data-tbot="${st.code}" ${st.players.length >= 4 ? 'disabled' : ''}>🤖 +</button>
        <button class="btn small secondary" data-tbotx="${st.code}" ${st.players.some((p) => p.bot) ? '' : 'disabled'}>🤖 −</button></div>` : ''}
      <div class="row">${st.status === 'lobby' ? `<button class="btn small accent" data-tstart="${st.code}" ${ready ? '' : 'disabled'}>시작</button>` : ''}
        <button class="btn small secondary" data-topen="${st.code}">열기</button></div>
    </div>`;
  }

  // 방 하나의 게임판 (그 방 상태로 잠깐 바꿔서 그림)
  function withState(st, fn) {
    const old = state;
    const oldView = view;
    state = st;
    view = 'real';
    plainPos = true;
    try { return fn(); } finally { state = old; view = oldView; plainPos = false; }
  }
  function teacherMini(e) {
    const st = e.state;
    if (!st) return '';
    const t = st.turn;
    const winner = st.result && st.players.find((p) => p.id === st.result.winnerId);
    const center = `<div class="mini-center">
      <div class="mtitle">${esc(st.title || st.code)}</div>
      ${st.status === 'lobby' ? `<div>대기 중 ${st.players.length}/4</div>` : ''}
      ${st.status === 'playing' && st.phase === 'order' ? '<div>🎲 순서 정하는 중</div>' : ''}
      ${winner ? `<div>🏆 ${esc(winner.name)} 승리 · ${esc(st.result.reason)}</div>` : ''}
      <ul>${st.players.map((p) => {
        const turn = st.status === 'playing' && t && t.pid === p.id;
        return `<li class="${turn ? 'now' : ''} ${p.bankrupt ? 'out' : ''}"><span class="dot" style="background:${pc(p)}"></span>${esc(p.name)}${turn ? ' 🎲' : ''}
          <b>${st.status === 'lobby' ? '' : p.bankrupt ? '파산' : fmt(p.money)}</b></li>`;
      }).join('')}</ul></div>`;
    return `<div class="card mini" data-topen="${st.code}">${withState(st, () => boardHtml(null, center))}</div>`;
  }

  function renderTeacher() {
    const list = (teacher ? teacher.rooms : []).map((x) => T.rooms[x.code]).filter(Boolean);
    const lobbies = list.filter((e) => e.state && e.state.status === 'lobby');
    $app.innerHTML = `${topbar()}<div class="wrap twrap">
      <div class="card thero"><h2>👩‍🏫 선생님 관리 화면</h2>
        <div class="sub">학생들은 처음 화면의 <b>열려 있는 방</b>에서 자기 조를 누르거나 방 번호로 들어와요. 이 컴퓨터가 모든 방의 은행이라 <b>게임하는 동안 이 화면을 켜 두세요</b>. 게임판을 누르면 그 방을 열어요.</div>
        <div class="row mt"><button class="btn accent" id="tall" ${lobbies.length ? '' : 'disabled'}>▶ 대기 중인 방 모두 시작</button>
          <button class="btn secondary" id="ttimer" ${list.length ? '' : 'disabled'}>⏰ 모든 방 타이머·종료</button>
          <button class="btn secondary" id="tadd">＋ 방 하나 더</button><button class="btn danger" id="tclose">모든 방 닫기</button></div>
      </div>
      <div class="troom-row" style="--n:${Math.max(1, list.length)}">${list.map(teacherRoomCard).join('')}</div>
      <div class="mini-grid">${list.map(teacherMini).join('')}</div>
    </div>`;
    bindTop();
    $app.querySelectorAll('[data-topen]').forEach((b) => (b.onclick = () => teacherOpen(b.dataset.topen)));
    $app.querySelectorAll('[data-tstart]').forEach((b) => (b.onclick = () => teacherStart([T.rooms[b.dataset.tstart]])));
    // 방마다 컴퓨터 추가·빼기 (대기 중일 때, 4명까지)
    const roomAct = (code, action) => {
      const e = T.rooms[code];
      if (e && e.conn) e.conn.act(action).catch((err) => toast(`${e.state.title || code}: ${err.message}`, 'err'));
    };
    $app.querySelectorAll('[data-tbot]').forEach((b) => (b.onclick = () => roomAct(b.dataset.tbot, { type: 'addBot' })));
    $app.querySelectorAll('[data-tbotx]').forEach((b) => (b.onclick = () => {
      const st = T.rooms[b.dataset.tbotx].state;
      const bots = st.players.filter((p) => p.bot);
      if (bots.length) roomAct(st.code, { type: 'kick', playerId: bots[bots.length - 1].id });
    }));
    $app.querySelector('#tall').onclick = () => teacherStart(lobbies);
    $app.querySelector('#ttimer').onclick = () => timerDialog(list);
    $app.querySelector('#tadd').onclick = async () => {
      const n = (teacher.rooms.length || 0) + 1;
      const mode = (list[0] && list[0].state && list[0].state.mode) || 'mixed';
      try {
        const r = await N.createRoom('선생님', mode, { play: false, title: `${n}조` }, teacher.rooms.map((x) => x.code));
        teacher.rooms.push(r.session);
        saveTeacher();
        teacherConnect(r.session, r.client);
        render();
      } catch (e) { toast(e.message, 'err'); }
    };
    $app.querySelector('#tclose').onclick = () => confirmBox('모든 방을 닫을까요? 학생들도 방에서 나가게 돼요.', async () => {
      for (const e of Object.values(T.rooms)) if (e.conn) await e.conn.leave();
      T.rooms = {};
      teacher = null;
      saveTeacher();
      teacherBack();
    });
  }

  function teacherStart(entries) {
    const notReady = [];
    for (const e of entries) {
      const st = e && e.state;
      if (!st || st.status !== 'lobby') continue;
      if (!readyToStart(st)) {
        notReady.push(st.title || st.code);
        continue;
      }
      e.conn.act({ type: 'start' }).catch((err) => toast(`${st.title}: ${err.message}`, 'err'));
    }
    if (notReady.length) toast(`${notReady.join(', ')}: 2명 이상이 들어와 말 색을 골라야 시작할 수 있어요.`, 'err');
  }

  // 선생님이 연 방 — 대기실
  function renderTeacherLobby() {
    const ready = readyToStart(state);
    $app.innerHTML = `${topbar()}<div class="wrap narrow">
      <div class="card center"><div class="muted">${esc(state.title || '')} 방 번호</div><div class="bigcode">${esc(state.code)}</div>
        <div class="sub">${MODE_NAME[state.mode]}</div>
        <div class="row timerrow"><span>${limitText(state)}</span><button class="btn small secondary" id="timer">게임 시간 정하기</button></div></div>
      <div class="card"><h2>참가자 ${state.players.length}/4</h2>
        <ul class="plist">${state.players.map((p) => `<li><span class="dot" style="background:${pc(p)}"></span>
          <span class="name">${esc(p.name)}${p.bot ? BOT_TAG : p.color ? '' : '<span class="tag">색 고르는 중</span>'}</span>
          <button class="link" data-kick="${p.id}">내보내기</button></li>`).join('') || '<li class="muted">아직 아무도 안 들어왔어요.</li>'}</ul>
        ${botButton(true)}</div>
      <button class="btn accent" id="start" ${ready ? '' : 'disabled'}>게임 시작</button>
      <button class="btn secondary mt" id="back2">← 전체 보기</button>
    </div>`;
    bindTop();
    $app.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = () => confirmBox(`${player(b.dataset.kick).name}님을 내보낼까요?`, { type: 'kick', playerId: b.dataset.kick });
    });
    $app.querySelector('#start').onclick = () => run({ type: 'start' });
    $app.querySelector('#back2').onclick = teacherBack;
    bindBotButton();
    $app.querySelector('#timer').onclick = () => timerDialog();
  }

  // 선생님이 연 방 — 게임 중 (보기 + 관리)
  function renderTeacherGame() {
    const undoTx = G.lastUndoable(state);
    const t = state.turn;
    $app.innerHTML = `${topbar()}<div class="game ${view}">
      <section class="g-board"><div class="board ${view === 'real' ? '' : 'card'}">${boardHtml()}</div></section>
      <section class="g-side">
        <div class="card"><h2>${esc(state.title || '')} <span class="tag">${esc(state.code)}</span> <span class="muted">${MODE_NAME[state.mode]}</span></h2>
          ${state.mode === 'app' && state.phase === 'order' ? '<div class="sub">🎲 학생들이 순서를 정하는 중</div>' : ''}
          ${t && state.phase === 'turns' ? `<div class="sub">지금 <b>${esc(player(t.pid).name)}</b> 차례</div>` : ''}
          <div class="row mt">${t && state.phase === 'turns' ? '<button class="btn small secondary" id="tskip">차례 넘기기</button>' : ''}
            <button class="btn small secondary" id="hostmenu">관리 메뉴</button>
            <button class="btn small secondary" id="timer">⏰ 타이머·종료</button>
            <button class="btn small secondary" id="view">${view === 'real' ? '카드버전' : '실제버전'}</button></div>
        </div>
      </section>
      <section class="g-players"><div class="card"><ul class="plist">${state.players.map((p) => {
        const turn = t && t.pid === p.id;
        return `<li class="${turn ? 'now' : ''}"><span class="dot" style="background:${pc(p)}"></span>
          <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}${p.bot ? '<span class="tag bot">🤖</span>' : ''}${turn ? '<span class="tag now">차례</span>' : ''}</span>
          <span class="muted">${p.bankrupt ? '파산' : `${p.laps + 1}턴 · 땅 ${myTiles(p.id).length}`}</span>
          <span class="money">${fmt(p.money)}</span></li>`;
      }).join('')}</ul></div></section>
      <section class="g-log card">
        <div class="loghead"><h2>기록</h2><button class="btn small undo" id="undo" ${undoTx ? '' : 'disabled'}>↩ 되돌리기</button></div>
        <div class="logscroll">${logHtml()}</div>
      </section>
    </div>`;
    bindTop();
    const q = (x) => $app.querySelector(x);
    q('#undo').onclick = undoDialog;
    q('#hostmenu').onclick = hostMenu;
    q('#timer').onclick = () => timerDialog();
    q('#view').onclick = () => {
      view = view === 'real' ? 'card' : 'real';
      try { localStorage.setItem('marble-view', view); } catch {}
      render();
    };
    if (q('#tskip')) q('#tskip').onclick = () => confirmBox(`${player(t.pid).name}님 차례를 넘길까요?`, { type: 'endTurn' }, '넘기기');
  }

  // ---------- 대기실 ----------
  function renderLobby() {
    const host = isHost();
    $app.innerHTML = `${topbar()}<div class="wrap narrow">
      <div class="card center">
        <div class="muted">${state.title ? `<b>${esc(state.title)}</b> · ` : ''}방 번호</div>
        <div class="bigcode">${esc(state.code)}</div>
        <div class="sub">${MODE_NAME[state.mode]} — ${MODE_HELP[state.mode]}</div>
        <button class="btn secondary small" id="share2">📤 참가 링크 보내기</button>
      </div>
      <div class="card">
        <h2>참가자 ${state.players.length}/4</h2>
        <ul class="plist">${state.players.map((p) => `<li>
          <span class="dot" style="background:${pc(p)}"></span>
          <span class="name">${esc(p.name)}${p.bot ? BOT_TAG : ''}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${p.id === session.playerId ? '<span class="tag">나</span>' : ''}</span>
          ${host && p.id !== state.hostId ? `<button class="link" data-kick="${p.id}">내보내기</button>` : ''}
        </li>`).join('')}</ul>
        ${botButton(host)}
      </div>
      ${colorPicker()}
      <div class="card row timerrow"><span>${limitText(state)}</span>${host ? '<button class="btn small secondary" id="timer">게임 시간 정하기</button>' : ''}</div>
      ${host
        ? `<button class="btn accent" id="start" ${!readyToStart(state) ? 'disabled' : ''}>게임 시작 (모두 ${fmt(G.START_MONEY)}, 축제도시 3곳 무작위)</button>
           <div class="sub mt">📱 방장 기기가 은행 역할을 해요. 게임하는 동안 방장 기기는 이 화면을 켜 두세요.</div>`
        : `<div class="card center muted">${state.hostPlays === false ? `${esc(state.hostName || '선생님')}이` : '방장이'} 게임을 시작하기를 기다리는 중...</div>`}
      <div class="row mt"><button class="btn secondary" id="rules">규칙 요약</button><button class="btn secondary" id="leave">나가기</button></div>
    </div>`;
    bindTop();
    $app.querySelector('#share2').onclick = share;
    $app.querySelector('#rules').onclick = showRules;
    $app.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = () => confirmBox(`${player(b.dataset.kick).name}님을 내보낼까요?`, { type: 'kick', playerId: b.dataset.kick });
    });
    $app.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => run({ type: 'pickColor', color: b.dataset.color })));
    if (host) $app.querySelector('#start').onclick = () => run({ type: 'start' });
    if (host) $app.querySelector('#timer').onclick = () => timerDialog();
    bindBotButton();
    $app.querySelector('#leave').onclick = () => confirmBox(host ? '방을 닫을까요? 다른 사람도 나가게 돼요.' : '방에서 나갈까요?', async () => {
      if (conn) await conn.leave();
      goHome();
    });
  }

  function colorPicker() {
    const hostP = state.players.find((p) => p.id === state.hostId);
    const waitHost = !!hostP && !isHost() && !hostP.color;
    return `<div class="card"><h2>말 색 고르기 <small class="muted">${waitHost ? '방장이 먼저 골라요' : '실제로 쓸 말과 같은 색을 고르세요'}</small></h2>
      <div class="pieces">${G.PIECES.map((c) => {
        const owner = state.players.find((p) => p.color === c.color);
        const mine = owner && owner.id === session.playerId;
        const off = waitHost || (owner && !mine);
        return `<button class="piece ${mine ? 'on' : ''}" data-color="${c.color}" ${off ? 'disabled' : ''} style="--pc:${c.color}">
          <i></i><b>${c.name}</b><small>${owner ? esc(owner.name) : '비어 있음'}</small></button>`;
      }).join('')}</div></div>`;
  }

  // ---------- 게임 화면 ----------
  function tileBadges(t) {
    const out = [];
    if (state.festival.includes(t.id)) out.push('🎉');
    if (state.olympic && state.olympic.tileId === t.id) out.push(`🏅×${state.olympic.count + 1}`);
    const fx = state.effects[t.id] || {};
    if (fx.epidemic) out.push('😷');
    if (fx.dust) out.push('🌫️');
    if (fx.blackout) out.push('⚡');
    return out.join('');
  }
  function builtIcons(t) {
    const pr = prop(t.id);
    if (!pr) return '';
    if (t.kind === 'tour') return TOUR_ICON[G.tourLevel(state, t)];
    if (pr.built.landmark) return ICON.landmark;
    return ['land', ...['villa', 'building', 'hotel'].filter((k) => pr.built[k])].map((k) => ICON[k]).join('');
  }
  // 땅·빌라·빌딩·호텔 4칸 (랜드마크면 하나로 합침), 관광지는 지금 단계 하나만
  // 칸 아래 4칸 줄: 지은 것은 주인 색 + 아이콘, 안 지은 것은 회색. 랜드마크면 한 줄로 합침
  function quad(t, pr) {
    if (!pr) return `<span class="quad">${'<i></i>'.repeat(t.kind === 'tour' ? 3 : 4)}</span>`;
    if (t.kind === 'tour') {
      const lv = G.tourLevel(state, t);
      return `<span class="quad">${TOUR_ICON.map((ic, i) => `<i class="${i <= lv ? 'on' : ''}">${i <= lv ? ic : ''}</i>`).join('')}</span>`;
    }
    if (pr.built.landmark) return '<span class="quad lm">🗼 랜드마크</span>';
    return `<span class="quad">${['land', 'villa', 'building', 'hotel'].map((k) => {
      const on = k === 'land' || pr.built[k];
      return `<i class="${on ? 'on' : ''}">${on ? ICON[k] : ''}</i>`;
    }).join('')}</span>`;
  }
  function tileButton(t, attr) {
    const pr = prop(t.id);
    const owner = pr && player(pr.owner);
    return `<button class="tile ${owner ? 'owned' : ''}" data-pos="${t.pos}" ${attr || `data-tile="${t.id}"`} style="--c:${tileColor(t)};${owner ? `--o:${pc(owner)}` : ''}">
      <span class="lbl"><b>${esc(t.name)}</b>
        <span class="tp">${owner ? `통행료:${fmt(G.tollInfo(state, t.id).amount)}` : `구입비:${fmt(t.kind === 'tour' ? G.TOUR_PRICE : t.cost.land)}`}</span>
        <span class="tb">${tileBadges(t)}</span>${piecesAt(t.pos)}</span>
      ${quad(t, pr)}
    </button>`;
  }
  // 그 칸에 있는 말 (오른쪽 위 동그라미)
  let plainPos = false;
  function shownPos(p) {
    if (plainPos) return p.pos || 0;
    if (p.id in anim.pos) return anim.pos[p.id];
    const moving = (t) => t && t.actorId === p.id && !t.undone && t.from !== undefined && t.to !== undefined;
    const waiting = [anim.current, ...anim.queue, ...state.log.filter((t) => t.id > anim.seen)].find(moving);
    return waiting ? waiting.from : p.pos || 0;
  }
  function piecesAt(pos) {
    const here = state.players.filter((p) => !p.bankrupt && shownPos(p) === pos);
    return here.length ? `<span class="pcs">${here.map((p) => `<i style="background:${pc(p)}" title="${esc(p.name)}"></i>`).join('')}</span>` : '';
  }
  function spaceButton(sp, attr) {
    return `<button class="tile sp" data-pos="${sp.pos}" ${attr || `data-sp="${sp.pos}"`}><span class="lbl"><b>${sp.icon}</b><span class="tp">${sp.short || sp.name}</span>${piecesAt(sp.pos)}</span></button>`;
  }

  let view = (() => { try { return localStorage.getItem('marble-view') || 'real'; } catch { return 'real'; } })();
  function boardHtml(filter, center) {
    const cell = (sp) => {
      if (sp.kind === 'special') return spaceButton(sp, filter ? (filter(sp) ? `data-pickpos="${sp.pos}"` : 'disabled') : '');
      return filter ? tileButton(sp, filter(sp) ? `data-pick="${sp.id}"` : 'disabled') : tileButton(sp);
    };
    if (view === 'real') {
      // 실제 게임판처럼: 아래 오른쪽이 출발, 시계방향
      const at = (pos) => {
        if (pos <= 8) return [9, 9 - pos, 'b'];
        if (pos <= 16) return [9 - (pos - 8), 1, 'l'];
        if (pos <= 24) return [1, 1 + (pos - 16), 't'];
        return [1 + (pos - 24), 9, 'r'];
      };
      return `<div class="rboard">${G.SPACES.map((sp) => {
        const [r, c, side] = at(sp.pos);
        const corner = sp.pos % 8 === 0;
        return `<div class="cell ${corner ? 'corner' : side}" style="grid-row:${r};grid-column:${c}">${cell(sp)}</div>`;
      }).join('')}<div class="center">${center || `<div class="logo">모두의 마블</div>
        <div class="legend">🎉축제 🏅올림픽 😷전염병 🌫️황사 ⚡정전</div>`}</div></div>`;
    }
    const lines = [0, 1, 2, 3].map((l) => `<div class="line"><span class="ln">${G.LINE_NAMES[l]}</span><div class="tiles">
      ${G.BOARD.filter((t) => t.line === l).map(cell).join('')}</div></div>`).join('');
    return `${lines}<div class="line"><span class="ln">★</span><div class="tiles">${G.SPACES.filter((sp) => sp.kind === 'special').map(cell).join('')}</div></div>`;
  }
  function bindBoard(root) {
    root.querySelectorAll('[data-tile]').forEach((b) => (b.onclick = () => tileSheet(b.dataset.tile)));
    root.querySelectorAll('[data-sp]').forEach((b) => (b.onclick = () => specialSheet(Number(b.dataset.sp))));
  }

  function renderGame() {
    if (teacher) return renderTeacherGame();
    const m = me();
    const host = isHost();
    const undoTx = G.lastUndoable(state);
    const canUndo = undoTx && (host || (state.mode !== 'app' && undoTx.actorId === m.id));
    const acts = state.mode === 'app'
      ? [['sell', '🏚️', '매각'], ['fortune', '🃏', '포춘카드']]
      // 보석금·국세청·세계여행·올림픽·보너스·포춘카드는 게임판의 그 칸을 누르면 됨
      : [['salary', '🏁', '월급 30만'], ['transfer', '💸', '송금'], ['sell', '🏚️', '매각']];
    $app.innerHTML = `${topbar()}<div class="game ${view}">
      <section class="g-board">
        <div class="board ${view === 'real' ? '' : 'card'}">${view === 'real' ? '' : '<div class="sub">🎉축제 🏅올림픽 😷전염병 🌫️황사 ⚡정전</div>'}${boardHtml()}</div>
      </section>
      <section class="g-side">
        <div class="me ${m.bankrupt ? 'bankrupt' : ''}" style="--pc:${pc(m)}">
          <div class="who">${esc(m.name)}${host ? ' · 방장' : ''} · ${m.bankrupt ? '파산' : `${m.laps + 1}번째 턴 (${G.ITEM_NAMES[G.maxBuilding(m)]}까지 건설)`}</div>
          <div class="bal">${fmt(m.money)} <small>마블</small></div>
          ${myStatus(m)}
        </div>
        ${turnBar()}
        <div class="row ctrl">${m.bankrupt ? '' : `<button class="btn accent" id="dice" ${canRoll() ? '' : 'disabled'}>🎲 ${diceLabel()}</button>`}
          <button class="btn secondary" id="view">${view === 'real' ? '카드버전' : '실제버전'}</button></div>
        ${m.bankrupt ? '' : `<div class="actions app">${acts.map(([a, ic, label]) => `<button class="act" data-a="${a}">${ic}<span>${label}</span></button>`).join('')}</div>`}
        <div class="sub center">${state.mode === 'app' ? '칸을 누르면 가격·통행료를 볼 수 있어요' : '말이 도착한 칸을 누르세요'}</div>
      </section>
      <section class="g-players">
        <div class="card">
          <ul class="plist">${state.players.map((p) => {
            const turn = state.turn && state.turn.pid === p.id;
            return `<li class="${turn ? 'now' : ''}">
            <span class="dot" style="background:${pc(p)}"></span>
            <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}${p.bot ? '<span class="tag bot">🤖</span>' : ''}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${turn ? '<span class="tag now">차례</span>' : ''}</span>
            <span class="muted">${p.bankrupt ? '파산' : `${p.laps + 1}턴 · 땅 ${myTiles(p.id).length}`}</span>
            <span class="money">${fmt(p.money)}</span>
          </li>`;
          }).join('')}</ul>
          <div class="row mt">
            ${host ? '<button class="btn secondary small" id="hostmenu">방장 메뉴</button><button class="btn secondary small" id="timer">⏰ 타이머·종료</button>' : ''}
            <button class="btn secondary small" id="rules">규칙 요약</button>
            ${m.bankrupt ? '' : '<button class="btn danger small" id="bankrupt">파산</button>'}
          </div>
        </div>
      </section>
      <section class="g-log card">
        <div class="loghead"><h2>기록</h2><button class="btn small undo" id="undo" ${canUndo ? '' : 'disabled'}>↩ 되돌리기</button></div>
        <div class="logscroll">${logHtml()}</div>
      </section>
    </div>`;
    bindTop();
    $app.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => ACTIONS[b.dataset.a]()));
    bindBoard($app);
    const q = (s) => $app.querySelector(s);
    q('#view').onclick = () => {
      view = view === 'real' ? 'card' : 'real';
      try { localStorage.setItem('marble-view', view); } catch {}
      render();
    };
    if (q('#dice')) q('#dice').onclick = () => rollDice();
    bindTurnBar();
    if (m.pendingCard && !$modal.innerHTML) keepPrompt();
    if (!m.bankrupt) blockPrompt();
    if (!m.bankrupt) botDrawPrompt();
    if (!m.bankrupt) syncPrompt();
    q('#undo').onclick = undoDialog;
    q('#rules').onclick = showRules;
    if (q('#hostmenu')) q('#hostmenu').onclick = hostMenu;
    if (q('#timer')) q('#timer').onclick = () => timerDialog();
    if (q('#bankrupt')) q('#bankrupt').onclick = () => bankruptDialog();
  }

  function logHtml() {
    const items = [...state.log].reverse().slice(0, 40);
    if (!items.length) return '<div class="muted">아직 기록이 없어요.</div>';
    return `<ul class="log">${items.map((tx) => {
      const d = tx.deltas[session.playerId];
      const time = new Date(tx.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      return `<li class="${tx.undone ? 'undone' : ''}"><span class="time">${time}</span>
        <span class="t">${esc(tx.text)}${d && !tx.undone ? ` <b class="${d > 0 ? 'plus' : 'minus'}">${d > 0 ? '+' : ''}${fmt(d)}</b>` : ''}</span></li>`;
    }).join('')}</ul>`;
  }

  function undoDialog() {
    const tx = G.lastUndoable(state);
    if (!tx) return;
    confirmBox(`가장 최근 거래를 되돌릴까요?\n\n${tx.text}`, { type: 'undo' }, '되돌리기');
  }

  // ---------- 칸 화면 ----------
  function priceTable(t) {
    if (t.kind === 'tour') {
      const lv = G.tourLevel(state, t);
      return `<table class="ptable"><tr><th></th><th>통행료</th></tr>
        ${G.TOUR_LEVELS.map((n, i) => `<tr class="${i === lv ? 'have' : ''}"><td>${TOUR_ICON[i]} ${n}</td><td>${fmt(G.TOUR_TOLL[i])}</td></tr>`).join('')}</table>
        <div class="sub">${t.tour === 'island' ? '섬: 한 사람이 가진 섬이 2곳이면 파라솔, 3곳이면 방갈로' : '해변: 구매 뒤 방문자(주인 포함)가 올 때마다 한 단계씩'} · 구매 ${fmt(G.TOUR_PRICE)} · 매각 ${fmt(G.TOUR_SELL)} · 인수 불가</div>`;
    }
    const pr = prop(t.id);
    const have = (k) => pr && (k === 'land' || pr.built[k]);
    return `<table class="ptable"><tr><th></th><th>건설</th><th>통행료</th><th>인수</th><th>매각</th></tr>
      ${['land', ...G.BUILDINGS].map((k) => `<tr class="${have(k) ? 'have' : ''}"><td>${ICON[k]} ${G.ITEM_NAMES[k]}</td>
        <td>${fmt(t.cost[k])}</td><td>${fmt(t.toll[k])}</td><td>${k === 'landmark' ? '불가' : fmt(t.cost[k] * 2)}</td><td>${fmt(t.cost[k] / 2)}</td></tr>`).join('')}
    </table>`;
  }

  // 앱 + 실물: 이 칸이 지금 말 위치보다 앞(번호가 작음)이면 출발지를 지나온 것 → 거래할 때 월급 자동, 턴 +1
  function passesStart(t) {
    const m = me();
    return !appMode() && t.pos !== G.POS.start && t.pos < (m.pos || 0);
  }
  // 이 칸에서 거래할 때의 내 턴 (출발지를 지나왔으면 하나 더)
  const turnAt = (t) => { const m = me(); return passesStart(t) ? { ...m, laps: m.laps + 1 } : m; };

  function buildChecks(t, pr) {
    const m = turnAt(t);
    const built = (pr && pr.built) || {};
    const list = G.BUILDINGS.filter((k) => !built[k]);
    if (!list.length) return '';
    return `<div class="checks">${list.map((k) => {
      const why = !G.canBuild(m, k) ? `${G.BUILDINGS.indexOf(k) + 1}번째 턴부터` : '';
      return `<label class="check ${why ? 'off' : ''}"><input type="checkbox" data-item="${k}" ${why ? 'disabled data-turn="1"' : ''}>
        ${ICON[k]} ${G.ITEM_NAMES[k]} <span class="muted">${fmt(t.cost[k])}</span><small>${why}</small></label>`;
    }).join('')}</div>`;
  }
  // 랜드마크 체크: 빌라·빌딩·호텔이 모두 있거나 이번에 체크했을 때만 켜짐 (하나라도 빠지면 꺼지고 체크도 풀림)
  function syncLandmark(root, pr) {
    const lm = root.querySelector('[data-item="landmark"]');
    if (!lm || lm.dataset.turn) return;
    const built = (pr && pr.built) || {};
    const has = (k) => built[k] || !!root.querySelector(`[data-item="${k}"]:checked`);
    const ok = has('villa') && has('building') && has('hotel');
    lm.disabled = !ok;
    if (!ok) lm.checked = false;
    const label = lm.closest('.check');
    label.classList.toggle('off', !ok);
    label.querySelector('small').textContent = ok ? '' : '빌라·빌딩·호텔 필요';
  }
  // 출발지를 지나 받은 월급 알림 (확인 버튼). 열린 창이 닫히면 띄움
  function salaryNotice(fromTx) {
    const tx = state && state.log.find((x) => x.id >= fromTx && x.auto && x.actorId === session.playerId && !x.undone);
    if (!tx) return;
    const show = () => {
      if ($modal.innerHTML) return setTimeout(show, 400);
      const m = me();
      notice('🏁 출발지를 지나왔어요', `월급 ${fmt(G.SALARY)} 마블을 받았어요. 이제 ${m.laps + 1}번째 턴이에요 (${G.ITEM_NAMES[G.maxBuilding(m)]}까지 건설).`);
    };
    setTimeout(show, 50);
  }
  const checked = (root) => [...root.querySelectorAll('[data-item]:checked')].map((c) => c.dataset.item);

  function tileSheet(tileId) {
    const t = G.TILE[tileId];
    const pr = prop(tileId);
    const m = me();
    if (m.bankrupt) return;
    const owner = pr && player(pr.owner);
    const head = `<h3><span class="dot" style="background:${tileColor(t)}"></span> ${esc(t.name)}
      <small>${t.kind === 'tour' ? (t.tour === 'island' ? '섬 관광지' : '해변 관광지') : G.GROUPS[t.group].name + ' 도시'} ${tileBadges(t)}</small></h3>
      <div class="sub sheethead">${owner ? `주인 <b>${esc(owner.name)}</b> ${builtIcons(t)}` : '주인 없음'}
        ${appMode() ? '' : `<button class="btn small secondary" data-move="${t.pos}">📍 내 말 여기로</button>`}</div>
      ${passesStart(t) && !m.bankrupt ? `<div class="sub passnote">🏁 출발지를 지나왔다면 여기서 거래할 때 월급 ${fmt(G.SALARY)}이 자동으로 들어오고 ${m.laps + 2}번째 턴이 돼요.</div>` : ''}`;
    // 앱으로만 하는 방: 말이 도착한 칸에서만 사고·짓고·낼 수 있음 (다른 칸은 정보만)
    const app = appMode();
    const tt = myTurn();
    const here = !app || landed(tt, t.pos);

    // 빈 땅 → 구매
    if (!pr) {
      openModal(`${head}
        ${t.kind === 'city' && here ? `<div class="buildbox"><div class="sub">같이 지을 건물</div>${buildChecks(t, null)}</div>` : ''}
        ${priceTable(t)}
        <div class="err" id="err"></div>
        ${here ? '' : '<div class="sub center">말이 이 칸에 도착하면 살 수 있어요.</div>'}
        <div class="row"><button class="btn secondary" data-close>닫기</button>${here ? '<button class="btn accent" id="buy">구매 <span id="pv"></span></button>' : ''}</div>`, (root) => {
        if (!here) return;
        const total = () => (t.kind === 'tour' ? G.TOUR_PRICE : t.cost.land + checked(root).reduce((s, k) => s + t.cost[k], 0));
        const upd = () => (root.querySelector('#pv').textContent = fmt(total()));
        root.querySelectorAll('[data-item]').forEach((c) => (c.onchange = () => { syncLandmark(root, null); upd(); }));
        syncLandmark(root, null);
        upd();
        root.querySelector('#buy').onclick = () => run({ type: 'buy', tileId: t.id, items: checked(root) });
      });
      return;
    }

    // 내 땅 → 건설 / 도착
    if (pr.owner === m.id) {
      const toll = G.tollInfo(state, t.id);
      const fx = state.effects[t.id];
      const fromStart = !here && startBuild();
      const canBuild = here || fromStart;
      const checks = t.kind === 'city' && canBuild ? buildChecks(t, pr) : '';
      const canArrive = (t.tour === 'beach' || fx) && here && !did(tt, 'arrive') && !did(tt, 'bought');
      openModal(`${head}
        ${checks ? `<div class="buildbox"><div class="sub">건물 짓기 (${here ? '도착했을 때' : '출발지 도착 — 한 곳만'})</div>${checks}</div>` : ''}
        ${priceTable(t)}
        <div class="preview"><span>지금 통행료</span><b>${fmt(toll.amount)}</b></div>
        ${toll.parts.length ? `<div class="sub">${toll.parts.join(' · ')}</div>` : ''}
        <div class="err" id="err"></div>
        <div class="row">${t.kind === 'tour' && canArrive ? '' : '<button class="btn secondary" data-close>닫기</button>'}
          ${canArrive ? `<button class="btn ${t.kind === 'tour' ? 'accent' : 'secondary'}" id="arrive">${t.tour === 'beach' ? '⛱️ 도착 · 방문 +1' : '도착 (효과 해제)'}</button>` : ''}
          ${checks ? '<button class="btn accent" id="build">건설 <span id="pv"></span></button>' : ''}</div>`, (root) => {
        const upd = () => { const el = root.querySelector('#pv'); if (el) el.textContent = fmt(checked(root).reduce((s, k) => s + t.cost[k], 0)); };
        root.querySelectorAll('[data-item]').forEach((c) => (c.onchange = () => { syncLandmark(root, pr); upd(); }));
        syncLandmark(root, pr);
        upd();
        if (root.querySelector('#build')) root.querySelector('#build').onclick = () => {
          if (!checked(root).length) return (root.querySelector('#err').textContent = '지을 건물을 골라 주세요.');
          run({ type: 'build', tileId: t.id, items: checked(root) });
        };
        if (root.querySelector('#arrive')) root.querySelector('#arrive').onclick = () => run({ type: 'arrive', tileId: t.id });
      });
      return;
    }

    // 다른 사람 땅 → 통행료 → 인수
    const canTake = t.kind === 'city' && !pr.built.landmark;
    if (app) {
      // 앱으로만 하는 방: 도착해서 내야 할 때만 '통행료 내기' (닫기·✕ 없음), 아니면 정보만
      const owe = () => { const x = myTurn(); return !!x && x.owe === 'toll' && landed(x, t.pos); };
      if (!owe()) {
        const toll = G.tollInfo(state, t.id);
        const take = canTake && !!tt && tt.paid === t.id && landed(tt, t.pos);
        openModal(`${head}${priceTable(t)}
          <div class="preview"><span>지금 통행료</span><b>${fmt(toll.amount)}</b></div>
          ${toll.parts.length ? `<div class="sub">${toll.parts.join(' · ')}</div>` : ''}
          <div class="row"><button class="btn secondary" data-close>닫기</button>${take ? `<button class="btn accent" id="take">🤝 인수 (${fmt(G.takeoverPrice(state, t.id))})</button>` : ''}</div>`, (root) => {
          if (take) root.querySelector('#take').onclick = () => takeoverAsk(t);
        });
        return;
      }
    }
    openModal(`${head}${priceTable(t)}
      <div class="preview"><span>낼 통행료</span><b id="pv"></b></div>
      <div class="sub" id="parts"></div>
      <div class="checks">${state.mode !== 'app' || m.card === 'angel' ? '<label class="check"><input type="checkbox" id="angel"> 😇 천사 카드 (면제)</label>' : '<input type="checkbox" id="angel" hidden>'}
        ${state.mode !== 'app' || m.card === 'coupon' ? '<label class="check"><input type="checkbox" id="coupon"> 🎫 할인쿠폰 (50%)</label>' : '<input type="checkbox" id="coupon" hidden>'}</div>
      <div class="err" id="err"></div>
      <div class="row">${app ? '' : '<button class="btn secondary" data-close>닫기</button>'}<button class="btn accent" id="pay">${esc(owner.name)}에게 통행료 내기</button></div>
      <div class="sub center">${canTake ? `통행료를 낸 뒤 인수할 수 있어요 (${fmt(G.takeoverPrice(state, t.id))})` : t.kind === 'tour' ? '관광지는 인수할 수 없어요' : '랜드마크가 있어 인수할 수 없어요'}</div>`, (root) => {
      const opts = () => ({ angel: root.querySelector('#angel').checked, coupon: root.querySelector('#coupon').checked });
      const upd = () => {
        const i = G.tollInfo(state, t.id, opts());
        root.querySelector('#pv').textContent = fmt(i.amount);
        root.querySelector('#parts').textContent = i.parts.join(' · ');
      };
      root.querySelector('#angel').onchange = upd;
      root.querySelector('#coupon').onchange = upd;
      upd();
      root.querySelector('#pay').onclick = () => {
        if (run({ type: 'toll', tileId: t.id, ...opts() }, { creditor: owner.id }) && canTake) takeoverAsk(t);
      };
    }, app ? { lock: () => { const x = myTurn(); return !!x && x.owe === 'toll' && landed(x, t.pos); } } : null);
  }

  function takeoverAsk(t) {
    const pr = prop(t.id);
    if (!pr || pr.owner === session.playerId || state.status !== 'playing') return;
    const price = G.takeoverPrice(state, t.id);
    openModal(`<h3>🤝 ${esc(t.name)} 인수할까요?</h3>
      <div class="preview"><span>인수비용 (${esc(player(pr.owner).name)}에게)</span><b>${fmt(price)}</b></div>
      <div class="sub">인수하면 이어서 건물을 지을 수 있어요.</div>
      <label class="check confirm"><input type="checkbox" id="sure"> 네, ${esc(t.name)}을(를) ${fmt(price)}에 인수할게요</label>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>인수 안 함</button><button class="btn accent" id="ok">인수하기</button></div>`, (root) => {
      root.querySelector('#ok').onclick = () => {
        if (!root.querySelector('#sure').checked) {
          root.querySelector('#err').textContent = '인수하려면 체크 버튼을 눌러주세요.';
          return toast('인수하려면 체크 버튼을 눌러주세요.', 'err');
        }
        if (run({ type: 'takeover', tileId: t.id }) && state.status === 'playing') tileSheet(t.id);
      };
    });
  }

  // ---------- 특수 칸 / 포춘카드 ----------
  const APP_SPECIAL = {
    start: '지나가거나 도착하면 월급 30만이 자동으로 들어와요. 도착하면 이번 차례에 내 도시 한 곳에 건물을 지을 수 있어요.',
    bonus: '도착하면 코인 앞뒤 맞히기 — 연속 1·2·3회 성공 시 40·80·160만',
    island: '3차례 동안 쉬어요. 더블, 보석금 20만, 무인도 탈출 카드로 나올 수 있어요.',
    card: '도착하면 포춘카드를 랜덤으로 뽑아요.',
    olympic: '도착하면 10만을 내고 내 도시 한 곳에 올림픽을 열 수 있어요.',
    travel: '도착하면 다음 차례에 주사위 대신 10만을 내고 원하는 도시로 가서 사거나 지을 수 있어요 (안 가고 주사위를 굴려도 돼요). 더블로 도착했으면 지금 가거나 한 번 더 굴려요.',
    tax: '도착하면 세금 20만을 내요. 모자라면 도시를 매각해서 내요.',
  };
  function specialSheet(pos) {
    const sp = G.SPACES[pos];
    if (me().bankrupt) return;
    if (appMode()) {
      const t = myTurn();
      const at = landed(t, pos);
      const m = me();
      let btn = null;
      if (sp.key === 'card' && at && t.mustDraw) btn = ['🃏 포춘카드 뽑기', fortuneDialog];
      else if (sp.key === 'bonus' && at && !did(t, 'bonus')) btn = ['🪙 보너스 게임', coinGame];
      else if (sp.key === 'olympic' && at && !did(t, 'olympic') && myTiles().some((x) => x.kind === 'city')) btn = [`🏅 올림픽 개최 (${fmt(G.OLYMPIC_COST)})`, () => ACTIONS.olympic(pos)];
      else if (sp.key === 'island' && t && m.jail > 0 && !t.rolled) btn = [`🏝️ 보석금 ${fmt(G.BAIL)} 내고 탈출`, ACTIONS.bail];
      else if (sp.key === 'tax' && at && t.owe === 'tax') btn = [`🧾 세금 ${fmt(G.TAX)} 내기`, autoTax];
      openModal(`<h3>${sp.icon} ${sp.name}</h3><div class="sub">${APP_SPECIAL[sp.key]}</div>
        <div class="row">${btn ? '' : '<button class="btn secondary" data-close>닫기</button>'}${btn ? `<button class="btn accent" id="go">${btn[0]}</button>` : ''}</div>`, (root) => {
        if (btn) root.querySelector('#go').onclick = btn[1];
      });
      return;
    }
    const BTN = {
      start: ['🏁 월급 받기', () => ACTIONS.salary(pos), '출발지에 도착하면 내 도시 한 곳에 건물을 세울 수 있어요. 그 도시 칸을 눌러 건설하세요.'],
      bonus: ['🪙 보너스 게임', () => ACTIONS.bonus(), '코인 앞뒤 맞히기 — 연속 1·2·3회 성공 시 40·80·160만'],
      island: [`🏝️ 보석금 ${fmt(G.BAIL)} 내고 탈출`, () => ACTIONS.bail(), '3차례 동안 이동할 수 없어요. 더블, 보석금, 무인도 탈출 카드로 나올 수 있어요.'],
      card: ['🃏 포춘카드', () => { run({ type: 'move', to: pos }, { keepOpen: true }); fortuneDialog(); }, '포춘카드를 뒤집고 미션을 수행하세요.'],
      olympic: [`🏅 올림픽 개최 (${fmt(G.OLYMPIC_COST)})`, () => ACTIONS.olympic(pos), '내 도시 한 곳에 올림픽을 열 수 있어요.'],
      travel: [`✈️ 세계여행 비용 ${fmt(G.TRAVEL)}`, () => ACTIONS.travel(), '다음 차례에 비용을 내고 원하는 도시로 가서 사거나 지을 수 있어요. 출발지를 지나면 월급도 받아요.'],
      tax: [`🧾 세금 ${fmt(G.TAX)} 내기`, () => ACTIONS.tax(), '세금이 부족하면 도시를 매각해서 내요.'],
    }[sp.key];
    openModal(`<h3>${sp.icon} ${sp.name}</h3>
      <div class="sub sheethead">${BTN[2]}<button class="btn small secondary" data-move="${pos}">📍 내 말 여기로</button></div>
      <button class="btn accent mt" id="go">${BTN[0]}</button>`, (root) => {
      root.querySelector('#go').onclick = BTN[1];
    });
  }

  // 칸 고르기: filter에 맞는 칸만 누를 수 있음
  function pickTile(title, note, filter, onPick) {
    const any = G.BOARD.some(filter);
    openModal(`<h3>${title}</h3>${note ? `<div class="sub">${note}</div>` : ''}
      ${any ? `<div class="board">${boardHtml(filter)}</div>` : '<p>고를 수 있는 도시가 없어요.</p>'}
      <div class="err" id="err"></div>
      <button class="btn secondary wide" data-close>취소</button>`, (root) => {
      root.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => onPick(b.dataset.pick)));
      root.querySelectorAll('[data-pickpos]').forEach((b) => (b.onclick = () => onPick(G.SPACES[Number(b.dataset.pickpos)])));
    });
  }
  const mineF = (t) => prop(t.id) && prop(t.id).owner === session.playerId;
  const theirsF = (t) => prop(t.id) && prop(t.id).owner !== session.playerId;
  const noLm = (t) => !(prop(t.id) && prop(t.id).built && prop(t.id).built.landmark);
  const SHIELD_MIXED = '상대가 방패나 천사 카드로 막으면 쓰지 마세요.';
  const shieldNote = () => (appMode() ? '상대가 방패나 천사 카드를 갖고 있으면 자동으로 막혀요.' : SHIELD_MIXED);

  const ACTIONS = {
    salary(at) {
      openModal(`<h3>🏁 출발지를 지나 월급 받기</h3>
        <label class="check"><input type="checkbox" id="boost"> 💰 월급 부스터 카드 사용 (2배)</label>
        <div class="sub">월급을 받으면 다음 턴이 돼요 (턴 제한: 첫 턴 빌라 → 빌딩 → 호텔 → 자유).</div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn accent" id="ok">받기</button></div>`, (root) => {
        root.querySelector('#ok').onclick = () => run({ type: 'salary', booster: root.querySelector('#boost').checked, ...(Number.isInteger(at) ? { at } : {}) });
      });
    },
    bail: () => confirmBox(`🏝️ 무인도 보석금 ${fmt(G.BAIL)}을 내고 탈출할까요?`, { type: 'pay', what: 'bail' }, '내기'),
    tax: () => confirmBox(`🧾 국세청 세금 ${fmt(G.TAX)}을 낼까요?`, { type: 'pay', what: 'tax' }, '내기'),
    travel: () => confirmBox(`✈️ 세계여행 비용 ${fmt(G.TRAVEL)}을 낼까요?\n출발지를 지나가면 월급도 받으세요.`, { type: 'pay', what: 'travel' }, '내기'),
    olympic(at) {
      pickTile('🏅 올림픽을 개최할 내 도시', `개최비용 ${fmt(G.OLYMPIC_COST)}. 올림픽은 한 곳에만 — 같은 도시는 ×3·×4·×5로, 다른 도시는 마크를 옮겨 ×2`, (t) => t.kind === 'city' && mineF(t), (id) => run({ type: 'olympic', tileId: id, ...(Number.isInteger(at) ? { at } : {}) }));
    },
    bonus() {
      if (appMode()) return coinGame();
      openModal(`<button class="hbtn" id="coin">🪙 앱에서 하기</button><h3>🪙 보너스 게임</h3><div class="sub">코인 앞뒤를 연속 몇 번 맞혔나요? (도전하다 틀리면 0)</div>
        <div class="chips big">${['실패', '1회 40만', '2회 80만', '3회 160만'].map((l, i) => `<button class="chip" data-w="${i}">${l}</button>`).join('')}</div>
        <button class="btn secondary wide" data-close>취소</button>`, (root) => {
        root.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => run({ type: 'bonus', wins: Number(b.dataset.w) })));
        root.querySelector('#coin').onclick = coinGame;
      });
    },
    transfer() {
      const list = others();
      let to = null;
      const chips = playerChips(list, null).replace('<div class="chips">', '<div class="chips"><button class="chip" data-p="bank">🏦 은행</button>');
      amountDialog('💸 송금', chips, '보내기', (amount, root) => {
        if (!to) return (root.querySelector('#err').textContent = '받는 사람을 골라 주세요.');
        run({ type: 'transfer', to, amount });
      }, (root) => bindChoice(root, 'p', (v) => (to = v)));
    },
    fortune: () => fortuneDialog(),
    sell() {
      if (!myTiles().length) return toast('매각할 도시가 없어요.');
      pickTile('🏚️ 매각할 내 도시', '매각하면 그 도시의 건물을 모두 치우고, 은행에서 매각비용을 받아요.', mineF, (id) => {
        const t = G.TILE[id];
        confirmBox(`${t.name}을(를) 매각하고 ${fmt(G.sellPrice(state, id))}을 받을까요?`, { type: 'sell', tileId: id }, '매각');
      });
    },
  };

  // 포춘카드 21종 (룰북 12쪽)
  const CARDS = [
    ['명령', [
      ['월급 부스터', 'gold', '출발지를 지날 때 월급 2배', () => ACTIONS.salary()],
      ['후원금', 'gold', '모두에게서 10만씩 받기', () => confirmBox('모두에게서 후원금 10만씩 받을까요?\n(10만이 없으면 가진 만큼)', { type: 'sponsor' }, '받기')],
      ['세계여행 초대장', 'gold', '세계여행으로 이동, 다음 차례에 비용 10만', () => moveTo(G.POS.travel, '세계여행 칸으로 옮겼어요. 다음 차례에 비용 10만을 내세요.')],
      ['올림픽 개최', 'silver', '10만 내고 원하는 도시에 개최', () => ACTIONS.olympic()],
      ['출발지로 GO', 'silver', '출발지로 이동해 월급, 내 도시에 건설', () => ACTIONS.salary(G.POS.start)],
      ['보너스 게임', 'silver', '보너스 게임으로 이동', () => ACTIONS.bonus()],
      ['강제징수', 'bronze', '국세청으로 이동해 세금 20만', () => ACTIONS.tax()],
      ['도시기부', 'bronze', '내 도시 하나를 상대에게 (랜드마크 제외)', () => donateDialog()],
      ['올림픽 관광', 'bronze', '올림픽 개최지로 이동해 통행료', () => (state.olympic ? tileSheet(state.olympic.tileId) : toast('올림픽 개최지가 없어 패스예요.'))],
      ['무인도 탐험', 'bronze', '무인도로 즉시 이동 (월급 없음)', () => moveTo(G.POS.island, '무인도로 옮겼어요. (출발지를 지나도 월급 없음)', { noSalary: true })],
    ]],
    ['공격', [
      ['도시체인지', 'gold', '상대 도시와 내 도시 맞교환', () => swapDialog()],
      ['전염병', 'gold', '같은 색 도시 모두 통행료 50%', () => attack('epidemic', '😷 전염병', (t) => t.kind === 'city')],
      ['외계인 침공', 'gold', '같은 색 도시 건물 하나씩 파괴', () => attack('alien', '👽 외계인 침공', (t) => t.kind === 'city')],
      ['강제매각', 'gold', '상대 도시를 은행에 매각시킴', () => attack('forceSell', '🔨 강제매각', noLm)],
      ['지진', 'silver', '상대 도시의 가장 비싼 건물 파괴', () => attack('quake', '🌋 지진', (t) => t.kind === 'city' && noLm(t))],
      ['도시정전', 'silver', '통행료 무료 (방문하면 해제)', () => attack('blackout', '⚡ 도시정전', () => true)],
      ['황사', 'silver', '통행료 50% (방문하면 해제)', () => attack('dust', '🌫️ 황사', () => true)],
    ]],
    ['방어', [
      ['천사', 'gold', '통행료 낼 때 칸 화면에서 체크', null],
      ['할인쿠폰', 'silver', '통행료 낼 때 칸 화면에서 체크', null],
      ['무인도 탈출', 'silver', '무인도에서 바로 탈출', null],
      ['방패', 'silver', '상대 공격 방어', null],
    ]],
  ];

  function moveTo(pos, msg, extra) {
    if (run({ type: 'move', to: pos, ...(extra || {}) })) toast(msg);
  }

  function fortuneDialog() {
    if (appMode()) return appFortune();
    openModal(`<button class="hbtn" id="draw">🎴 랜덤 뽑기</button><h3>🃏 포춘카드</h3>
      <div class="sub">남은 카드 ${G.deck(state).length}장 · 실물 카드를 뽑았다면 아래에서 고르세요</div>
      ${CARDS.map(([group, list], gi) => `<div class="sub">${group}</div><div class="cards">${list.map(([name, tier, desc, fn], ci) =>
        `<button class="fcard ${tier} ${fn ? '' : 'info'}" data-c="${gi}-${ci}"><b>${name}</b><small>${desc}</small></button>`).join('')}</div>`).join('')}
      <button class="btn secondary wide" data-close>닫기</button>`, (root) => {
      root.querySelector('#draw').onclick = () => {
        autoNext = true;
        run({ type: 'draw', pick: Math.random() });
      };
      root.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => {
        const [gi, ci] = b.dataset.c.split('-').map(Number);
        const card = CARDS[gi][1][ci];
        if (card[3]) card[3]();
        else toast(`${card[0]}: ${card[2]} — 앱에서 할 일은 없어요.`);
      }));
    });
  }

  // 앱으로만 하는 방: 포춘카드 칸에 도착했을 때 랜덤 뽑기만. 카드 목록은 설명만 보여 주고 고를 수 없음
  function appFortune() {
    const mustDraw = () => { const t = myTurn(); return !!t && t.mustDraw && !me().bankrupt; };
    const can = mustDraw();
    openModal(`<h3>🃏 포춘카드</h3>
      <div class="sub">남은 카드 ${G.deck(state).length}장 · ${can ? '랜덤 뽑기를 누르세요' : '포춘카드 칸에 도착하면 뽑을 수 있어요'}</div>
      ${can ? '<button class="btn accent wide" id="draw">🎴 랜덤 뽑기</button>' : ''}
      ${CARDS.map(([group, list]) => `<div class="sub">${group}</div><div class="cards">${list.map(([name, tier, desc]) =>
        `<div class="fcard ${tier} info"><b>${name}</b><small>${desc}</small></div>`).join('')}</div>`).join('')}
      ${can ? '' : '<button class="btn secondary wide" data-close>닫기</button>'}`, (root) => {
      if (!can) return;
      root.querySelector('#draw').onclick = () => {
        autoNext = true;
        run({ type: 'draw', pick: Math.random() });
      };
    }, can ? { lock: mustDraw } : null);
  }

  // 뽑은 뒤 써야 하는 카드 다시 열기
  function useCard(key) {
    handleDrawn(key);
  }
  // 앱으로만 하는 방: 출발지에 도착하면 이번 차례에 내 도시 한 곳에 건물을 지을 수 있음
  function startBuild() {
    const t = myTurn();
    return !!t && landed(t, G.POS.start) && !did(t, 'startBuild') && myTiles().some((x) => x.kind === 'city');
  }
  function startPick() {
    pickTile('🏁 출발지 도착 — 건물을 지을 내 도시', '한 곳만 지을 수 있어요. 안 지으려면 취소하세요.', (t) => t.kind === 'city' && mineF(t), (id) => tileSheet(id));
  }

  function attack(type, title, extra) {
    pickTile(`${title} — 상대 도시 고르기`, shieldNote(), (t) => theirsF(t) && extra(t), (id) => run({ type, tileId: id }));
  }
  function swapDialog() {
    pickTile('🔄 도시체인지 — 가져올 상대 도시', `랜드마크 도시는 제외. ${shieldNote()}`, (t) => theirsF(t) && noLm(t), (theirs) =>
      pickTile(`🔄 ${G.TILE[theirs].name}과(와) 바꿀 내 도시`, '', (t) => mineF(t) && noLm(t), (mine) => run({ type: 'swap', tileId: theirs, mineId: mine })));
  }
  function donateDialog() {
    pickTile('🎁 도시기부 — 줄 내 도시', '랜드마크 도시는 기부할 수 없어요.', (t) => mineF(t) && noLm(t), (id) => {
      openModal(`<h3>🎁 ${esc(G.TILE[id].name)}을(를) 누구에게?</h3>${playerChips(others(), null)}
        <button class="btn secondary wide" data-close>취소</button>`, (root) => bindChoice(root, 'p', (to) => run({ type: 'donate', tileId: id, to })));
    });
  }

  // ---------- 주사위 · 차례 ----------
  // 주사위: 기기의 암호학적 난수로 1~6을 똑같은 확률로 (두 개 합 36가지 경우, 더블은 6가지 = 1/6)
  function r6() {
    const buf = new Uint8Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      if (buf[0] < 252) return 1 + (buf[0] % 6); // 252 = 6×42, 남는 값은 버려서 치우침 없앰
    }
  }
  let autoNext = false; // 내가 굴리거나 뽑은 뒤 도착한 칸 화면을 자동으로 열기

  function canRoll() {
    const m = me();
    if (!m || m.bankrupt || state.status !== 'playing') return false;
    if (turnsOn() && state.phase === 'order') return state.orderRolls[m.id] === null;
    if (freeTurn()) return !!state.turn && state.turn.pid === m.id; // 앱 주사위도 쓸 수 있음 (자기 차례에)
    if (state.mode !== 'app') return true;
    const t = state.turn;
    return !!t && t.pid === m.id && (!t.rolled || t.again)
      && !t.owe && !t.mustDraw && !m.use && !m.pendingCard;
  }
  function diceLabel() {
    const m = me();
    if (turnsOn() && state.phase === 'order') return '주사위 굴려 순서 정하기';
    if (m.jail > 0 && state.mode === 'app') return '주사위 (더블이면 탈출)';
    if (state.mode === 'app' && G.canTravelNow(state, m) && m.money >= G.TRAVEL) return '여행 안 하고 주사위';
    if (state.turn && state.turn.again && state.turn.pid === m.id) return '한 번 더!';
    return '주사위 굴리기';
  }
  function rollDice(noAsk) {
    if (!canRoll() || anim.busy) return;
    const dice = [r6(), r6()];
    if (turnsOn() && state.phase === 'order') return run({ type: 'orderRoll', dice });
    const go = () => {
      autoNext = true;
      run({ type: 'roll', dice });
    };
    const m = me();
    // 세계여행을 할 수 있는데 주사위를 누르면: 여행 안 하고 굴리는지 확인
    if (noAsk !== true && state.mode === 'app' && G.canTravelNow(state, m) && m.money >= G.TRAVEL) {
      return confirmBox('세계여행을 하지 않고 주사위를 굴릴까요?', go, '주사위 굴리기');
    }
    go();
  }
  function travelPick() {
    pickTile('✈️ 세계여행 — 갈 도시 고르기', `비용 ${fmt(G.TRAVEL)} · 도착한 도시에서 사거나 건물을 지을 수 있어요 (남의 도시면 통행료). 출발지를 지나면 월급`, (sp) => G.travelOk(sp.pos), (sp) => {
      const pos = typeof sp === 'string' ? G.TILE[sp].pos : sp.pos;
      autoNext = true;
      run({ type: 'travelTo', to: pos });
    });
  }

  function myStatus(m) {
    const out = [];
    if (m.card) out.push(`🃏 ${G.CARD[m.card].name} 보관`);
    if (m.jail > 0) out.push(`🏝️ 무인도 (${m.jail}차례 남음)`);
    if (m.travel) out.push('✈️ 세계여행 대기');
    return out.length ? `<div class="who">${out.join(' · ')}</div>` : '';
  }

  // 앱으로만 하는 방: 순서 정하기 / 지금 차례
  function turnBar() {
    if (!turnsOn() || state.status !== 'playing') return '';
    if (state.phase === 'order') {
      const m = me();
      const real = freeTurn() && m && !m.bankrupt && state.orderRolls[m.id] === null;
      return `<div class="card turnbar"><b>🎲 순서 정하기</b><span class="muted">주사위를 굴려 높은 사람부터 시작해요${freeTurn() ? ' (실물 주사위를 굴렸다면 숫자 입력)' : ''}</span>
        ${real ? '<button class="btn small secondary" id="realorder">🎲 실물 주사위 숫자 입력</button>' : ''}
        <span class="grow"></span>${state.players.map((p) => {
          const sc = state.orderScore[p.id] || [];
          const wait = state.orderRolls[p.id] === null;
          return `<span class="tag"><span class="dot" style="background:${pc(p)}"></span> ${esc(p.name)} ${sc.length ? sc.join('/') : ''}${wait ? ' ⏳' : ''}</span>`;
        }).join('')}</div>`;
    }
    const t = state.turn;
    if (!t) return '';
    const cur = player(t.pid);
    const mine = t.pid === session.playerId;
    const m = me();
    if (freeTurn()) return freeTurnBar(t, cur, mine);
    const btns = [];
    // 세계여행은 도착한 다음 차례(주사위 전), 또는 더블로 도착한 그 차례에 떠날 수 있음
    const travelNow = mine && G.canTravelNow(state, m);
    const mustDonate = m.use === 'donate' && myTiles().some(noLm);
    if (travelNow && m.money >= G.TRAVEL) btns.push(`<button class="btn small accent" id="tgo">✈️ 갈 도시 고르기 (${fmt(G.TRAVEL)})</button>`);
    if (mine && m.jail > 0 && !t.rolled) {
      btns.push(`<button class="btn small secondary" id="tbail">보석금 ${fmt(G.BAIL)}</button>`);
      if (m.card === 'escape') btns.push('<button class="btn small secondary" id="tesc">탈출 카드</button>');
    }
    if (mine && t.owe === 'toll') btns.push('<button class="btn small accent" id="tpay">💸 통행료 내기</button>');
    if (mine && t.owe === 'tax') btns.push(`<button class="btn small accent" id="ttax">🧾 세금 ${fmt(G.TAX)} 내기</button>`);
    if (mine && startBuild()) btns.push('<button class="btn small secondary" id="tbuild">🏁 내 도시에 건물 짓기</button>');
    if (mine && t.mustDraw) btns.push('<button class="btn small accent" id="tdraw">🃏 포춘카드 뽑기</button>');
    if (mine && m.use) {
      btns.push(`<button class="btn small accent" id="tuse">🃏 ${G.CARD[m.use].name} 쓰기</button>`);
      if (!mustDonate) btns.push('<button class="btn small secondary" id="tpass">사용 안 함</button>');
    }
    const endOk = t.rolled && !t.again && !t.owe && !t.mustDraw && !m.pendingCard && !mustDonate;
    if (mine) btns.push(`<button class="btn small" id="tend" ${endOk ? '' : 'disabled'}>차례 끝</button>`);
    else if (isHost()) btns.push('<button class="btn small secondary" id="tend">차례 넘기기</button>');
    const note = !mine ? (cur.bot ? '🤖 컴퓨터가 진행하는 중...' : '')
      : t.owe === 'toll' ? '통행료를 내야 차례를 끝낼 수 있어요'
      : t.owe === 'tax' ? '세금을 내야 차례를 끝낼 수 있어요'
      : t.mustDraw ? '포춘카드를 뽑으세요'
      : m.use ? `뽑은 ${G.CARD[m.use].name} 카드를 쓰세요`
      : travelNow && m.money < G.TRAVEL ? `세계여행 비용(${fmt(G.TRAVEL)})이 모자라요. 주사위를 굴려 이동하세요`
      : travelNow && t.again ? '더블! 지금 세계여행을 가거나, 안 가고 한 번 더 굴려요'
      : travelNow ? '세계여행! 갈 도시를 고르거나, 안 가고 주사위를 굴려요'
      : m.travel ? '세계여행 도착! 다음 차례에 갈 도시를 골라요'
      : m.jail > 0 && !t.rolled ? '무인도: 더블·보석금·탈출 카드로 나와요'
      : t.again ? '더블! 한 번 더 굴려요' : t.rolled ? '할 일을 마치면 차례 끝' : '주사위를 굴리세요';
    return `<div class="card turnbar ${mine ? 'mine' : ''}"><span class="dot" style="background:${pc(cur)}"></span>
      <b>${mine ? '내 차례' : `${esc(cur.name)} 차례`}</b><span class="muted">${note}</span><span class="grow"></span>${btns.join('')}</div>`;
  }
  // 컴퓨터가 함께하는 앱 + 실물 방: 사람은 실물로 자유롭게, 다 하면 '차례 끝'
  function freeTurnBar(t, cur, mine) {
    const w = t.awaitBlock;
    const btns = [];
    if (mine) btns.push(`<button class="btn small accent" id="tend" ${t.again || t.awaitSync ? 'disabled' : ''}>차례 끝</button>`);
    else if (isHost()) btns.push('<button class="btn small secondary" id="tend">차례 넘기기</button>');
    const sync = t.awaitSync;
    const note = sync ? `🤖 ${esc(player(sync.bot).name)} 결과를 실물 게임판에 반영하고 확인을 눌러 주세요`
      : w ? `${esc(player(w.victim).name)}님이 방패·천사 카드로 막을지 고르는 중...`
      : mine && t.again ? '더블! 한 번 더 굴려요'
      : mine ? '실물 주사위로 말을 옮기고 도착한 칸을 누르세요. 다 했으면 차례 끝'
      : cur.bot ? '🤖 컴퓨터가 진행하는 중... (기록을 보고 실물 게임판에도 옮겨 주세요)' : '';
    return `<div class="card turnbar ${mine ? 'mine' : ''}"><span class="dot" style="background:${pc(cur)}"></span>
      <b>${mine ? '내 차례' : `${esc(cur.name)} 차례`}</b><span class="muted">${note}</span><span class="grow"></span>${btns.join('')}</div>`;
  }
  // 컴퓨터 차례 동안 실물 게임판에서 바뀐 것 (차례 시작 때와 지금을 비교해 최종 결과만)
  // 받침에 맞는 조사 (을/를, 으로/로)
  const batchim = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0) - 0xac00; return c >= 0 && c <= 11171 ? c % 28 : 0; };
  const eul = (w) => `${w}${batchim(w.replace(/<[^>]+>/g, '')) ? '을' : '를'}`;
  const ro = (w) => { const b = batchim(w.replace(/<[^>]+>/g, '')); return `${w}${b && b !== 8 ? '으로' : '로'}`; };
  const colorName = (p) => ((G.PIECES.find((c) => c.color === (p && p.color)) || {}).name || '');
  function boardChanges(w, bot) {
    const S = w.start;
    const T = (id) => `<b>${esc(G.TILE[id].name)}</b>`;
    const P = (id) => { const x = player(id); return x ? `${esc(x.name)}(${esc(colorName(x))})` : ''; };
    const steps = [];
    // 말: 최종 위치만
    if (bot.bankrupt && !S.bankrupt.includes(bot.id)) steps.push(`☠️ ${esc(bot.name)} 파산 — 말을 게임판에서 치워 주세요`);
    else if ((S.pos[bot.id] || 0) !== (bot.pos || 0)) steps.push(`🚶 ${esc(bot.name)} 말을 ${ro(`<b>${esc(G.SPACES[bot.pos || 0].name)}</b>`)} 옮겨 주세요`);
    const listItems = (items) => items.map((k) => G.ITEM_NAMES[k]).join('·');
    const before = { props: S.props };
    for (const t of G.BOARD) {
      const b = S.props[t.id];
      const a = state.props[t.id];
      if (!b && !a) continue;
      if (b && !a) { steps.push(`🏚️ ${T(t.id)}: 깃발·건물을 모두 치우고 도시증서를 은행에 반납해 주세요`); continue; }
      const built = (pr) => (pr && pr.built ? G.BUILDINGS.filter((k) => pr.built[k]) : []);
      if (!b && a) {
        const items = built(a);
        const what = t.kind === 'tour' ? `관광지 ${G.TOUR_LEVELS[Math.max(0, G.tourLevel(state, t))]}` : items.length ? listItems(items) : '깃발';
        steps.push(`🚩 ${T(t.id)}: ${P(a.owner)} ${eul(what)} 올리고, 도시증서를 ${esc(player(a.owner).name)}에게 주세요`);
        continue;
      }
      if (b.owner !== a.owner) steps.push(`🔄 ${T(t.id)}: 깃발·건물을 ${P(a.owner)} 색으로 바꾸고, 도시증서를 ${esc(player(a.owner).name)}에게 주세요`);
      if (t.kind === 'city') {
        const was = built(b);
        const now = built(a);
        if (now.includes('landmark') && !was.includes('landmark')) steps.push(`🗼 ${T(t.id)}: 건물을 치우고 랜드마크를 올려 주세요`);
        else {
          const add = now.filter((k) => !was.includes(k));
          const del = was.filter((k) => !now.includes(k));
          if (add.length) steps.push(`🏠 ${T(t.id)}에 ${eul(listItems(add))} 올려 주세요`);
          if (del.length) steps.push(`💥 ${T(t.id)}의 ${eul(listItems(del))} 치워 주세요${now.length ? '' : ' (깃발로 표시)'}`);
        }
      } else {
        const lb = G.tourLevel(before, t);
        const la = G.tourLevel(state, t);
        if (lb !== la && b.owner === a.owner) steps.push(`⛱️ ${T(t.id)}: 관광지 건물을 ${ro(G.TOUR_LEVELS[la])} 바꿔 주세요`);
      }
    }
    // 마크
    const MARK = { epidemic: '전염병', dust: '황사', blackout: '도시정전' };
    for (const t of G.BOARD) {
      const eb = S.effects[t.id] || {};
      const ea = state.effects[t.id] || {};
      for (const k of Object.keys(MARK)) {
        if (ea[k] && !eb[k]) steps.push(`🃏 ${T(t.id)}에 ${MARK[k]} 마크를 올려 주세요`);
        if (!ea[k] && eb[k]) steps.push(`🧹 ${T(t.id)}의 ${MARK[k]} 마크를 치워 주세요`);
      }
    }
    const ob = S.olympic;
    const oa = state.olympic;
    if (oa && (!ob || ob.tileId !== oa.tileId || ob.count !== oa.count)) steps.push(`🏅 ${T(oa.tileId)}에 올림픽 마크(×${oa.count + 1})를 놓아 주세요${ob && ob.tileId !== oa.tileId ? ` (${T(ob.tileId)}에 있던 마크는 치워요)` : ''}`);
    if (ob && !oa) steps.push(`🏅 ${T(ob.tileId)}의 올림픽 마크를 치워 주세요`);
    // 실물로 뽑아 준 포춘카드
    for (const tx of state.log) {
      if (tx.id < S.tx || tx.kind !== 'fortune' || !tx.real || tx.actorId !== bot.id || tx.undone) continue;
      const c = `<b>${esc(G.CARD[tx.card].name)}</b>`;
      steps.push(G.KEEP.includes(tx.card) && bot.card === tx.card ? `🃏 실물 ${c} 카드를 ${esc(bot.name)} 자리에 보관해 주세요` : `🃏 실물 ${c} 카드를 반납해 주세요`);
    }
    return steps;
  }
  // 컴퓨터 차례가 끝나면: 실물 게임판에 반영할 일 → 확인을 눌러야 다음 차례 진행
  let syncShown = null;
  let syncTimer = null;
  function syncPrompt() {
    const w = state && state.turn && state.turn.awaitSync;
    if (!freeTurn() || !w || syncShown === w.start.tx) return;
    if (animPending() || $modal.innerHTML) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => { if (state && state.status === 'playing') syncPrompt(); }, 600);
      return;
    }
    syncShown = w.start.tx;
    const bot = player(w.bot);
    const steps = boardChanges(w, bot);
    openModal(`<h3>🤖 ${esc(bot.name)} <span class="dot" style="background:${pc(bot)}"></span>${esc(colorName(bot))} 차례가 끝났어요</h3>
      <div class="sub">컴퓨터 결과를 실제 게임 보드판에 반영해 주세요.</div>
      ${steps.length ? `<ol class="steps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>` : '<p>실물 게임판에서 바꿀 것은 없어요.</p>'}
      <button class="btn accent wide" id="synced">확인 (반영했어요)</button>`, (root) => {
      root.querySelector('#synced').onclick = () => {
        const x = state.turn && state.turn.awaitSync;
        if (x && x.start.tx === w.start.tx) run({ type: 'syncDone' });
        else closeModal();
      };
    });
  }

  // 앱 + 실물 방: 컴퓨터가 포춘카드 칸에 서면, 랜덤으로 뽑을지 실물 카드를 뽑아 알려 줄지
  let drawAsked = '';
  function botDrawPrompt() {
    const t = state.turn;
    const bot = t && player(t.pid);
    if (!freeTurn() || !bot || !bot.bot || !t.mustDraw || animPending() || $modal.innerHTML) return;
    const key = `${t.pid}:${state.log.length ? state.log[state.log.length - 1].id : 0}`;
    if (drawAsked === key) return;
    drawAsked = key;
    const waiting = () => { const x = state.turn; return !!x && x.pid === t.pid && x.mustDraw; };
    openModal(`<h3>🃏 ${esc(bot.name)}이(가) 포춘카드 칸에 도착했어요</h3>
      <div class="sub">컴퓨터 카드를 어떻게 뽑을까요? (먼저 누른 사람 것으로 해요)</div>
      <div class="row"><button class="btn accent" id="rnd">🎲 랜덤으로 뽑기</button><button class="btn secondary" id="real">🃏 실물 카드를 뽑았어요</button></div>`, (root) => {
      root.querySelector('#rnd').onclick = () => run({ type: 'botDraw', pick: Math.random() });
      root.querySelector('#real').onclick = () => {
        openModal(`<h3>🃏 뽑은 실물 카드를 골라 주세요</h3><div class="sub">${esc(bot.name)}이(가) 이 카드를 쓴 것으로 앱이 진행해요.</div>
          ${CARDS.map(([group, list]) => `<div class="sub">${group}</div><div class="cards">${list.map(([name, tier, desc]) => {
            const c = G.FORTUNE.find((f) => f[1] === name);
            return `<button class="fcard ${tier}" data-k="${c ? c[0] : ''}"><b>${name}</b><small>${desc}</small></button>`;
          }).join('')}</div>`).join('')}
          <div class="err" id="err"></div>`, (r2) => {
          r2.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => run({ type: 'botDraw', key: b.dataset.k })));
        }, { lock: waiting });
      };
    }, { lock: waiting });
  }

  // 컴퓨터가 내 도시를 공격: 실물 방패·천사 카드가 있으면 막기
  let blockAsked = 0;
  function blockPrompt() {
    const w = state.turn && state.turn.awaitBlock;
    if (!w || w.victim !== session.playerId || blockAsked === w.txId || anim.busy) return;
    const tx = state.log.find((x) => x.id === w.txId);
    if (!tx) return;
    blockAsked = w.txId;
    openModal(`<h3>🛡️ 컴퓨터가 공격했어요</h3><p>${esc(tx.text)}</p>
      <div class="sub">실물 방어 카드를 가지고 있으면 막을 수 있어요. 어떤 카드로 막을까요? 막은 카드는 반납하세요.</div>
      <div class="cards"><button class="fcard gold" data-blk="angel"><b>😇 천사</b><small>공격 방어 (또는 통행료 면제)</small></button>
        <button class="fcard silver" data-blk="shield"><b>🛡️ 방패</b><small>상대 공격 방어</small></button></div>
      <div class="err" id="err"></div>
      <button class="btn secondary wide mt" id="nob">막을 카드가 없어요 · 그냥 둘게요</button>`, (root) => {
      root.querySelector('#nob').onclick = () => run({ type: 'blockAttack', block: false }, { keepOpen: true });
      root.querySelectorAll('[data-blk]').forEach((b) => (b.onclick = () => run({ type: 'blockAttack', block: true, card: b.dataset.blk }, { keepOpen: true })));
    }, { lock: () => { const x = state.turn && state.turn.awaitBlock; return !!x && x.txId === w.txId; } });
  }
  function realOrderDialog() {
    openModal(`<h3>🎲 실물 주사위 두 개의 합</h3><div class="chips big">${[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `<button class="chip" data-sum="${n}">${n}</button>`).join('')}</div>
      <button class="btn secondary wide" data-close>취소</button>`, (root) => {
      root.querySelectorAll('[data-sum]').forEach((b) => (b.onclick = () => run({ type: 'orderRoll', sum: Number(b.dataset.sum) })));
    });
  }

  function bindTurnBar() {
    const q = (x) => $app.querySelector(x);
    if (q('#realorder')) q('#realorder').onclick = realOrderDialog;
    if (q('#tend')) {
      q('#tend').onclick = () => ((state.turn && state.turn.pid === session.playerId) || !isHost() ? run({ type: 'endTurn' })
        : confirmBox(`${player(state.turn.pid).name}님 차례를 넘길까요?\n(남은 통행료·세금·카드는 없던 일이 돼요)`, { type: 'endTurn' }, '넘기기'));
    }
    if (q('#tpay')) q('#tpay').onclick = () => { const sp = G.SPACES[state.turn.spot]; if (sp && sp.id) tileSheet(sp.id); };
    if (q('#ttax')) q('#ttax').onclick = autoTax;
    if (q('#tdraw')) q('#tdraw').onclick = fortuneDialog;
    if (q('#tbuild')) q('#tbuild').onclick = startPick;
    if (q('#tuse')) q('#tuse').onclick = () => useCard(me().use);
    if (q('#tpass')) q('#tpass').onclick = () => confirmBox(`${G.CARD[me().use].name} 카드를 쓰지 않고 반납할까요?`, { type: 'passCard' }, '반납');
    if (q('#tbail')) q('#tbail').onclick = ACTIONS.bail;
    if (q('#tesc')) q('#tesc').onclick = () => run({ type: 'useEscape' });
    if (q('#tgo')) q('#tgo').onclick = travelPick;
  }

  // 도착한 칸 화면 자동으로 열기
  let endTitle = null; // 할 일이 없는 칸에 도착했을 때 물어볼 말
  function openLanding(pos) {
    const sp = G.SPACES[pos];
    if (!sp || me().bankrupt || state.status !== 'playing') return;
    if (sp.kind !== 'special') {
      const pr = prop(sp.id);
      if (pr && pr.owner === session.playerId) {
        if (sp.tour === 'beach' || state.effects[sp.id]) {
          const before = sp.kind === 'tour' ? G.tourLevel(state, sp) : null;
          run({ type: 'arrive', tileId: sp.id }, { keepOpen: true });
          if (sp.kind === 'tour') {
            const lv = G.tourLevel(state, sp);
            endTitle = lv > before
              ? `⛱️ ${sp.name} 방문 +1 → ${G.TOUR_LEVELS[lv]}(통행료 ${fmt(G.TOUR_TOLL[lv])})로 올랐어요. 차례를 끝낼까요?`
              : `⛱️ ${sp.name}은(는) 이미 ${G.TOUR_LEVELS[lv]}예요. 차례를 끝낼까요?`;
            return;
          }
        }
        if (sp.kind === 'tour') {
          endTitle = `🏝️ 내 관광지 ${sp.name}에 도착했어요. 차례를 끝낼까요?`;
          return;
        }
      }
      return tileSheet(sp.id);
    }
    const m = me();
    switch (sp.key) {
      case 'start':
        if (startBuild()) return startPick();
        endTitle = myTiles().some((t) => t.kind === 'city')
          ? '🏁 출발지 도착! 내 도시 한 곳에 건물을 지을 수 있어요 (\'아직이요\'를 누르고 도시를 누르세요). 차례를 끝낼까요?'
          : '🏁 출발지에 도착했어요. 차례를 끝낼까요?';
        return;
      case 'bonus': return ACTIONS.bonus();
      case 'island': return state.mode === 'app' ? toast('무인도! 3차례 동안 쉬어요.') : specialSheet(pos);
      case 'card': return fortuneDialog();
      case 'olympic':
        if (myTiles().some((t) => t.kind === 'city')) return ACTIONS.olympic(pos);
        endTitle = '🏅 올림픽을 열 내 도시가 없어요. 차례를 끝낼까요?';
        return;
      case 'travel':
        if (state.mode === 'app' && state.turn && state.turn.again) {
          // 더블로 도착: 지금 여행하거나, 안 가고 한 번 더 굴림
          if (m.money < G.TRAVEL) return toast(`더블! 세계여행 비용(${fmt(G.TRAVEL)})이 모자라 한 번 더 굴려요.`);
          return openModal(`<h3>✈️ 세계여행 (더블!)</h3>
            <div class="sub">지금 ${fmt(G.TRAVEL)}을 내고 원하는 도시로 갈 수 있어요. 여행한 도시에서 할 일을 하고 한 번 더 굴려요.<br>안 가면 여기서 주사위를 한 번 더 굴려요.</div>
            <div class="row"><button class="btn secondary" id="skip">🎲 안 가고 한 번 더 굴리기</button><button class="btn accent" id="tgo2">✈️ 갈 도시 고르기</button></div>`, (root) => {
            root.querySelector('#tgo2').onclick = travelPick;
            root.querySelector('#skip').onclick = () => { closeModal(); rollDice(true); };
          });
        }
        endTitle = '✈️ 세계여행! 다음 차례에 10만을 내고 원하는 도시로 갈 수 있어요 (안 가고 주사위를 굴려도 돼요). 차례를 끝낼까요?';
        return;
      case 'tax': return autoTax();
    }
    return m;
  }

  // 뽑은 포춘카드 처리
  function handleDrawn(key) {
    const m = me();
    if (m.pendingCard) return keepPrompt();
    switch (key) {
      case 'sponsor':
        if (appMode()) return notice('🎁 후원금', '모두에게서 후원금을 받았어요. (10만이 없는 사람은 가진 만큼)');
        return run({ type: 'sponsor' }) && notice('🎁 후원금', `모두에게서 후원금을 받았어요. (10만이 없는 사람은 가진 만큼)`);
      case 'epidemic': return attack('epidemic', '😷 전염병', (t) => t.kind === 'city');
      case 'alien': return attack('alien', '👽 외계인 침공', (t) => t.kind === 'city');
      case 'forceSell': return attack('forceSell', '🔨 강제매각', noLm);
      case 'quake': return attack('quake', '🌋 지진', (t) => t.kind === 'city' && noLm(t));
      case 'blackout': return attack('blackout', '⚡ 도시정전', () => true);
      case 'dust': return attack('dust', '🌫️ 황사', () => true);
      case 'swap': return swapDialog();
      case 'donate': return donateDialog();
      case 'olympicHost': return ACTIONS.olympic();
      case 'goStart':
        if (startBuild()) return startPick();
        endTitle = myTiles().some((t) => t.kind === 'city')
          ? '🏁 출발지로 와서 월급을 받았어요. 내 도시 한 곳에 건물을 지을 수 있어요 (\'아직이요\'를 누르고 도시를 누르세요). 차례를 끝낼까요?'
          : '🏁 출발지로 와서 월급을 받았어요. 차례를 끝낼까요?';
        return;
      case 'bonusGo': return ACTIONS.bonus();
      case 'taxGo': return autoTax();
      case 'olympicTour':
        if (state.olympic) return tileSheet(state.olympic.tileId);
        endTitle = '올림픽 개최지가 없어 패스예요. 차례를 끝낼까요?';
        return;
      case 'travelInvite':
        endTitle = '✈️ 세계여행 칸으로 왔어요. 다음 차례에 10만을 내고 원하는 도시로 갈 수 있어요. 차례를 끝낼까요?';
        return;
      case 'islandTrip':
        endTitle = '🏝️ 무인도로 이동했어요. 차례를 끝낼까요?';
        return;
      default:
        endTitle = `🃏 ${G.CARD[key].name} 카드를 보관했어요. 차례를 끝낼까요?`;
        return;
    }
  }

  // 반드시 내야 하는 돈은 묻지 않고 처리한 뒤 알려 줌
  function notice(title, msg) {
    openModal(`<h3>${title}</h3><p>${esc(msg)}</p><button class="btn accent wide" data-close>확인</button>`);
    return true;
  }
  function autoTax() {
    if (run({ type: 'pay', what: 'tax' }, { keepOpen: true })) notice('🧾 국세청', `세금 ${fmt(G.TAX)}을 납부했어요.`);
  }

  function keepPrompt() {
    const m = me();
    if (!m.pendingCard) return;
    const a = G.CARD[m.card];
    const b = G.CARD[m.pendingCard];
    openModal(`<h3>🃏 보관 카드는 1장만</h3><div class="sub">하나는 반납해요. 어떤 카드를 가질까요?</div>
      <div class="cards"><button class="fcard ${a.tier}" data-k="old"><b>${a.name}</b><small>${a.desc}</small></button>
      <button class="fcard ${b.tier}" data-k="new"><b>${b.name} (새 카드)</b><small>${b.desc}</small></button></div>`, (root) => {
      root.querySelectorAll('[data-k]').forEach((x) => (x.onclick = () => run({ type: 'keepCard', keep: x.dataset.k })));
    });
  }

  // ---------- 보너스 게임 (앱에서 동전 앞뒤 맞히기) ----------
  function coinGame() {
    let wins = 0;
    const flips = [];
    const stage = () => {
      const next = G.BONUS[wins];
      openModal(`<h3>🪙 보너스 게임 ${wins ? `— ${wins}회 성공!` : ''}</h3>
        <div class="coin" id="coin">🪙</div>
        <div class="sub center">${wins ? `지금 그만하면 ${fmt(G.BONUS[wins - 1])} · ` : ''}맞히면 ${fmt(next)} · 틀리면 0</div>
        <div class="row"><button class="btn accent" data-g="front">앞면</button><button class="btn accent" data-g="back">뒷면</button></div>
        ${wins ? `<button class="btn secondary wide" id="stop">그만하고 ${fmt(G.BONUS[wins - 1])} 받기</button>` : appMode() ? '<button class="btn secondary wide" id="stop">도전 안 함</button>' : ''}`, (root) => {
        if (root.querySelector('#stop')) root.querySelector('#stop').onclick = () => finish();
        root.querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => flip(root, b.dataset.g)));
      }, appMode() ? { lock: () => { const t = myTurn(); return !!t && landed(t, G.POS.bonus) && !did(t, 'bonus'); } } : null);
    };
    const flip = async (root, guess) => {
      root.querySelectorAll('button').forEach((b) => (b.disabled = true));
      const coin = root.querySelector('#coin');
      const side = Math.random() < 0.5 ? 'front' : 'back';
      coin.classList.add('spin');
      for (let i = 0; i < 12; i++) {
        coin.textContent = i % 2 ? '앞' : '뒤';
        await sleep(60 + i * 18);
      }
      coin.classList.remove('spin');
      coin.textContent = side === 'front' ? '앞' : '뒤';
      flips.push([guess, side]);
      await sleep(600);
      if (guess === side) {
        wins++;
        if (wins >= 3) return finish();
        stage();
      } else {
        toast('틀렸어요! 이번 보너스는 0이에요.', 'err');
        wins = 0;
        finish();
      }
    };
    const finish = () => run({ type: 'bonus', wins, flips });
    stage();
  }

  // ---------- 주사위 · 이동 · 카드 장면 (모든 기기에서 같이 보임) ----------
  const anim = { pos: {}, busy: false, queue: [], seen: 0, current: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  const dieHtml = (n) => `<div class="die">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `<i class="${PIPS[n].includes(i) ? 'on' : ''}"></i>`).join('')}</div>`;
  function fxBox() {
    let el = document.getElementById('fx');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fx';
      document.body.appendChild(el);
    }
    return el;
  }

  function scanAnimations() {
    if (!state || !state.log) return;
    for (const tx of state.log) {
      if (tx.id <= anim.seen) continue;
      anim.seen = tx.id;
      if (['roll', 'orderRoll', 'fortune'].includes(tx.kind) && !tx.undone) anim.queue.push(tx);
    }
    if (!anim.busy) playNext();
  }

  async function playNext() {
    const tx = anim.queue.shift();
    if (!tx) return;
    anim.busy = true;
    anim.current = tx;
    const who = state.players.find((p) => p.id === tx.actorId);
    const name = who ? who.name : '';
    try {
      if (tx.dice) await showDice(name, tx.dice, who);
      if (tx.card) await showCard(name, tx.card);
      if (tx.to !== undefined && tx.from !== undefined && tx.to !== tx.from) await walk(tx.actorId, tx.from, tx.to, tx.jump);
    } finally {
      anim.busy = false;
      anim.current = null;
      delete anim.pos[tx.actorId];
      render();
    }
    if (tx.actorId === session.playerId && autoNext && !anim.queue.length) {
      autoNext = false;
      if (tx.kind === 'fortune') handleDrawn(tx.card);
      else if (tx.kind === 'roll' && me().jail > 0) endTitle = '🏝️ 무인도에 있어요. 할 일이 없으니 차례를 끝낼까요?';
      else if (tx.kind === 'roll' && tx.to !== tx.from) openLanding(tx.to);
      // 도착이나 카드 뒤에 뜬 창을 닫으면 차례 끝을 물어보고, 창이 안 떴으면 바로 물어봄
      askOnClose = true;
      if (!$modal.innerHTML) scheduleEnd(endTitle);
      endTitle = null;
    }
    playNext();
  }

  async function showDice(name, dice, who) {
    const el = fxBox();
    el.className = 'show';
    el.innerHTML = `<div class="fxcard"><div class="fxname"><span class="dot" style="background:${pc(who)}"></span> ${esc(name)} 🎲</div>
      <div class="dice"><span id="d1"></span><span id="d2"></span></div><div class="fxsum" id="dsum">&nbsp;</div></div>`;
    const d1 = el.querySelector('#d1');
    const d2 = el.querySelector('#d2');
    // 1.5초 동안 숫자가 빠르게 바뀌다가 천천히 멈춤
    const start = Date.now();
    while (Date.now() - start < 1500) {
      d1.innerHTML = dieHtml(r6());
      d2.innerHTML = dieHtml(r6());
      const k = (Date.now() - start) / 1500;
      await sleep(45 + k * k * 220);
    }
    d1.innerHTML = dieHtml(dice[0]);
    d2.innerHTML = dieHtml(dice[1]);
    el.querySelector('#dsum').textContent = `${dice[0]} + ${dice[1]} = ${dice[0] + dice[1]}${dice[0] === dice[1] ? ' 더블!' : ''}`;
    await sleep(900);
    el.className = '';
  }

  async function showCard(name, key) {
    const c = G.CARD[key];
    const el = fxBox();
    el.className = 'show';
    el.innerHTML = `<div class="fxcard"><div class="fxname">${esc(name)} 🃏 포춘카드</div><div class="bigcard back" id="bc">FORTUNE<br>CARD</div></div>`;
    await sleep(700);
    const bc = el.querySelector('#bc');
    bc.className = `bigcard ${c.tier} flip`;
    bc.innerHTML = `<b>${c.name}</b><small>${c.desc}</small>`;
    await sleep(2000);
    el.className = '';
  }

  // 말을 한 칸씩 옮기기
  // 말 표시만 다시 그림 (화면 전체를 다시 그리지 않아 빠름)
  function drawPieces() {
    document.querySelectorAll('#app [data-pos]').forEach((el) => {
      const lbl = el.querySelector('.lbl');
      if (!lbl) return;
      const old = lbl.querySelector('.pcs');
      if (old) old.remove();
      lbl.insertAdjacentHTML('beforeend', piecesAt(Number(el.dataset.pos)));
    });
  }
  async function walk(pid, from, to, jump) {
    if (jump) {
      anim.pos[pid] = to;
      drawPieces();
      await sleep(500);
    } else {
      let cur = from;
      while (cur !== to) {
        cur = (cur + 1) % G.SPACES.length;
        anim.pos[pid] = cur;
        drawPieces();
        await sleep(240);
      }
      await sleep(200);
    }
    anim.pos[pid] = to; // 끝날 때까지 도착 칸에 둠 (playNext가 마무리)
  }

  // ---------- 파산 / 방장 메뉴 ----------
  function bankruptDialog(creditor) {
    let to = creditor || '';
    openModal(`<h3>☠️ 파산</h3>
      <p>게임에서 빠지고 내 땅·건물은 모두 치워요. 남은 마블 ${fmt(me().money)}은(는) 빚진 사람에게 가요.</p>
      <div class="sub">누구에게 빚졌나요?</div>
      <div class="chips"><button class="chip ${to ? '' : 'on'}" data-p="">🏦 은행 (세금 등)</button>
      ${others().map((p) => `<button class="chip ${p.id === to ? 'on' : ''}" data-p="${p.id}"><span class="dot" style="background:${pc(p)}"></span>${esc(p.name)}</button>`).join('')}</div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn danger" id="ok">파산</button></div>`, (root) => {
      bindChoice(root, 'p', (v) => (to = v));
      root.querySelector('#ok').onclick = () => run({ type: 'bankrupt', to: to || undefined });
    });
  }

  function hostMenu() {
    openModal(`<h3>방장 메뉴</h3>
      <div class="row"><button class="btn secondary" id="adj">잔액 직접 수정</button><button class="btn secondary" id="hbk">다른 사람 파산 처리</button></div>
      ${state.mode === 'app' ? `<div class="row"><button class="btn secondary" id="hmove">📍 말 옮기기 (바로잡기)</button><button class="btn secondary" id="hundo" ${G.lastUndoable(state) ? '' : 'disabled'}>↩ 되돌리기</button></div>
      <div class="sub">앱으로만 하는 방에서는 방장만 말을 옮기고 되돌릴 수 있어요. 차례인 사람의 말을 옮기면 그 칸에 도착한 것으로 처리돼요.</div>` : ''}
      <div class="sub mt">게임 종료 (독점은 자동으로 판정돼요)</div>
      <div class="chips"><button class="chip" data-e="time">⏰ 시간 종료 — 총자산 1등 승리</button>
        <button class="chip" data-e="triple">트리플 독점</button><button class="chip" data-e="line">라인 독점</button><button class="chip" data-e="tour">관광지 독점</button></div>
      <button class="btn secondary wide mt" data-close>닫기</button>`, (root) => {
      root.querySelector('#adj').onclick = adjustDialog;
      if (root.querySelector('#hmove')) root.querySelector('#hmove').onclick = moveDialog;
      if (root.querySelector('#hundo')) root.querySelector('#hundo').onclick = undoDialog;
      root.querySelector('#hbk').onclick = () => {
        openModal(`<h3>누구를 파산 처리할까요?</h3>${playerChips(state.players.filter((p) => !p.bankrupt && p.id !== session.playerId), null)}
          <div class="err" id="err"></div><button class="btn secondary wide" data-close>취소</button>`, (r) =>
          bindChoice(r, 'p', (v) => confirmBox(`${player(v).name}님을 파산 처리할까요? (남은 마블은 은행으로)`, { type: 'bankrupt', playerId: v })));
      };
      root.querySelectorAll('[data-e]').forEach((b) => (b.onclick = () => {
        if (b.dataset.e === 'time') return confirmBox('지금 게임을 끝낼까요? 총자산(마블 + 땅·건물 건설비용)이 가장 많은 사람이 이겨요.', { type: 'end', reason: 'time' });
        openModal(`<h3>누가 이겼나요?</h3>${playerChips(state.players.filter((p) => !p.bankrupt), null)}<button class="btn secondary wide" data-close>취소</button>`, (r) =>
          bindChoice(r, 'p', (v) => run({ type: 'end', reason: b.dataset.e, winnerId: v })));
      }));
    });
  }

  function moveDialog() {
    openModal(`<h3>📍 누구 말을 옮길까요?</h3>${playerChips(state.players.filter((p) => !p.bankrupt), null)}
      <button class="btn secondary wide" data-close>취소</button>`, (root) => bindChoice(root, 'p', (pid) => {
      pickTile(`📍 ${esc(player(pid).name)} 말을 옮길 칸`, '돈은 오가지 않아요. 기록에 남고 되돌릴 수 있어요.', () => true, (x) => {
        const pos = typeof x === 'string' ? G.TILE[x].pos : x.pos;
        run({ type: 'move', playerId: pid, to: pos });
      });
    }));
  }

  function adjustDialog() {
    let who = null;
    amountDialog('잔액 직접 수정', `<div class="sub">실수를 바로잡을 때만 쓰세요. 기록에 남아요.</div>${playerChips(state.players, null)}`, '수정', (amount, root) => {
      if (!who) return (root.querySelector('#err').textContent = '사람을 골라 주세요.');
      run({ type: 'adjust', playerId: who, money: amount });
    }, (root) => bindChoice(root, 'p', (v) => {
      who = v;
      root.querySelector('#amt').value = player(v).money / MAN;
    }), true);
  }

  // ---------- 끝 화면 ----------
  // 플레이어별 결과: 현금 + 땅·건물 가치(건설비용) = 총자산
  function resultOf(p) {
    const tiles = myTiles(p.id);
    const value = tiles.reduce((sum, t) => sum + (t.kind === 'tour' ? G.TOUR_PRICE : G.builtItems(t, prop(t.id)).reduce((a, k) => a + t.cost[k], 0)), 0);
    let monos = 0;
    for (let g = 0; g < G.GROUPS.length; g++) if (G.hasMonopoly(state, p.id, g)) monos++;
    return { tiles, value, total: p.money + value, monos };
  }
  // 승리 이유: 독점한 도시를 색깔별로, 파산·시간 종료는 숫자로
  function winHtml(r, w) {
    const chip = (t) => `<span class="wtile" style="--c:${tileColor(t)}">${esc(t.name)}<i>${builtIcons(t)}</i></span>`;
    const row = (label, color, tiles) => `<div class="wrow" style="--c:${color}"><span class="wlabel">${label}</span><span class="wtiles">${tiles.map(chip).join('')}</span></div>`;
    const mine = (t) => prop(t.id) && prop(t.id).owner === w.id;
    if (r.reason === '트리플 독점') {
      const groups = G.GROUPS.map((g, i) => i).filter((g) => G.hasMonopoly(state, w.id, g));
      return `<div class="wsub">같은 색 도시를 모두 가진 색 ${groups.length}곳</div><div class="wrows">${groups.map((g) =>
        row(esc(G.GROUPS[g].name), G.GROUPS[g].color, G.BOARD.filter((t) => t.kind === 'city' && t.group === g))).join('')}</div>`;
    }
    if (r.reason === '라인 독점') {
      const l = G.LINE_NAMES.findIndex((_, i) => G.BOARD.filter((t) => t.line === i).every(mine));
      if (l >= 0) return `<div class="wsub">게임판 한 줄의 도시·관광지를 모두 가짐</div><div class="wrows">${row(`${G.LINE_NAMES[l]}라인`, pc(w), G.BOARD.filter((t) => t.line === l))}</div>`;
    }
    if (r.reason === '관광지 독점') {
      return `<div class="wsub">관광지 5곳을 모두 가짐</div><div class="wrows">${row('관광지', '#2bb3a3', G.BOARD.filter((t) => t.kind === 'tour'))}</div>`;
    }
    if (r.reason === '나머지 모두 파산') {
      const out = state.players.filter((p) => p.bankrupt);
      return `<div class="wsub">혼자 끝까지 남았어요</div><div class="wout">${out.map((p) => `<span class="wplayer"><span class="dot" style="background:${pc(p)}"></span>${esc(p.name)} ☠️ 파산</span>`).join('')}</div>`;
    }
    if (r.reason === '시간 종료') {
      const x = resultOf(w);
      return `<div class="wsub">게임이 끝났을 때 총자산이 가장 많아요</div><div class="wstats">
        <div><small>마블</small><b>${fmt(w.money)}</b></div><span>+</span>
        <div><small>땅·건물</small><b>${fmt(x.value)}</b></div><span>=</span>
        <div class="tot"><small>총자산</small><b>${fmt(x.total)}</b></div></div>`;
    }
    return r.detail ? `<div class="sub">${esc(r.detail)}</div>` : '';
  }

  function renderEnded() {
    const r = state.result || {};
    const res = Object.fromEntries(state.players.map((p) => [p.id, resultOf(p)]));
    const rank = [...state.players].sort((a, b) => (a.id === r.winnerId ? -1 : b.id === r.winnerId ? 1 : (a.bankrupt - b.bankrupt) || res[b.id].total - res[a.id].total));
    const undoTx = G.lastUndoable(state);
    const canUndo = undoTx && (undoTx.actorId === session.playerId || isHost());
    const w = player(r.winnerId);
    $app.innerHTML = `${topbar()}<div class="wrap narrow">
      <div class="card winner" style="--pc:${pc(w)}"><div class="trophy">🏆</div><h2>${esc(w.name)} 승리!</h2>
        <div class="reason">${esc(r.reason || '')}</div>
        ${winHtml(r, w)}</div>
      ${rank.map((p, i) => {
        const x = res[p.id];
        return `<div class="card result" style="--pc:${pc(p)}">
          <div class="rhead"><b class="rank">${i + 1}</b><span class="dot" style="background:${pc(p)}"></span>
            <b class="${p.bankrupt ? 'out' : ''}">${esc(p.name)}</b>${p.id === r.winnerId ? '<span class="tag now">승리</span>' : ''}${p.bankrupt ? '<span class="tag">파산</span>' : ''}
            <span class="grow"></span><span class="total">${p.bankrupt ? '파산' : fmt(x.total)}</span></div>
          ${p.bankrupt ? '' : `<div class="sub">현금 ${fmt(p.money)} + 땅·건물 ${fmt(x.value)} · 도시 ${x.tiles.length}곳${x.monos ? ` · 컬러독점 ${x.monos}곳` : ''}</div>
          ${x.tiles.length ? `<div class="owned-list">${x.tiles.map((t) => `<span class="ot" style="--c:${tileColor(t)}">${esc(t.name)} ${builtIcons(t)}</span>`).join('')}</div>` : '<div class="muted">가진 도시 없음</div>'}`}
        </div>`;
      }).join('')}
      ${canUndo ? '<div class="center mt"><button class="btn small secondary" id="undo">↩ 잘못 끝났으면 되돌리기</button></div>' : ''}
      ${isHost() ? '<button class="btn accent mt" id="again">같은 사람들과 다시 하기</button>' : ''}
      <button class="btn secondary mt" id="home">${teacher ? '← 전체 보기' : '처음으로'}</button>
    </div>`;
    bindTop();
    if ($app.querySelector('#undo')) $app.querySelector('#undo').onclick = undoDialog;
    if (isHost()) $app.querySelector('#again').onclick = () => confirmBox('새 게임을 준비할까요? (기록이 지워져요)', { type: 'reset' });
    $app.querySelector('#home').onclick = () => {
      if (teacher) return teacherBack();
      if (isHost()) confirmBox('방을 닫을까요?', async () => { if (conn) await conn.leave(); goHome(); });
      else goHome();
    };
  }

  // ---------- 모달 ----------
  // 2. 팝업은 오른쪽 위 ✕(또는 닫기·취소 버튼)로만 닫힘. 바깥을 눌러도 안 닫힘
  // opts.lock: 꼭 해야 하는 일 (✕ 없음). 함수가 false가 되면(일을 마치거나 차례가 넘어가면) 저절로 닫힘
  let modalLock = null;
  function openModal(html, onMount, opts) {
    const lock = opts && opts.lock;
    modalLock = lock || null;
    $modal.innerHTML = `<div class="modal-bg"><div class="modal">${lock ? '' : '<button class="x" data-close aria-label="닫기">✕</button>'}${html}</div></div>`;
    const root = $modal.firstElementChild.firstElementChild;
    root.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => {
      closeModal();
      if (askOnClose) scheduleEnd();
    }));
    root.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => {
      if (run({ type: 'move', to: Number(b.dataset.move) }, { keepOpen: true })) toast('말을 옮겼어요.');
    }));
    if (onMount) onMount(root);
    return root;
  }
  function closeModal() {
    $modal.innerHTML = '';
    modalLock = null;
  }

  // action이 함수면 그 함수를, 객체면 그 동작을 실행
  function confirmBox(msg, action, yes) {
    openModal(`<h3 class="pre">${esc(msg)}</h3><div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>아니요</button><button class="btn accent" id="yes">${esc(yes || '네')}</button></div>`, (root) => {
      root.querySelector('#yes').onclick = async () => {
        if (typeof action !== 'function') return run(action);
        try { await action(); closeModal(); } catch (e) { handleError(e); }
      };
    });
  }

  function playerChips(list, selected) {
    return `<div class="chips">${list.map((p) => `<button class="chip ${p.id === selected ? 'on' : ''}" data-p="${p.id}">
      <span class="dot" style="background:${pc(p)}"></span>${esc(p.name)}</button>`).join('')}</div>`;
  }
  function bindChoice(root, name, onPick) {
    const btns = root.querySelectorAll(`[data-${name}]`);
    btns.forEach((b) => (b.onclick = () => {
      btns.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onPick(b.dataset[name]);
    }));
  }

  // 금액 입력: "금액" 아래 간편 입력, 그 아래 입력칸 · 만 마블 · 확인 버튼, 맨 아래 넓은 취소
  function amountDialog(title, top, okLabel, onOk, onMount, allowZero) {
    openModal(`<h3>${title}</h3>${top}
      <div class="sub">금액</div>
      <div class="chips">${[5, 10, 20, 30, 50, 100].map((v) => `<button class="chip" data-add="${v}">+${v}</button>`).join('')}<button class="chip" data-clear>지우기</button></div>
      <div class="amount"><input type="number" inputmode="decimal" min="0" step="any" id="amt" placeholder="0"><span class="unit">만 마블</span><button class="btn accent" id="ok">${okLabel}</button></div>
      <div class="err" id="err"></div>
      <button class="btn secondary wide" data-close>취소</button>`, (root) => {
      const inp = root.querySelector('#amt');
      root.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => {
        inp.value = Math.round(((Number(inp.value) || 0) + Number(b.dataset.add)) * 10) / 10;
      }));
      root.querySelector('[data-clear]').onclick = () => (inp.value = '');
      root.querySelector('#ok').onclick = () => {
        const v = Math.round(Number(inp.value) * MAN);
        if (!Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) return (root.querySelector('#err').textContent = '금액을 입력해 주세요.');
        onOk(v, root);
      };
      if (onMount) onMount(root);
    });
  }

  function showRules() {
    openModal(`<h3>📖 규칙 요약 (메가 디럭스 룰북)</h3><div class="rules">
      <b>준비</b> 모두 200만 마블. 축제도시 3곳(통행료 ×2)은 앱이 무작위로 정해요.<br>
      <b>월급</b> 출발지를 지날 때마다 30만. 출발지를 지날 때마다 다음 턴.<br>
      <b>건설 턴 제한</b> 첫 턴 빌라까지 → 두 번째 빌딩까지 → 세 번째 호텔까지 → 그 뒤 자유. 랜드마크는 빌라·빌딩·호텔이 다 있으면(함께 지어도 됨) 네 번째 턴부터. 앱 + 실물 방은 출발지를 지나 도착한 칸에서 거래하면 월급과 턴이 자동으로 올라가요.<br>
      <b>통행료</b> 건설된 건물의 통행료 합. 컬러독점 ×2, 축제 ×2, 올림픽 ×2~×5가 겹쳐서 적용.<br>
      <b>관광지</b> 구매 10만. 섬(독도·하와이·푸켓)은 가진 섬 개수, 해변(발리·타히티)은 방문 횟수로 깃발 8만 → 파라솔 16만 → 방갈로 32만. 매각 5만, 인수 불가.<br>
      <b>인수</b> 통행료를 낸 뒤 인수비용(건설비용 2배)을 주인에게. 관광지·랜드마크 도시는 불가.<br>
      <b>매각</b> 통행료·세금이 부족할 때만. 매각비용(건설비용 절반)을 은행에서.<br>
      <b>특수칸</b> 국세청 20만 · 무인도 보석금 20만 · 올림픽 개최 10만(한 곳에만) · 세계여행 10만 · 보너스 게임 40/80/160만.<br>
      <b>📱 앱으로만 하는 방</b> 시작하면 주사위로 순서를 정해요(높은 사람부터, 같으면 다시). 내 차례에 주사위 → 말이 한 칸씩 이동 → 도착한 칸 화면이 열려요. 더블이면 한 번 더, 세 번 연속 더블이면 무인도. 무인도는 3차례 쉬고 더블·보석금·탈출 카드로 나와요. 세계여행 칸에 서면 다음 차례에 주사위 대신 10만 내고 원하는 도시로 가서 사거나 짓기 (안 가고 주사위를 굴려도 됨, 더블로 도착했으면 지금 가거나 한 번 더). 포춘카드는 랜덤으로 뽑고 보관 카드(천사·할인쿠폰·방패·무인도 탈출·월급 부스터)는 1장만, 공격을 받으면 방패(없으면 천사)로 자동 방어.<br>
      <b>승리</b> 트리플 독점(컬러독점 3곳) · 라인 독점 · 관광지 독점 · 나머지 모두 파산 · 시간 종료 시 총자산(마블 + 땅·건물·랜드마크 건설비용) 1등.
      </div><div class="row mt"><a class="btn secondary" href="rulebook.pdf" download="모두의마블_보조앱_룰북.pdf" target="_blank">📖 룰북 PDF 받기</a>
      <button class="btn secondary" data-close>닫기</button></div>`);
  }

  // ---------- 게임 시간 (타이머) ----------
  function timeLeft(endAt) {
    const sec = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    if (!sec) return '시간 끝';
    const m = Math.floor(sec / 60);
    return `${m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : m}:${String(sec % 60).padStart(2, '0')}`;
  }
  const limitText = (st) => (st.timeLimit ? `⏰ 게임 시간 ${st.timeLimit}분` : '⏰ 게임 시간 없음');
  // targets: 선생님 화면에서 여러 방에 한꺼번에 ([{ state, conn }]). 없으면 지금 방
  function timerDialog(targets) {
    const list = targets || null;
    const playing = list ? list.some((e) => e.state && e.state.status === 'playing') : state.status === 'playing';
    const send = (action) => {
      if (!list) return run(action);
      for (const e of list) {
        if (!e.state || e.state.status === 'ended' || (action.type === 'end' && e.state.status !== 'playing')) continue;
        e.conn.act(action).catch((err) => toast(`${e.state.title || e.state.code}: ${err.message}`, 'err'));
      }
      closeModal();
    };
    openModal(`<h3>⏰ 게임 시간${list ? ' — 모든 방' : ''}</h3>
      <div class="sub">${playing ? '<b>지금부터</b> 몇 분 뒤에 끝낼까요?' : '게임을 <b>시작하면 그때부터</b> 시간이 흘러요.'} 시간이 다 되면 게임이 끝나고, 총자산(마블 + 땅·건물·랜드마크 건설비용)이 가장 많은 사람이 이겨요.</div>
      <div class="chips big">${[10, 20, 30, 40, 50, 60, 90].map((n) => `<button class="chip" data-min="${n}">${n}분</button>`).join('')}</div>
      <div class="row"><input type="number" id="min" class="minput" min="1" max="600" placeholder="직접 입력 (분)"><button class="btn accent" id="set">맞추기</button></div>
      <div class="err" id="err"></div>
      <div class="row mt"><button class="btn secondary" id="off">타이머 끄기</button><button class="btn secondary" data-close>닫기</button></div>
      ${playing ? `<button class="btn danger wide mt" id="endnow">⏹ 지금 게임 끝내기 (총자산 1등 승리)</button>` : ''}`, (root) => {
      root.querySelectorAll('[data-min]').forEach((b) => (b.onclick = () => send({ type: 'timer', minutes: Number(b.dataset.min) })));
      root.querySelector('#set').onclick = () => {
        const n = Math.round(Number(root.querySelector('#min').value));
        if (!(n >= 1 && n <= 600)) return (root.querySelector('#err').textContent = '1~600분 사이로 적어 주세요.');
        send({ type: 'timer', minutes: n });
      };
      root.querySelector('#off').onclick = () => send({ type: 'timer', minutes: 0 });
      if (root.querySelector('#endnow')) root.querySelector('#endnow').onclick = () => confirmBox(
        `${list ? '게임 중인 모든 방을' : '지금 게임을'} 끝낼까요?\n총자산(마블 + 땅·건물 건설비용)이 가장 많은 사람이 이겨요.`,
        () => send({ type: 'end', reason: 'time' }), '게임 끝내기');
    });
  }
  // 1초마다 남은 시간 표시, 시간이 다 되면 방장(은행) 기기가 게임을 끝냄
  const timeUp = new Set();
  setInterval(() => {
    document.querySelectorAll('[data-endat]').forEach((el) => (el.textContent = `⏰ ${timeLeft(Number(el.dataset.endat))}`));
    const hosted = teacher ? Object.values(T.rooms) : session && session.host && conn ? [{ state: serverState || state, conn }] : [];
    for (const e of hosted) {
      const st = e.state;
      if (!st || !e.conn || st.status !== 'playing' || !st.endAt || Date.now() < st.endAt) continue;
      const key = `${st.code}:${st.endAt}`;
      if (timeUp.has(key)) continue;
      timeUp.add(key);
      e.conn.act({ type: 'end', reason: 'time' }).catch(() => timeUp.delete(key));
    }
  }, 1000);

  // ---------- 컴퓨터 플레이어 (앱으로만 하는 방) ----------
  function botButton(host) {
    if (!host) return '';
    const full = state.players.length >= 4;
    return `<button class="btn secondary small mt" id="addbot" ${full ? 'disabled' : ''}>🤖 컴퓨터 추가</button>
      <div class="sub">컴퓨터 차례는 ${teacher ? '이 컴퓨터' : '방장 기기'}가 자동으로 진행해요. 말 색은 시작할 때 남은 색으로 정해져요.${state.mode === 'app' ? ''
        : ' 컴퓨터가 있으면 앱이 차례를 관리해요: 주사위로 순서를 정하고, 사람은 실물로 하다가 차례 끝을 누르고, 컴퓨터가 한 일은 기록을 보고 실물에도 올려 주세요.'}</div>`;
  }
  function bindBotButton() {
    const b = $app.querySelector('#addbot');
    if (b) b.onclick = () => run({ type: 'addBot' });
  }
  // 방장(은행) 기기: 컴퓨터 차례면 MarbleBot이 고른 동작을 보냄. 동작 사이에 사람이 볼 시간을 둠
  const Bot = window.MarbleBot;
  const botWait = {};
  const botFails = {};
  setInterval(() => {
    const hosted = teacher ? Object.values(T.rooms) : session && session.host && conn ? [{ state: serverState || state, conn }] : [];
    for (const e of hosted) {
      const st = e.state;
      if (!st || !e.conn || (st.mode !== 'app' && !st.withBots) || st.status !== 'playing') continue;
      if ((botWait[st.code] || 0) > Date.now()) continue;
      for (const p of st.players) {
        if (!p.bot || p.bankrupt) continue;
        const step = Bot.next(st, p.id);
        if (!step) continue;
        botWait[st.code] = Date.now() + step.wait;
        e.conn.actAs(p.id, step.action).then(() => (botFails[st.code] = 0), (err) => {
          console.warn('컴퓨터 동작 실패', step.action, err.message);
          botWait[st.code] = Date.now() + 1000;
          // 계속 막히면 방장 권한으로 차례를 넘겨 게임이 멈추지 않게
          if ((botFails[st.code] = (botFails[st.code] || 0) + 1) >= 3) {
            botFails[st.code] = 0;
            e.conn.act({ type: 'endTurn' }).catch(() => {});
          }
        });
        break;
      }
    }
  }, 700);

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
  if (teacher && teacher.rooms && teacher.rooms.length && !session) {
    for (const sess of teacher.rooms) teacherConnect(sess);
    render();
  } else {
    if (teacher) { teacher = null; saveTeacher(); }
    if (session) connect(); else render();
  }
})();
