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
    if (!session.host && action.type !== 'undo') {
      const copy = G.roomFromPublic(state);
      G.applyAction(copy, session.playerId, action); // 안 되는 동작이면 여기서 바로 오류
      const next = G.publicState(copy);
      predictedNext = next.nextTxId;
      state = next;
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
    let p;
    try {
      p = act(action);
    } catch (e) {
      handleError(e, action, o);
      return false;
    }
    if (!o.keepOpen) closeModal();
    p.catch((e) => handleError(e, action, o));
    return true;
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
      openModal(`<h3>마블이 ${fmt(need - m.money)} 부족해요</h3>
        <div class="sub">도시를 매각해서 마련하세요. 매각한 도시는 건물을 모두 치우고 도시증서를 반납해요.</div>
        ${list.length ? `<div class="tiles">${list.map((t) => `<button class="tile" data-sell="${t.id}" style="--c:${tileColor(t)}">
          <b>${esc(t.name)}</b><span class="tp">매각 +${fmt(G.sellPrice(state, t.id))}</span></button>`).join('')}</div>` : '<p>매각할 도시가 없어요.</p>'}
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn danger" id="bk">파산하기</button></div>`, (root) => {
        root.querySelectorAll('[data-sell]').forEach((b) => (b.onclick = () => {
          if (run({ type: 'sell', tileId: b.dataset.sell }, { keepOpen: true })) show();
        }));
        root.querySelector('#bk').onclick = () => bankruptDialog(o.creditor);
      });
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
    if (!(pending && s.nextTxId < predictedNext)) state = s;
    if (!firstState) {
      for (const tx of s.log) {
        if (tx.id <= lastSeenTx || tx.actorId === session.playerId || tx.kind === 'start') continue;
        const d = tx.deltas[session.playerId];
        if (d) {
          toast(`${d > 0 ? '+' : ''}${fmt(d)} · ${tx.text}`, d > 0 ? 'plus' : 'minus');
          vibrate(d > 0 ? [60, 40, 60] : 200);
        }
      }
      if (prevStatus === 'playing' && s.status === 'ended') vibrate([100, 50, 100, 50, 200]);
    }
    lastSeenTx = s.log.length ? s.log[s.log.length - 1].id : 0;
    firstState = false;
    render();
  }

  // ---------- 화면 공통 ----------
  function render() {
    if (!session) return renderHome();
    if (!state) {
      $app.innerHTML = `${topbar()}<div class="wrap narrow"><div class="card center">연결 중...</div>
        <button class="btn secondary" id="bk">처음으로</button></div>`;
      bindTop();
      $app.querySelector('#bk').onclick = () => goHome();
      return;
    }
    if (state.status === 'lobby') return renderLobby();
    if (state.status === 'playing') return renderGame();
    return renderEnded();
  }

  function topbar() {
    return `<div class="topbar"><b>🎲 마블 은행</b>
      <span class="grow"></span>
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
    const text = `모두의 마블 은행 방 번호: ${session.code}\n${url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: '모두의 마블 은행', text, url });
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
  function renderHome() {
    const params = new URLSearchParams(location.search);
    $app.innerHTML = `${topbar()}<div class="wrap narrow">
      <div class="hero"><div class="logo">🎲💰</div><h1>모두의 마블 은행</h1><p>보드게임 돈 계산을 각자 휴대폰·태블릿으로</p></div>
      <div class="card">
        <label class="field"><span>내 이름</span><input type="text" id="name" maxlength="12" placeholder="예: 엄마" value="${esc(lastName())}"></label>
        <div class="sub">튕겼다면 같은 이름으로 같은 방에 들어가면 그대로 이어져요.</div>
      </div>
      <div class="card"><h2>열려 있는 방</h2><div id="rooms"></div></div>
      <div class="card">
        <h2>방 번호로 들어가기</h2>
        <div class="row"><input type="tel" id="code" inputmode="numeric" maxlength="4" placeholder="1234" value="${esc(params.get('room') || '')}">
          <button class="btn" id="join">들어가기</button></div>
      </div>
      <button class="btn accent" id="create">새 방 만들기 (방장)</button>
      <div class="err center" id="err"></div>
      <button class="btn secondary mt" id="rules">규칙 요약</button>
    </div>`;
    bindTop();
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
        const r = await N.createRoom(name);
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
      <span class="name">${esc(r.host)}의 방 <span class="tag">${esc(r.code)}</span>
        <span class="muted">${r.players.map(esc).join(', ')} · ${r.players.length}/4${r.status === 'playing' ? ' · 게임 중' : ''}</span></span>
      ${r.status === 'playing'
        ? `<button class="btn small secondary" data-join="${esc(r.code)}" data-broker="${esc(r.broker)}">이어하기</button>`
        : r.players.length < 4 ? `<button class="btn small" data-join="${esc(r.code)}" data-broker="${esc(r.broker)}">참가</button>` : '<span class="tag">가득 참</span>'}
    </li>`).join('')}</ul>`;
    el.querySelectorAll('[data-join]').forEach((b) => (b.onclick = () => joinFromHome(b.dataset.join, b.dataset.broker)));
  }

  // ---------- 대기실 ----------
  function renderLobby() {
    const host = isHost();
    $app.innerHTML = `${topbar()}<div class="wrap narrow">
      <div class="card center">
        <div class="muted">방 번호</div>
        <div class="bigcode">${esc(state.code)}</div>
        <button class="btn secondary small" id="share2">📤 참가 링크 보내기</button>
      </div>
      <div class="card">
        <h2>참가자 ${state.players.length}/4</h2>
        <ul class="plist">${state.players.map((p) => `<li>
          <span class="dot" style="background:${p.color}"></span>
          <span class="name">${esc(p.name)}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${p.id === session.playerId ? '<span class="tag">나</span>' : ''}</span>
          ${host && p.id !== state.hostId ? `<button class="link" data-kick="${p.id}">내보내기</button>` : ''}
        </li>`).join('')}</ul>
      </div>
      ${host
        ? `<button class="btn accent" id="start" ${state.players.length < 2 ? 'disabled' : ''}>게임 시작 (모두 ${fmt(G.START_MONEY)}, 축제도시 3곳 무작위)</button>
           <div class="sub mt">📱 방장 기기가 은행 역할을 해요. 게임하는 동안 방장 기기는 이 화면을 켜 두세요.</div>`
        : '<div class="card center muted">방장이 게임을 시작하기를 기다리는 중...</div>'}
      <div class="row mt"><button class="btn secondary" id="rules">규칙 요약</button><button class="btn secondary" id="leave">나가기</button></div>
    </div>`;
    bindTop();
    $app.querySelector('#share2').onclick = share;
    $app.querySelector('#rules').onclick = showRules;
    $app.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = () => confirmBox(`${player(b.dataset.kick).name}님을 내보낼까요?`, { type: 'kick', playerId: b.dataset.kick });
    });
    if (host) $app.querySelector('#start').onclick = () => run({ type: 'start' });
    $app.querySelector('#leave').onclick = () => confirmBox(host ? '방을 닫을까요? 다른 사람도 나가게 돼요.' : '방에서 나갈까요?', async () => {
      if (conn) await conn.leave();
      goHome();
    });
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
  function tileButton(t, attr) {
    const pr = prop(t.id);
    const owner = pr && player(pr.owner);
    return `<button class="tile ${owner ? 'owned' : ''}" ${attr || `data-tile="${t.id}"`} style="--c:${tileColor(t)};${owner ? `--o:${owner.color}` : ''}">
      <b>${esc(t.name)}</b>
      <span class="tp">${owner ? builtIcons(t) : fmt(t.kind === 'tour' ? G.TOUR_PRICE : t.cost.land)}</span>
      <span class="tb">${tileBadges(t)}</span>
    </button>`;
  }
  function boardHtml(filter) {
    return [0, 1, 2, 3].map((l) => `<div class="line"><span class="ln">${G.LINE_NAMES[l]}</span><div class="tiles">
      ${G.BOARD.filter((t) => t.line === l).map((t) => (filter ? tileButton(t, filter(t) ? `data-pick="${t.id}"` : 'disabled') : tileButton(t))).join('')}
    </div></div>`).join('');
  }

  function renderGame() {
    const m = me();
    const host = isHost();
    const undoTx = G.lastUndoable(state);
    const canUndo = undoTx && (undoTx.actorId === m.id || host);
    $app.innerHTML = `${topbar()}<div class="game">
      <section>
        <div class="me ${m.bankrupt ? 'bankrupt' : ''}" style="--pc:${m.color}">
          <div class="who">${esc(m.name)}${host ? ' · 방장' : ''} · ${m.bankrupt ? '파산' : `${m.laps + 1}번째 턴 (${G.ITEM_NAMES[G.maxBuilding(m)]}까지 건설)`}</div>
          <div class="bal">${fmt(m.money)} <small>마블</small></div>
        </div>
        ${m.bankrupt ? '' : `<div class="actions">
          <button class="act" data-a="salary">🏁<span>월급 30만</span></button>
          <button class="act" data-a="bail">🏝️<span>보석금 20만</span></button>
          <button class="act" data-a="tax">🧾<span>국세청 20만</span></button>
          <button class="act" data-a="travel">✈️<span>세계여행 10만</span></button>
          <button class="act" data-a="olympic">🏅<span>올림픽 10만</span></button>
          <button class="act" data-a="bonus">🪙<span>보너스 게임</span></button>
          <button class="act" data-a="fortune">🃏<span>포춘카드</span></button>
          <button class="act" data-a="transfer">💸<span>송금</span></button>
        </div>`}
        <div class="card board"><div class="sub">도착한 칸을 누르세요 · 🎉축제 🏅올림픽 😷전염병 🌫️황사 ⚡정전</div>${boardHtml()}</div>
      </section>
      <section>
        <div class="card">
          <ul class="plist">${state.players.map((p) => `<li>
            <span class="dot" style="background:${p.color}"></span>
            <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}</span>
            <span class="muted">${p.bankrupt ? '파산' : `${p.laps + 1}턴 · 땅 ${myTiles(p.id).length}`}</span>
            <span class="money">${fmt(p.money)}</span>
          </li>`).join('')}</ul>
        </div>
        <div class="card">
          <div class="loghead"><h2>기록</h2><button class="btn small undo" id="undo" ${canUndo ? '' : 'disabled'}>↩ 되돌리기</button></div>
          ${logHtml()}
        </div>
        <div class="row">
          ${host ? '<button class="btn secondary small" id="hostmenu">방장 메뉴</button>' : ''}
          <button class="btn secondary small" id="rules">규칙 요약</button>
          ${m.bankrupt ? '' : '<button class="btn danger small" id="bankrupt">파산</button>'}
        </div>
      </section>
    </div>`;
    bindTop();
    $app.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => ACTIONS[b.dataset.a]()));
    $app.querySelectorAll('[data-tile]').forEach((b) => (b.onclick = () => tileSheet(b.dataset.tile)));
    const q = (s) => $app.querySelector(s);
    q('#undo').onclick = undoDialog;
    q('#rules').onclick = showRules;
    if (q('#hostmenu')) q('#hostmenu').onclick = hostMenu;
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

  function buildChecks(t, pr) {
    const m = me();
    const built = (pr && pr.built) || {};
    const ready = built.villa && built.building && built.hotel;
    const list = (pr ? G.BUILDINGS : ['villa', 'building', 'hotel']).filter((k) => !built[k]);
    if (!list.length) return '';
    return `<div class="checks">${list.map((k) => {
      const why = !G.canBuild(m, k) ? `${m.laps + 1}번째 턴은 ${G.ITEM_NAMES[G.maxBuilding(m)]}까지` : k === 'landmark' && !ready ? '빌라·빌딩·호텔 필요' : '';
      return `<label class="check ${why ? 'off' : ''}"><input type="checkbox" data-item="${k}" ${why ? 'disabled' : ''}>
        ${ICON[k]} ${G.ITEM_NAMES[k]} <span class="muted">${fmt(t.cost[k])}</span>${why ? `<small>${why}</small>` : ''}</label>`;
    }).join('')}</div>`;
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
      <div class="sub">${owner ? `주인 <b>${esc(owner.name)}</b> ${builtIcons(t)}` : '주인 없음'}</div>`;

    // 빈 땅 → 구매
    if (!pr) {
      openModal(`${head}${priceTable(t)}
        ${t.kind === 'city' ? `<div class="sub">같이 지을 건물</div>${buildChecks(t, null)}` : ''}
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>닫기</button><button class="btn accent" id="buy">구매 <span id="pv"></span></button></div>`, (root) => {
        const total = () => (t.kind === 'tour' ? G.TOUR_PRICE : t.cost.land + checked(root).reduce((s, k) => s + t.cost[k], 0));
        const upd = () => (root.querySelector('#pv').textContent = fmt(total()));
        root.querySelectorAll('[data-item]').forEach((c) => (c.onchange = upd));
        upd();
        root.querySelector('#buy').onclick = () => run({ type: 'buy', tileId: t.id, items: checked(root) });
      });
      return;
    }

    // 내 땅 → 건설 / 도착
    if (pr.owner === m.id) {
      const toll = G.tollInfo(state, t.id);
      const fx = state.effects[t.id];
      const checks = t.kind === 'city' ? buildChecks(t, pr) : '';
      openModal(`${head}${priceTable(t)}
        <div class="preview"><span>지금 통행료</span><b>${fmt(toll.amount)}</b></div>
        ${toll.parts.length ? `<div class="sub">${toll.parts.join(' · ')}</div>` : ''}
        ${checks ? `<div class="sub">건물 짓기 (도착했을 때)</div>${checks}` : ''}
        <div class="err" id="err"></div>
        <div class="row"><button class="btn secondary" data-close>닫기</button>
          ${t.tour === 'beach' || fx ? `<button class="btn secondary" id="arrive">도착 ${t.tour === 'beach' ? '(방문 +1)' : '(효과 해제)'}</button>` : ''}
          ${checks ? '<button class="btn accent" id="build">건설 <span id="pv"></span></button>' : ''}</div>`, (root) => {
        const upd = () => { const el = root.querySelector('#pv'); if (el) el.textContent = fmt(checked(root).reduce((s, k) => s + t.cost[k], 0)); };
        root.querySelectorAll('[data-item]').forEach((c) => (c.onchange = upd));
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
    openModal(`${head}${priceTable(t)}
      <div class="preview"><span>낼 통행료</span><b id="pv"></b></div>
      <div class="sub" id="parts"></div>
      <div class="checks"><label class="check"><input type="checkbox" id="angel"> 😇 천사 카드 (면제)</label>
        <label class="check"><input type="checkbox" id="coupon"> 🎫 할인쿠폰 (50%)</label></div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>닫기</button><button class="btn accent" id="pay">${esc(owner.name)}에게 통행료 내기</button></div>
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
    });
  }

  function takeoverAsk(t) {
    const pr = prop(t.id);
    if (!pr || pr.owner === session.playerId || state.status !== 'playing') return;
    const price = G.takeoverPrice(state, t.id);
    openModal(`<h3>🤝 ${esc(t.name)} 인수할까요?</h3>
      <div class="preview"><span>인수비용 (${esc(player(pr.owner).name)}에게)</span><b>${fmt(price)}</b></div>
      <div class="sub">인수하면 이어서 건물을 지을 수 있어요.</div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>인수 안 함</button><button class="btn accent" id="ok">인수하기</button></div>`, (root) => {
      root.querySelector('#ok').onclick = () => {
        if (run({ type: 'takeover', tileId: t.id }) && state.status === 'playing') tileSheet(t.id);
      };
    });
  }

  // ---------- 특수 칸 / 포춘카드 ----------
  // 칸 고르기: filter에 맞는 칸만 누를 수 있음
  function pickTile(title, note, filter, onPick) {
    const any = G.BOARD.some(filter);
    openModal(`<h3>${title}</h3>${note ? `<div class="sub">${note}</div>` : ''}
      ${any ? `<div class="board">${boardHtml(filter)}</div>` : '<p>고를 수 있는 도시가 없어요.</p>'}
      <div class="err" id="err"></div>
      <button class="btn secondary wide" data-close>취소</button>`, (root) => {
      root.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => onPick(b.dataset.pick)));
    });
  }
  const mineF = (t) => prop(t.id) && prop(t.id).owner === session.playerId;
  const theirsF = (t) => prop(t.id) && prop(t.id).owner !== session.playerId;
  const noLm = (t) => !(prop(t.id) && prop(t.id).built && prop(t.id).built.landmark);
  const SHIELD = '상대가 방패나 천사 카드로 막으면 쓰지 마세요.';

  const ACTIONS = {
    salary() {
      openModal(`<h3>🏁 출발지를 지나 월급 받기</h3>
        <label class="check"><input type="checkbox" id="boost"> 💰 월급 부스터 카드 사용 (2배)</label>
        <div class="sub">월급을 받으면 다음 턴이 돼요 (턴 제한: 첫 턴 빌라 → 빌딩 → 호텔 → 자유).</div>
        <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn accent" id="ok">받기</button></div>`, (root) => {
        root.querySelector('#ok').onclick = () => run({ type: 'salary', booster: root.querySelector('#boost').checked });
      });
    },
    bail: () => confirmBox(`🏝️ 무인도 보석금 ${fmt(G.BAIL)}을 내고 탈출할까요?`, { type: 'pay', what: 'bail' }, '내기'),
    tax: () => confirmBox(`🧾 국세청 세금 ${fmt(G.TAX)}을 낼까요?`, { type: 'pay', what: 'tax' }, '내기'),
    travel: () => confirmBox(`✈️ 세계여행 비용 ${fmt(G.TRAVEL)}을 낼까요?\n출발지를 지나가면 월급도 받으세요.`, { type: 'pay', what: 'travel' }, '내기'),
    olympic() {
      pickTile('🏅 올림픽을 개최할 내 도시', `개최비용 ${fmt(G.OLYMPIC_COST)}. 올림픽은 한 곳에만 — 같은 도시는 ×3·×4·×5로, 다른 도시는 마크를 옮겨 ×2`, (t) => t.kind === 'city' && mineF(t), (id) => run({ type: 'olympic', tileId: id }));
    },
    bonus() {
      openModal(`<h3>🪙 보너스 게임</h3><div class="sub">코인 앞뒤를 연속 몇 번 맞혔나요? (도전하다 틀리면 0)</div>
        <div class="chips big">${['실패', '1회 40만', '2회 80만', '3회 160만'].map((l, i) => `<button class="chip" data-w="${i}">${l}</button>`).join('')}</div>
        <button class="btn secondary wide" data-close>취소</button>`, (root) => {
        root.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => run({ type: 'bonus', wins: Number(b.dataset.w) })));
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
  };

  // 포춘카드 21종 (룰북 12쪽)
  const CARDS = [
    ['명령', [
      ['월급 부스터', 'gold', '출발지를 지날 때 월급 2배', () => ACTIONS.salary()],
      ['후원금', 'gold', '모두에게서 10만씩 받기', () => confirmBox('모두에게서 후원금 10만씩 받을까요?\n(10만이 없으면 가진 만큼)', { type: 'sponsor' }, '받기')],
      ['세계여행 초대장', 'gold', '세계여행으로 이동, 다음 차례에 비용 10만', () => ACTIONS.travel()],
      ['올림픽 개최', 'silver', '10만 내고 원하는 도시에 개최', () => ACTIONS.olympic()],
      ['출발지로 GO', 'silver', '출발지로 이동해 월급, 내 도시에 건설', () => ACTIONS.salary()],
      ['보너스 게임', 'silver', '보너스 게임으로 이동', () => ACTIONS.bonus()],
      ['강제징수', 'bronze', '국세청으로 이동해 세금 20만', () => ACTIONS.tax()],
      ['도시기부', 'bronze', '내 도시 하나를 상대에게', () => donateDialog()],
      ['올림픽 관광', 'bronze', '올림픽 개최지로 이동해 통행료', () => (state.olympic ? tileSheet(state.olympic.tileId) : toast('올림픽 개최지가 없어 패스예요.'))],
      ['무인도 탐험', 'bronze', '무인도로 즉시 이동 (월급 없음)', null],
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

  function fortuneDialog() {
    openModal(`<h3>🃏 포춘카드</h3>
      ${CARDS.map(([group, list], gi) => `<div class="sub">${group}</div><div class="cards">${list.map(([name, tier, desc, fn], ci) =>
        `<button class="fcard ${tier} ${fn ? '' : 'info'}" data-c="${gi}-${ci}"><b>${name}</b><small>${desc}</small></button>`).join('')}</div>`).join('')}
      <button class="btn secondary wide" data-close>닫기</button>`, (root) => {
      root.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => {
        const [gi, ci] = b.dataset.c.split('-').map(Number);
        const card = CARDS[gi][1][ci];
        if (card[3]) card[3]();
        else toast(`${card[0]}: ${card[2]} — 앱에서 할 일은 없어요.`);
      }));
    });
  }

  function attack(type, title, extra) {
    pickTile(`${title} — 상대 도시 고르기`, SHIELD, (t) => theirsF(t) && extra(t), (id) => run({ type, tileId: id }));
  }
  function swapDialog() {
    pickTile('🔄 도시체인지 — 가져올 상대 도시', `랜드마크 도시는 제외. ${SHIELD}`, (t) => theirsF(t) && noLm(t), (theirs) =>
      pickTile(`🔄 ${G.TILE[theirs].name}과(와) 바꿀 내 도시`, '', (t) => mineF(t) && noLm(t), (mine) => run({ type: 'swap', tileId: theirs, mineId: mine })));
  }
  function donateDialog() {
    pickTile('🎁 도시기부 — 줄 내 도시', '', mineF, (id) => {
      openModal(`<h3>🎁 ${esc(G.TILE[id].name)}을(를) 누구에게?</h3>${playerChips(others(), null)}
        <button class="btn secondary wide" data-close>취소</button>`, (root) => bindChoice(root, 'p', (to) => run({ type: 'donate', tileId: id, to })));
    });
  }

  // ---------- 파산 / 방장 메뉴 ----------
  function bankruptDialog(creditor) {
    let to = creditor || '';
    openModal(`<h3>☠️ 파산</h3>
      <p>게임에서 빠지고 내 땅·건물은 모두 치워요. 남은 마블 ${fmt(me().money)}은(는) 빚진 사람에게 가요.</p>
      <div class="sub">누구에게 빚졌나요?</div>
      <div class="chips"><button class="chip ${to ? '' : 'on'}" data-p="">🏦 은행 (세금 등)</button>
      ${others().map((p) => `<button class="chip ${p.id === to ? 'on' : ''}" data-p="${p.id}"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>
      <div class="err" id="err"></div>
      <div class="row"><button class="btn secondary" data-close>취소</button><button class="btn danger" id="ok">파산</button></div>`, (root) => {
      bindChoice(root, 'p', (v) => (to = v));
      root.querySelector('#ok').onclick = () => run({ type: 'bankrupt', to: to || undefined });
    });
  }

  function hostMenu() {
    openModal(`<h3>방장 메뉴</h3>
      <div class="row"><button class="btn secondary" id="adj">잔액 직접 수정</button><button class="btn secondary" id="hbk">다른 사람 파산 처리</button></div>
      <div class="sub mt">게임 종료 (독점은 자동으로 판정돼요)</div>
      <div class="chips"><button class="chip" data-e="time">⏰ 시간 종료 — 마블 1등 승리</button>
        <button class="chip" data-e="triple">트리플 독점</button><button class="chip" data-e="line">라인 독점</button><button class="chip" data-e="tour">관광지 독점</button></div>
      <button class="btn secondary wide mt" data-close>닫기</button>`, (root) => {
      root.querySelector('#adj').onclick = adjustDialog;
      root.querySelector('#hbk').onclick = () => {
        openModal(`<h3>누구를 파산 처리할까요?</h3>${playerChips(state.players.filter((p) => !p.bankrupt && p.id !== session.playerId), null)}
          <div class="err" id="err"></div><button class="btn secondary wide" data-close>취소</button>`, (r) =>
          bindChoice(r, 'p', (v) => confirmBox(`${player(v).name}님을 파산 처리할까요? (남은 마블은 은행으로)`, { type: 'bankrupt', playerId: v })));
      };
      root.querySelectorAll('[data-e]').forEach((b) => (b.onclick = () => {
        if (b.dataset.e === 'time') return confirmBox('지금 게임을 끝낼까요? 마블이 가장 많은 사람이 이겨요.', { type: 'end', reason: 'time' });
        openModal(`<h3>누가 이겼나요?</h3>${playerChips(state.players.filter((p) => !p.bankrupt), null)}<button class="btn secondary wide" data-close>취소</button>`, (r) =>
          bindChoice(r, 'p', (v) => run({ type: 'end', reason: b.dataset.e, winnerId: v })));
      }));
    });
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
  function renderEnded() {
    const r = state.result || {};
    const rank = [...state.players].sort((a, b) => (a.id === r.winnerId ? -1 : b.id === r.winnerId ? 1 : (a.bankrupt - b.bankrupt) || b.money - a.money));
    const undoTx = G.lastUndoable(state);
    const canUndo = undoTx && (undoTx.actorId === session.playerId || isHost());
    $app.innerHTML = `${topbar()}<div class="wrap narrow">
      <div class="card winner"><div class="trophy">🏆</div><h2>${esc(player(r.winnerId).name)} 승리!</h2><div class="muted">${esc(r.reason || '')}</div></div>
      <div class="card"><ul class="plist">${rank.map((p, i) => `<li><b>${i + 1}</b><span class="dot" style="background:${p.color}"></span>
        <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}</span><span class="money">${p.bankrupt ? '파산' : fmt(p.money)}</span></li>`).join('')}</ul></div>
      <div class="card"><div class="loghead"><h2>기록</h2><button class="btn small undo" id="undo" ${canUndo ? '' : 'disabled'}>↩ 되돌리기</button></div>${logHtml()}</div>
      ${isHost() ? '<button class="btn accent" id="again">같은 사람들과 다시 하기</button>' : ''}
      <button class="btn secondary mt" id="home">처음으로</button>
    </div>`;
    bindTop();
    $app.querySelector('#undo').onclick = undoDialog;
    if (isHost()) $app.querySelector('#again').onclick = () => confirmBox('새 게임을 준비할까요? (기록이 지워져요)', { type: 'reset' });
    $app.querySelector('#home').onclick = () => {
      if (isHost()) confirmBox('방을 닫을까요?', async () => { if (conn) await conn.leave(); goHome(); });
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
    if (onMount) onMount(root);
    return root;
  }
  function closeModal() { $modal.innerHTML = ''; }

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
      <span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}</div>`;
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
      <b>건설 턴 제한</b> 첫 턴 빌라까지 → 두 번째 빌딩까지 → 세 번째 호텔까지 → 그 뒤 자유. 랜드마크는 빌라·빌딩·호텔이 다 있는 내 도시에 도착했을 때.<br>
      <b>통행료</b> 건설된 건물의 통행료 합. 컬러독점 ×2, 축제 ×2, 올림픽 ×2~×5가 겹쳐서 적용.<br>
      <b>관광지</b> 구매 10만. 섬(독도·하와이·푸켓)은 가진 섬 개수, 해변(발리·타히티)은 방문 횟수로 깃발 8만 → 파라솔 16만 → 방갈로 32만. 매각 5만, 인수 불가.<br>
      <b>인수</b> 통행료를 낸 뒤 인수비용(건설비용 2배)을 주인에게. 관광지·랜드마크 도시는 불가.<br>
      <b>매각</b> 통행료·세금이 부족할 때만. 매각비용(건설비용 절반)을 은행에서.<br>
      <b>특수칸</b> 국세청 20만 · 무인도 보석금 20만 · 올림픽 개최 10만(한 곳에만) · 세계여행 10만 · 보너스 게임 40/80/160만.<br>
      <b>승리</b> 트리플 독점(컬러독점 3곳) · 라인 독점 · 관광지 독점 · 나머지 모두 파산 · 시간 종료 시 마블 1등.
      </div><button class="btn secondary wide mt" data-close>닫기</button>`);
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
