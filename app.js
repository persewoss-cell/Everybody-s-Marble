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
  const pc = (p) => (p && p.color) || '#a9b0c0';
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
    if (!NO_END_ASK.includes(action.type)) scheduleEnd();
    return true;
  }

  // 앱으로만 하는 방: 주사위를 굴리고 할 일을 한 뒤 차례를 끝낼지 물어봄
  const NO_END_ASK = ['roll', 'orderRoll', 'endTurn', 'undo', 'move', 'travelTo', 'draw', 'keepCard', 'kick', 'start', 'pickColor', 'reset', 'end', 'adjust'];
  // 한 번에 하나만 기다리도록 타이머 하나로 관리
  let endTimer = null;
  let askOnClose = false; // 도착·포춘카드 뒤 뜬 창을 닫으면 차례 끝을 물어봄
  function scheduleEnd(title, delay) {
    clearTimeout(endTimer);
    endTimer = setTimeout(() => askEndTurn(0, title), delay || 400);
  }
  function askEndTurn(tries, title) {
    endTimer = null;
    if (tries > 150 || !state || state.mode !== 'app' || state.phase !== 'turns' || state.status !== 'playing') return;
    const t = state.turn;
    const m = me();
    if (!t || t.pid !== m.id || !t.rolled || t.again || m.pendingCard || (m.travel && !t.rolled)) return;
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
    if (firstState) anim.seen = lastSeenTx; // 들어오기 전 장면은 다시 보여 주지 않음
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
    if (!anim.busy) setTimeout(scanAnimations, 0);
    if (state.status === 'playing') return renderGame();
    return renderEnded();
  }

  function topbar() {
    return `<div class="topbar"><b>🎲 모두의 마블 보조앱</b>
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
        <label class="field"><span>내 이름</span><input type="text" id="name" maxlength="12" placeholder="예: 엄마" value="${esc(lastName())}"></label>
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
      <span class="name">${esc(r.host)}의 방 <span class="tag">${esc(r.code)}</span>
        <span class="muted">${MODE_NAME[r.mode] || MODE_NAME.mixed} · ${r.players.map(esc).join(', ')} · ${r.players.length}/4${r.status === 'playing' ? ' · 게임 중' : ''}</span></span>
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
        <div class="sub">${MODE_NAME[state.mode]} — ${MODE_HELP[state.mode]}</div>
        <button class="btn secondary small" id="share2">📤 참가 링크 보내기</button>
      </div>
      <div class="card">
        <h2>참가자 ${state.players.length}/4</h2>
        <ul class="plist">${state.players.map((p) => `<li>
          <span class="dot" style="background:${pc(p)}"></span>
          <span class="name">${esc(p.name)}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${p.id === session.playerId ? '<span class="tag">나</span>' : ''}</span>
          ${host && p.id !== state.hostId ? `<button class="link" data-kick="${p.id}">내보내기</button>` : ''}
        </li>`).join('')}</ul>
      </div>
      ${colorPicker()}
      ${host
        ? `<button class="btn accent" id="start" ${state.players.length < 2 || state.players.some((p) => !p.color) ? 'disabled' : ''}>게임 시작 (모두 ${fmt(G.START_MONEY)}, 축제도시 3곳 무작위)</button>
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
    $app.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => run({ type: 'pickColor', color: b.dataset.color })));
    if (host) $app.querySelector('#start').onclick = () => run({ type: 'start' });
    $app.querySelector('#leave').onclick = () => confirmBox(host ? '방을 닫을까요? 다른 사람도 나가게 돼요.' : '방에서 나갈까요?', async () => {
      if (conn) await conn.leave();
      goHome();
    });
  }

  function colorPicker() {
    const hostColor = player(state.hostId).color;
    const waitHost = !isHost() && !hostColor;
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
        ${owner ? '' : `<span class="tp">${fmt(t.kind === 'tour' ? G.TOUR_PRICE : t.cost.land)}</span>`}
        <span class="tb">${tileBadges(t)}</span>${piecesAt(t.pos)}</span>
      ${quad(t, pr)}
    </button>`;
  }
  // 그 칸에 있는 말 (오른쪽 위 동그라미)
  function shownPos(p) {
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
  function boardHtml(filter) {
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
      }).join('')}<div class="center"><div class="logo">모두의 마블</div>
        <div class="legend">🎉축제 🏅올림픽 😷전염병 🌫️황사 ⚡정전</div></div></div>`;
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
    const m = me();
    const host = isHost();
    const undoTx = G.lastUndoable(state);
    const canUndo = undoTx && (undoTx.actorId === m.id || host);
    const acts = state.mode === 'app'
      ? [['transfer', '💸', '송금'], ['sell', '🏚️', '매각'], ['fortune', '🃏', '포춘카드']]
      : [['salary', '🏁', '월급 30만'], ['bail', '🏝️', '보석금 20만'], ['tax', '🧾', '국세청 20만'], ['travel', '✈️', '세계여행 10만'], ['olympic', '🏅', '올림픽 10만'],
        ['bonus', '🪙', '보너스 게임'], ['fortune', '🃏', '포춘카드'], ['transfer', '💸', '송금'], ['sell', '🏚️', '매각']];
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
        ${m.bankrupt ? '' : `<div class="actions ${state.mode === 'app' ? 'app' : ''}">${acts.map(([a, ic, label]) => `<button class="act" data-a="${a}">${ic}<span>${label}</span></button>`).join('')}</div>`}
        <div class="sub center">말이 도착한 칸을 누르세요</div>
      </section>
      <section class="g-players">
        <div class="card">
          <ul class="plist">${state.players.map((p) => {
            const turn = state.turn && state.turn.pid === p.id;
            return `<li class="${turn ? 'now' : ''}">
            <span class="dot" style="background:${pc(p)}"></span>
            <span class="name ${p.bankrupt ? 'out' : ''}">${esc(p.name)}${p.id === state.hostId ? '<span class="tag">방장</span>' : ''}${turn ? '<span class="tag now">차례</span>' : ''}</span>
            <span class="muted">${p.bankrupt ? '파산' : `${p.laps + 1}턴 · 땅 ${myTiles(p.id).length}`}</span>
            <span class="money">${fmt(p.money)}</span>
          </li>`;
          }).join('')}</ul>
          <div class="row mt">
            ${host ? '<button class="btn secondary small" id="hostmenu">방장 메뉴</button>' : ''}
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
    if (q('#dice')) q('#dice').onclick = rollDice;
    bindTurnBar();
    if (m.pendingCard && !$modal.innerHTML) keepPrompt();
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
      const why = !G.canBuild(m, k) ? `${G.BUILDINGS.indexOf(k) + 1}번째 턴부터` : k === 'landmark' && !ready ? '빌라·빌딩·호텔 필요' : '';
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
      <div class="sub sheethead">${owner ? `주인 <b>${esc(owner.name)}</b> ${builtIcons(t)}` : '주인 없음'}
        <button class="btn small secondary" data-move="${t.pos}">📍 내 말 여기로</button></div>`;

    // 빈 땅 → 구매
    if (!pr) {
      openModal(`${head}
        ${t.kind === 'city' ? `<div class="buildbox"><div class="sub">같이 지을 건물</div>${buildChecks(t, null)}</div>` : ''}
        ${priceTable(t)}
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
      openModal(`${head}
        ${checks ? `<div class="buildbox"><div class="sub">건물 짓기 (도착했을 때)</div>${checks}</div>` : ''}
        ${priceTable(t)}
        <div class="preview"><span>지금 통행료</span><b>${fmt(toll.amount)}</b></div>
        ${toll.parts.length ? `<div class="sub">${toll.parts.join(' · ')}</div>` : ''}
        <div class="err" id="err"></div>
        <div class="row">${t.kind === 'tour' ? '' : '<button class="btn secondary" data-close>닫기</button>'}
          ${t.tour === 'beach' || fx ? `<button class="btn ${t.kind === 'tour' ? 'accent' : 'secondary'}" id="arrive">${t.tour === 'beach' ? '⛱️ 도착 · 방문 +1' : '도착 (효과 해제)'}</button>` : ''}
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
      <div class="checks">${state.mode !== 'app' || m.card === 'angel' ? '<label class="check"><input type="checkbox" id="angel"> 😇 천사 카드 (면제)</label>' : '<input type="checkbox" id="angel" hidden>'}
        ${state.mode !== 'app' || m.card === 'coupon' ? '<label class="check"><input type="checkbox" id="coupon"> 🎫 할인쿠폰 (50%)</label>' : '<input type="checkbox" id="coupon" hidden>'}</div>
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
  function specialSheet(pos) {
    const sp = G.SPACES[pos];
    if (me().bankrupt) return;
    const BTN = {
      start: ['🏁 월급 받기', () => ACTIONS.salary(pos), '출발지에 도착하면 내 도시 한 곳에 건물을 세울 수 있어요. 그 도시 칸을 눌러 건설하세요.'],
      bonus: ['🪙 보너스 게임', () => ACTIONS.bonus(), '코인 앞뒤 맞히기 — 연속 1·2·3회 성공 시 40·80·160만'],
      island: [`🏝️ 보석금 ${fmt(G.BAIL)} 내고 탈출`, () => ACTIONS.bail(), '3차례 동안 이동할 수 없어요. 더블, 보석금, 무인도 탈출 카드로 나올 수 있어요.'],
      card: ['🃏 포춘카드', () => { run({ type: 'move', to: pos }, { keepOpen: true }); fortuneDialog(); }, '포춘카드를 뒤집고 미션을 수행하세요.'],
      olympic: [`🏅 올림픽 개최 (${fmt(G.OLYMPIC_COST)})`, () => ACTIONS.olympic(pos), '내 도시 한 곳에 올림픽을 열 수 있어요.'],
      travel: [`✈️ 세계여행 비용 ${fmt(G.TRAVEL)}`, () => ACTIONS.travel(), '다음 차례에 비용을 내고 원하는 곳으로 가요. 출발지를 지나면 월급도 받아요.'],
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
  const SHIELD = '상대가 방패나 천사 카드로 막으면 쓰지 마세요.';

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
      ['도시기부', 'bronze', '내 도시 하나를 상대에게', () => donateDialog()],
      ['올림픽 관광', 'bronze', '올림픽 개최지로 이동해 통행료', () => (state.olympic ? tileSheet(state.olympic.tileId) : toast('올림픽 개최지가 없어 패스예요.'))],
      ['무인도 탐험', 'bronze', '무인도로 즉시 이동 (월급 없음)', () => moveTo(G.POS.island, '무인도로 옮겼어요.')],
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

  function moveTo(pos, msg) {
    if (run({ type: 'move', to: pos })) toast(msg);
  }

  function fortuneDialog() {
    openModal(`<button class="hbtn" id="draw">🎴 랜덤 뽑기</button><h3>🃏 포춘카드</h3>
      <div class="sub">남은 카드 ${G.deck(state).length}장${state.mode === 'app' ? ' · 랜덤 뽑기를 누르세요' : ' · 실물 카드를 뽑았다면 아래에서 고르세요'}</div>
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
    if (state.mode !== 'app') return true;
    if (state.phase === 'order') return state.orderRolls[m.id] === null;
    const t = state.turn;
    return !!t && t.pid === m.id && (!t.rolled || t.again) && (!m.travel || m.money < G.TRAVEL);
  }
  function diceLabel() {
    const m = me();
    if (state.mode === 'app' && state.phase === 'order') return '순서 정하기';
    if (m.jail > 0 && state.mode === 'app') return '주사위 (더블이면 탈출)';
    if (state.turn && state.turn.again && state.turn.pid === m.id) return '한 번 더!';
    return '주사위 굴리기';
  }
  function rollDice() {
    if (!canRoll() || anim.busy) return;
    const dice = [r6(), r6()];
    if (state.mode === 'app' && state.phase === 'order') return run({ type: 'orderRoll', dice });
    autoNext = true;
    run({ type: 'roll', dice });
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
    if (state.mode !== 'app' || state.status !== 'playing') return '';
    if (state.phase === 'order') {
      return `<div class="card turnbar"><b>🎲 순서 정하기</b><span class="muted">주사위를 굴려 높은 사람부터 시작해요</span>
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
    const btns = [];
    if (mine && m.travel && m.money >= G.TRAVEL) btns.push(`<button class="btn small accent" id="tgo">✈️ 갈 곳 고르기 (${fmt(G.TRAVEL)})</button>`);
    if (mine && m.jail > 0 && !t.rolled) {
      btns.push(`<button class="btn small secondary" id="tbail">보석금 ${fmt(G.BAIL)}</button>`);
      if (m.card === 'escape') btns.push('<button class="btn small secondary" id="tesc">탈출 카드</button>');
    }
    if (mine) btns.push(`<button class="btn small" id="tend" ${t.rolled && !t.again ? '' : 'disabled'}>차례 끝</button>`);
    else if (isHost()) btns.push('<button class="btn small secondary" id="tend">차례 넘기기</button>');
    const note = mine
      ? (m.travel && m.money < G.TRAVEL ? `세계여행 비용(${fmt(G.TRAVEL)})이 모자라요. 주사위를 굴려 이동하세요` : m.travel ? '세계여행! 갈 곳을 고르세요' : m.jail > 0 && !t.rolled ? '무인도: 더블·보석금·탈출 카드로 나와요' : t.again ? '더블! 한 번 더 굴려요' : t.rolled ? '할 일을 마치면 차례 끝' : '주사위를 굴리세요')
      : '';
    return `<div class="card turnbar ${mine ? 'mine' : ''}"><span class="dot" style="background:${pc(cur)}"></span>
      <b>${mine ? '내 차례' : `${esc(cur.name)} 차례`}</b><span class="muted">${note}</span><span class="grow"></span>${btns.join('')}</div>`;
  }
  function bindTurnBar() {
    const q = (x) => $app.querySelector(x);
    if (q('#tend')) q('#tend').onclick = () => run({ type: 'endTurn' });
    if (q('#tbail')) q('#tbail').onclick = ACTIONS.bail;
    if (q('#tesc')) q('#tesc').onclick = () => run({ type: 'useEscape' });
    if (q('#tgo')) q('#tgo').onclick = () => pickTile('✈️ 세계여행 — 갈 곳 고르기', `비용 ${fmt(G.TRAVEL)} · 출발지를 지나면 월급`, (sp) => sp.pos !== G.POS.travel, (sp) => {
      const pos = typeof sp === 'string' ? G.TILE[sp].pos : sp.pos;
      autoNext = true;
      run({ type: 'travelTo', to: pos });
    });
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
        endTitle = '✈️ 세계여행! 다음 차례에 원하는 곳으로 가요. 차례를 끝낼까요?';
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
      case 'sponsor': return run({ type: 'sponsor' }) && notice('🎁 후원금', `모두에게서 후원금을 받았어요. (10만이 없는 사람은 가진 만큼)`);
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
        endTitle = '✈️ 세계여행 칸으로 왔어요. 다음 차례에 원하는 곳으로 가요. 차례를 끝낼까요?';
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
        ${wins ? `<button class="btn secondary wide" id="stop">그만하고 ${fmt(G.BONUS[wins - 1])} 받기</button>` : ''}`, (root) => {
        if (root.querySelector('#stop')) root.querySelector('#stop').onclick = () => finish();
        root.querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => flip(root, b.dataset.g)));
      });
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
    // 3초 동안 숫자가 빠르게 바뀌다가 천천히 멈춤
    const start = Date.now();
    while (Date.now() - start < 3000) {
      d1.innerHTML = dieHtml(r6());
      d2.innerHTML = dieHtml(r6());
      const k = (Date.now() - start) / 3000;
      await sleep(50 + k * k * 380);
    }
    d1.innerHTML = dieHtml(dice[0]);
    d2.innerHTML = dieHtml(dice[1]);
    el.querySelector('#dsum').textContent = `${dice[0]} + ${dice[1]} = ${dice[0] + dice[1]}${dice[0] === dice[1] ? ' 더블!' : ''}`;
    await sleep(1100);
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
  // 플레이어별 결과: 현금 + 땅·건물 가치(건설비용) = 총자산
  function resultOf(p) {
    const tiles = myTiles(p.id);
    const value = tiles.reduce((sum, t) => sum + (t.kind === 'tour' ? G.TOUR_PRICE : G.builtItems(t, prop(t.id)).reduce((a, k) => a + t.cost[k], 0)), 0);
    let monos = 0;
    for (let g = 0; g < G.GROUPS.length; g++) if (G.hasMonopoly(state, p.id, g)) monos++;
    return { tiles, value, total: p.money + value, monos };
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
        ${r.detail ? `<div class="sub">${esc(r.detail)}</div>` : ''}</div>
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
      <button class="btn secondary mt" id="home">처음으로</button>
    </div>`;
    bindTop();
    if ($app.querySelector('#undo')) $app.querySelector('#undo').onclick = undoDialog;
    if (isHost()) $app.querySelector('#again').onclick = () => confirmBox('새 게임을 준비할까요? (기록이 지워져요)', { type: 'reset' });
    $app.querySelector('#home').onclick = () => {
      if (isHost()) confirmBox('방을 닫을까요?', async () => { if (conn) await conn.leave(); goHome(); });
      else goHome();
    };
  }

  // ---------- 모달 ----------
  // 2. 팝업은 오른쪽 위 ✕(또는 닫기·취소 버튼)로만 닫힘. 바깥을 눌러도 안 닫힘
  function openModal(html, onMount) {
    $modal.innerHTML = `<div class="modal-bg"><div class="modal"><button class="x" data-close aria-label="닫기">✕</button>${html}</div></div>`;
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
      <b>건설 턴 제한</b> 첫 턴 빌라까지 → 두 번째 빌딩까지 → 세 번째 호텔까지 → 그 뒤 자유. 랜드마크는 빌라·빌딩·호텔이 다 있는 내 도시에 도착했을 때.<br>
      <b>통행료</b> 건설된 건물의 통행료 합. 컬러독점 ×2, 축제 ×2, 올림픽 ×2~×5가 겹쳐서 적용.<br>
      <b>관광지</b> 구매 10만. 섬(독도·하와이·푸켓)은 가진 섬 개수, 해변(발리·타히티)은 방문 횟수로 깃발 8만 → 파라솔 16만 → 방갈로 32만. 매각 5만, 인수 불가.<br>
      <b>인수</b> 통행료를 낸 뒤 인수비용(건설비용 2배)을 주인에게. 관광지·랜드마크 도시는 불가.<br>
      <b>매각</b> 통행료·세금이 부족할 때만. 매각비용(건설비용 절반)을 은행에서.<br>
      <b>특수칸</b> 국세청 20만 · 무인도 보석금 20만 · 올림픽 개최 10만(한 곳에만) · 세계여행 10만 · 보너스 게임 40/80/160만.<br>
      <b>📱 앱으로만 하는 방</b> 시작하면 주사위로 순서를 정해요(높은 사람부터, 같으면 다시). 내 차례에 주사위 → 말이 한 칸씩 이동 → 도착한 칸 화면이 열려요. 더블이면 한 번 더, 세 번 연속 더블이면 무인도. 무인도는 3차례 쉬고 더블·보석금·탈출 카드로 나와요. 세계여행은 다음 차례에 10만 내고 원하는 곳으로. 포춘카드는 랜덤으로 뽑고 보관 카드(천사·할인쿠폰·방패·무인도 탈출·월급 부스터)는 1장만, 공격을 받으면 방패(없으면 천사)로 자동 방어.<br>
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
