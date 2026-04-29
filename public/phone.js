(function () {
  const socket = io();
  const $ = (id) => document.getElementById(id);

  const screens = {
    reconnecting: $('screen-reconnecting'),
    join: $('screen-join'),
    classPick: $('screen-class'),
    lobby: $('screen-lobby-phone'),
    play: $('screen-play-phone'),
    watching: $('screen-watching'),
    end: $('screen-end-phone'),
  };
  function show(name) {
    for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
  }

  const CLASS_DEFS = [
    { type: 'Warrior', icon: '⚔️', blurb: 'Strong melee fighter. Best at direct combat and feats of strength.' },
    { type: 'Mage',    icon: '🔮', blurb: 'Wielder of arcane spells. Strong magic, fragile body.' },
    { type: 'Rogue',   icon: '🗡️', blurb: 'Quick and cunning. Stealth, traps, surprise attacks.' },
    { type: 'Cleric',  icon: '✨', blurb: 'Devoted healer. Channels divine power to mend and protect.' },
  ];
  function classIcon(t) { return (CLASS_DEFS.find(c => c.type === t) || {}).icon || '🎲'; }

  let myId = null;
  let isAdmin = false;
  let lastState = null;
  let lastSelectedIdx = null;
  let isReconnecting = false;

  // --- Persistence helpers
  function saveSession(token, name) {
    try { localStorage.setItem('dnd_session', JSON.stringify({ token, name })); } catch {}
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem('dnd_session') || 'null'); } catch { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem('dnd_session'); } catch {}
  }

  // --- Auto-rejoin on page load
  const saved = loadSession();
  if (saved && saved.token && saved.name) {
    isReconnecting = true;
    show('reconnecting');
    socket.emit('joinAsPhone', { name: saved.name, token: saved.token });
  } else {
    show('join');
  }

  // --- Join screen
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('name-input').value.trim();
    if (!name) return;
    socket.emit('joinAsPhone', { name });
  });

  socket.on('joinError', ({ message }) => {
    if (isReconnecting) {
      // Reconnect failed — clear saved session and fall back to join screen
      isReconnecting = false;
      clearSession();
      $('join-error').textContent = message;
      show('join');
    } else {
      $('join-error').textContent = message;
    }
  });

  socket.on('joined', ({ playerId, token, isAdmin: a }) => {
    isReconnecting = false;
    myId = playerId;
    isAdmin = !!a;
    if (token) {
      const name = $('name-input').value.trim() || (loadSession() || {}).name || '';
      saveSession(token, name);
    }
    $('hello-line').textContent = isAdmin ? 'You are an admin.' : '';
    // State event will drive screen transition; show classPick as default
    // (state handler will override if already in a game)
  });

  socket.on('kicked', () => {
    clearSession();
    document.body.innerHTML = '<div style="padding:2em;color:#fff;font-family:sans-serif"><h2>You were removed from the party.</h2><p>Refresh to rejoin.</p></div>';
  });

  function renderClassGrid() {
    const grid = $('class-grid');
    grid.innerHTML = '';
    for (const def of CLASS_DEFS) {
      const card = document.createElement('button');
      card.className = 'class-card';
      card.type = 'button';
      card.innerHTML = `
        <div class="class-icon">${def.icon}</div>
        <div class="class-name">${def.type}</div>
        <div class="class-blurb">${def.blurb}</div>
      `;
      card.addEventListener('click', () => {
        socket.emit('selectCharacter', { type: def.type });
      });
      grid.appendChild(card);
    }
  }

  // --- Lobby
  function renderLobbyRoster(state) {
    const wrap = $('lobby-roster');
    wrap.innerHTML = '';
    for (const p of state.players) {
      const div = document.createElement('div');
      const disconnected = !p.connected && !p.isBot;
      div.className = 'roster-row' + (p.ready ? ' ready' : '') + (p.id === myId ? ' me' : '');
      const stats = p.stats && p.stats.str
        ? `<span class="muted">STR ${p.stats.str} • DEX ${p.stats.dex} • INT ${p.stats.int} • CHA ${p.stats.cha}</span>`
        : '<span class="muted">choosing class…</span>';
      div.innerHTML = `
        <div class="row">
          <span class="icon">${p.type ? classIcon(p.type) : '👤'}</span>
          <span class="name">${escapeHtml(p.name)}</span>
          ${p.isAdmin ? '<span class="badge admin-badge">admin</span>' : ''}
          ${p.isBot ? '<span class="badge bot-badge">bot</span>' : ''}
          ${p.id === myId ? '<span class="badge me-badge">you</span>' : ''}
          ${disconnected ? '<span class="badge disconnected-badge">away</span>' : ''}
        </div>
        <div class="meta">${p.type || ''} · ${stats}</div>
      `;
      if (state.isAdmin && p.id !== myId) {
        const kick = document.createElement('button');
        kick.className = 'kick-btn';
        kick.type = 'button';
        kick.textContent = '✕';
        kick.title = 'Kick';
        kick.addEventListener('click', () => socket.emit('kickPlayer', { playerId: p.id }));
        div.appendChild(kick);
      }
      wrap.appendChild(div);
    }
  }

  function renderSelfCard(self) {
    if (!self) { $('self-card').innerHTML = ''; return; }
    if (!self.type) { $('self-card').innerHTML = ''; return; }
    $('self-card').innerHTML = `
      <div class="row big">
        <span class="icon">${classIcon(self.type)}</span>
        <span class="name">${escapeHtml(self.name)}</span>
        <span class="class-line">${self.type}</span>
      </div>
      <div class="stats">HP ${self.hp}/${self.maxHp} · STR ${self.stats.str} · DEX ${self.stats.dex} · INT ${self.stats.int} · CHA ${self.stats.cha}</div>
      <div class="items">${(self.items || []).map(escapeHtml).join(' · ')}</div>
    `;
  }

  $('start-game').addEventListener('click', () => {
    const prompt = $('campaign-prompt').value.trim();
    const maxRounds = parseInt($('max-rounds').value, 10) || 5;
    socket.emit('startGame', { prompt, maxRounds });
  });
  $('add-bot').addEventListener('click', () => socket.emit('addBot'));

  // --- Play
  function renderOptions(state) {
    const wrap = $('ph-options');
    wrap.innerHTML = '';
    if (state.isProcessing) { wrap.classList.add('hidden'); return; }
    if (state.hasChosen) { wrap.classList.add('hidden'); return; }
    const self = state.self;
    if (self && self.hp <= 0) {
      wrap.classList.remove('hidden');
      wrap.innerHTML = '<div class="defeated">You have fallen. Watch your party finish the tale on the TV.</div>';
      return;
    }
    if (!state.options || !state.options.length) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    state.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.type = 'button';
      btn.innerHTML = `<span class="opt-num">${idx + 1}</span><span class="opt-text">${escapeHtml(opt)}</span>`;
      btn.addEventListener('click', () => {
        if (lastSelectedIdx !== null) return;
        lastSelectedIdx = idx;
        [...wrap.children].forEach((c, i) => {
          c.classList.toggle('selected', i === idx);
          c.disabled = true;
        });
        socket.emit('submitChoice', { index: idx });
      });
      wrap.appendChild(btn);
    });
  }

  function renderWaiting(state) {
    const w = $('ph-waiting');
    if (state.isProcessing) { w.classList.add('hidden'); return; }
    if (!state.hasChosen) { w.classList.add('hidden'); return; }
    w.classList.remove('hidden');
    const submitted = state.choicesSubmitted || 0;
    const needed = state.choicesNeeded || 0;
    w.innerHTML = `<div class="check">✓ Locked in</div><div class="muted">Waiting for the rest of the party… (${submitted}/${needed})</div>`;
  }

  function renderSelfStatus(self) {
    if (!self) { $('self-status').textContent = ''; return; }
    $('self-status').innerHTML = `<span class="icon">${classIcon(self.type)}</span> <span class="name">${escapeHtml(self.name)}</span> <span class="hp">${self.hp}/${self.maxHp} HP</span>${self.statusNote ? `<span class="status">· ${escapeHtml(self.statusNote)}</span>` : ''}`;
  }

  function renderKickPanel(state) {
    if (!state.isAdmin) return;
    const panel = $('kick-panel');
    panel.innerHTML = '';
    for (const p of state.players) {
      if (p.id === myId) continue;
      const row = document.createElement('div');
      row.className = 'kick-row';
      const disconnected = !p.connected && !p.isBot;
      row.innerHTML = `<span>${classIcon(p.type)} ${escapeHtml(p.name)} ${p.isBot ? '(bot)' : ''}${disconnected ? ' <span class="badge disconnected-badge">away</span>' : ''}</span>`;
      const btn = document.createElement('button');
      btn.className = 'kick-btn';
      btn.type = 'button';
      btn.textContent = 'Kick';
      btn.addEventListener('click', () => socket.emit('kickPlayer', { playerId: p.id }));
      row.appendChild(btn);
      panel.appendChild(row);
    }
    const end = document.createElement('button');
    end.className = 'danger';
    end.type = 'button';
    end.textContent = 'End game now';
    end.addEventListener('click', () => {
      if (confirm('End the campaign now? The story will wrap up.')) socket.emit('endGame');
    });
    panel.appendChild(end);
  }

  $('kick-toggle').addEventListener('click', () => {
    $('kick-panel').classList.toggle('hidden');
  });
  $('reset-game').addEventListener('click', () => socket.emit('resetGame'));

  // --- TTS toggle (admin) ---
  let ttsEnabled = true;
  function updateTtsBtn(enabled) {
    ttsEnabled = enabled;
    const btn = $('tts-admin-btn');
    if (btn) btn.textContent = enabled ? '🔊 Narration: On' : '🔇 Narration: Off';
  }
  $('tts-admin-btn').addEventListener('click', () => {
    socket.emit('setTTS', { enabled: !ttsEnabled });
  });

  // --- Main state handler
  socket.on('state', (state) => {
    lastState = state;
    isAdmin = !!state.isAdmin;

    // Update saved name if we now have it
    const saved2 = loadSession();
    if (saved2 && state.self && state.self.name) {
      saveSession(saved2.token, state.self.name);
    }

    // Sync TTS toggle from server
    updateTtsBtn(state.ttsEnabled !== false);

    if (state.waitingForNext) {
      // Mid-game joiner: show class pick if not ready, else watching screen
      if (!state.self || !state.self.ready) {
        renderClassGrid();
        show('classPick');
      } else {
        show('watching');
        $('watching-round').textContent = state.round;
        $('watching-max').textContent = state.maxRounds;
        $('watching-title').textContent = state.currentTitle || '';
        const narr = state.currentNarration || '';
        $('watching-narration').textContent = narr;
        $('watching-narration').classList.toggle('hidden', !narr);
      }
      return;
    }

    if (state.phase === 'lobby') {
      if (!state.self) { show('join'); return; }
      if (!state.self.ready) {
        renderClassGrid();
        show('classPick');
        return;
      }
      show('lobby');
      renderSelfCard(state.self);
      renderLobbyRoster(state);
      $('admin-controls').classList.toggle('hidden', !state.isAdmin);
      const adminPresent = state.players.some(p => p.isAdmin);
      $('lobby-status').textContent = state.isAdmin
        ? 'You can start whenever you\u2019re ready.'
        : (adminPresent ? 'Waiting for the admin to start the campaign\u2026' : 'Waiting for an admin to join\u2026');
    } else if (state.phase === 'playing') {
      if (state.round !== Number($('ph-round').textContent)) lastSelectedIdx = null;
      if (!state.hasChosen) lastSelectedIdx = null;
      show('play');
      $('ph-round').textContent = state.round;
      $('ph-max').textContent = state.maxRounds;
      $('ph-scene-title').textContent = state.currentTitle || '';
      const myResult = state.myResult || '';
      $('ph-my-result').textContent = myResult;
      $('ph-my-result').classList.toggle('hidden', !myResult || state.isProcessing);
      const narration = state.currentNarration || '';
      $('ph-narration').textContent = narration;
      $('ph-narration').classList.toggle('hidden', !narration);
      $('ph-processing').classList.toggle('hidden', !state.isProcessing);
      renderSelfStatus(state.self);
      renderOptions(state);
      renderWaiting(state);
      $('ph-admin-mid').classList.toggle('hidden', !state.isAdmin);
      if (state.isAdmin) renderKickPanel(state);
    } else if (state.phase === 'finished') {
      show('end');
      $('ph-final-title').textContent = state.finalTitle || state.currentTitle || 'The End';
      $('ph-final-narration').textContent = state.finalNarration || state.currentNarration || '';
      const self = state.self;
      $('ph-self-final').innerHTML = self ? `<div class="self-card">${classIcon(self.type)} ${escapeHtml(self.name)} the ${self.type} — ${self.hp <= 0 ? 'fallen' : self.hp + '/' + self.maxHp + ' HP'}</div>` : '';
      $('ph-admin-end').classList.toggle('hidden', !state.isAdmin);
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
