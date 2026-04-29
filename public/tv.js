(function () {
  const socket = io();
  socket.emit('joinAsTV');

  fetch('/qr').then(r => r.json()).then(({ url, png }) => {
    document.getElementById('qr-img').src = png;
    document.getElementById('join-url').textContent = url;
  });

  const $ = (id) => document.getElementById(id);
  const screens = { lobby: $('screen-lobby'), play: $('screen-play'), end: $('screen-end') };
  function show(name) {
    for (const k of Object.keys(screens)) screens[k].classList.toggle('hidden', k !== name);
  }

  // --- Audio unlock (Chrome blocks autoplay without a user gesture) ----------
  const unlockOverlay = document.getElementById('audio-unlock');
  let audioUnlocked = false;
  unlockOverlay.addEventListener('click', () => {
    audioUnlocked = true;
    unlockOverlay.style.display = 'none';
    // Play a silent buffer to warm up the audio context
    const warmup = new Audio('/api/tts?text=.');
    warmup.volume = 0;
    warmup.play().catch(() => {});
  }, { once: true });

  // --- TTS ------------------------------------------------------------------
  let ttsOn = true;       // local TV mute toggle
  let serverTtsEnabled = true;  // admin-controlled server flag
  let currentAudio = null;
  let lastSpoken = '';

  function speak(text) {
    if (!ttsOn || !serverTtsEnabled || !text || text === lastSpoken) return;
    lastSpoken = text;
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    const audio = new Audio('/api/tts?text=' + encodeURIComponent(text));
    audio.playbackRate = 1.25;
    currentAudio = audio;
    audio.onerror = (e) => console.error('[TTS] audio error', e);
    audio.play().catch(e => console.warn('[TTS] play blocked:', e.message));
  }

  $('tts-toggle').addEventListener('click', () => {
    ttsOn = !ttsOn;
    $('tts-toggle').textContent = ttsOn ? '🔊' : '🔇';
    if (!ttsOn && currentAudio) { currentAudio.pause(); currentAudio = null; }
  });

  function classIcon(type) {
    return ({ Warrior: '⚔️', Mage: '🔮', Rogue: '🗡️', Cleric: '✨' }[type] || '🎲');
  }

  function renderLobbyPlayers(players) {
    const wrap = $('lobby-players');
    wrap.innerHTML = '';
    if (!players.length) {
      wrap.innerHTML = '<div class="empty">No adventurers yet…</div>';
      $('lobby-count').textContent = '';
    } else {
      $('lobby-count').textContent = `(${players.length})`;
      for (const p of players) {
        const card = document.createElement('div');
        card.className = 'player-card' + (p.ready ? ' ready' : '') + (p.isAdmin ? ' admin' : '') + (p.isBot ? ' bot' : '');
        const stats = p.stats && p.stats.str
          ? `<div class="stats">STR ${p.stats.str} • DEX ${p.stats.dex} • INT ${p.stats.int} • CHA ${p.stats.cha}</div>`
          : '<div class="stats muted">choosing class…</div>';
        card.innerHTML = `
          <div class="row">
            <span class="icon">${p.type ? classIcon(p.type) : '👤'}</span>
            <span class="name">${escapeHtml(p.name)}</span>
            ${p.isAdmin ? '<span class="badge admin-badge">admin</span>' : ''}
            ${p.isBot ? '<span class="badge bot-badge">bot</span>' : ''}
          </div>
          <div class="class-line">${p.type ? p.type : '<span class="muted">picking…</span>'}</div>
          ${stats}
        `;
        wrap.appendChild(card);
      }
    }
  }

  function renderParty(players, pendingChoices = [], phase = 'playing') {
    const wrap = $('party-list');
    wrap.innerHTML = '';
    const pending = new Set(pendingChoices);
    for (const p of players) {
      if (!p.ready) continue;
      const dead = p.hp <= 0;
      const waiting = phase === 'playing' && pending.has(p.id) && !dead;
      const hpPct = p.maxHp ? Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100)) : 0;
      const disconnected = !p.connected && !p.isBot;
      const card = document.createElement('div');
      card.className = 'party-card' + (dead ? ' dead' : '') + (waiting ? ' waiting' : ' chose') + (disconnected ? ' disconnected' : '');
      card.innerHTML = `
        <div class="row">
          <span class="icon">${classIcon(p.type)}</span>
          <span class="name">${escapeHtml(p.name)}</span>
          ${p.isBot ? '<span class="badge bot-badge">bot</span>' : ''}
          ${dead ? '<span class="badge dead-badge">defeated</span>' : ''}
          ${disconnected ? '<span class="badge disconnected-badge">away</span>' : ''}
        </div>
        <div class="class-line">${p.type}</div>
        <div class="hp-bar"><div class="hp-fill" style="width:${hpPct}%"></div></div>
        <div class="hp-text">${p.hp} / ${p.maxHp} HP</div>
        ${p.statusNote ? `<div class="status">${escapeHtml(p.statusNote)}</div>` : ''}
        ${p.items && p.items.length ? `<div class="items">${p.items.map(escapeHtml).join(' · ')}</div>` : ''}
        ${phase === 'playing' ? `<div class="choice-state">${dead ? '—' : (waiting ? '⏳ choosing…' : '✓ ready')}</div>` : ''}
      `;
      wrap.appendChild(card);
    }
  }

  function renderWaiting(state) {
    const row = $('waiting-row');
    if (state.phase !== 'playing') { row.textContent = ''; return; }
    if (state.isProcessing) { row.textContent = ''; return; }
    const submitted = state.choicesSubmitted || 0;
    const needed = state.choicesNeeded || 0;
    if (needed === 0) { row.textContent = ''; return; }
    row.innerHTML = `<span class="muted">Choices in:</span> <strong>${submitted}</strong> / ${needed}`;
  }

  let lastNarration = '';
  function setResolution(items, players) {
    const el = $('resolution-list');
    if (!items || !items.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = items.map(r => {
      const p = players.find(pl => pl.id === r.playerId);
      const icon = p ? classIcon(p.type) : '🎲';
      const name = p ? escapeHtml(p.name) : '?';
      return `<div class="resolution-item"><span class="res-icon">${icon}</span><span class="res-name">${name}</span><span class="res-text">${escapeHtml(r.result)}</span></div>`;
    }).join('');
  }

  function setNarration(text) {
    if (text === lastNarration) return;
    lastNarration = text;
    const el = $('narration');
    el.classList.remove('fade-in');
    void el.offsetWidth;
    el.textContent = text;
    el.classList.add('fade-in');
    el.closest('.narration-box').scrollTop = 0;
    speak(text);
  }

  socket.on('tvState', (s) => {
    serverTtsEnabled = s.ttsEnabled !== false;
    if (s.phase === 'lobby') {
      show('lobby');
      renderLobbyPlayers(s.players);
      $('lobby-hint').textContent = s.players.some(p => p.isAdmin)
        ? 'Waiting for the admin to start the campaign…'
        : 'Waiting for an admin to join and start…';
    } else if (s.phase === 'playing') {
      show('play');
      $('round-num').textContent = s.round;
      $('round-max').textContent = s.maxRounds;
      $('scene-title').textContent = s.currentTitle || '';
      $('processing').classList.toggle('hidden', !s.isProcessing);
      setResolution(s.isProcessing ? [] : (s.currentResolution || []), s.players);
      setNarration(s.currentNarration || '');
      renderParty(s.players, s.pendingChoices || [], 'playing');
      renderWaiting(s);
    } else if (s.phase === 'finished') {
      show('end');
      $('final-title').textContent = s.finalTitle || s.currentTitle || 'The End';
      const fn = s.finalNarration || s.currentNarration || '';
      $('final-narration').textContent = fn;
      speak(fn);
      const fp = $('final-party');
      fp.innerHTML = '';
      for (const p of s.players) {
        if (!p.ready) continue;
        const div = document.createElement('div');
        div.className = 'final-card' + (p.hp <= 0 ? ' dead' : '');
        div.innerHTML = `
          <div class="row"><span class="icon">${classIcon(p.type)}</span><span class="name">${escapeHtml(p.name)}</span></div>
          <div class="class-line">${p.type}</div>
          <div class="hp-text">${p.hp <= 0 ? 'Fallen' : p.hp + ' / ' + p.maxHp + ' HP'}</div>
          ${p.items && p.items.length ? `<div class="items">${p.items.map(escapeHtml).join(' · ')}</div>` : ''}
        `;
        fp.appendChild(div);
      }
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
