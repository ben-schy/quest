require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');

const {
  CHARACTERS,
  game, tokens,
  newId, newToken,
  rollCharacter, pickBotName,
  publicPlayer, activeChoosers, snapshotForPlayer, snapshotForTV,
  applyStateUpdates, resetGameState,
  isAdminName, findPlayerBySocket, findPlayerByToken,
} = require('./lib/game');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MODEL = 'claude-sonnet-4-6';
const OPENAI_TTS_VOICE = process.env.TTS_VOICE || 'fable';

function loadApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  const candidates = ['.api_key', 'api_key.txt', 'anthropic.key'];
  for (const f of candidates) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8').trim();
  }
  return null;
}
const apiKey = loadApiKey();
if (!apiKey) {
  console.error('\n[!] No Anthropic API key found.');
  console.error('    Set ANTHROPIC_API_KEY in a .env file, or put the raw key in a .api_key file.\n');
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey });

const openaiApiKey = process.env.OPENAI_API_KEY || null;
if (!openaiApiKey) console.warn('[!] No OPENAI_API_KEY found — TTS narration disabled.');

// --- Quest history -----------------------------------------------------------

const QUEST_HISTORY_PATH = path.join(__dirname, 'quest_history.json');
let questHistory = [];
try {
  if (fs.existsSync(QUEST_HISTORY_PATH)) {
    questHistory = JSON.parse(fs.readFileSync(QUEST_HISTORY_PATH, 'utf-8'));
    console.log(`[History] Loaded ${questHistory.length} prior quest(s).`);
  }
} catch (e) {
  console.warn('[History] Could not load quest_history.json:', e.message);
}

function saveQuestSummary() {
  const party = [...game.players.values()]
    .filter(p => p.ready)
    .map(p => ({
      name: p.name,
      type: p.type,
      bot: p.isBot,
      survived: p.hp > 0,
      finalHp: p.hp,
      maxHp: p.maxHp,
      items: [...(p.items || [])],
      statusNote: p.statusNote || '',
    }));
  const summary = {
    date: new Date().toISOString().split('T')[0],
    theme: game.campaignPrompt || '',
    rounds: game.round,
    outcome: party.filter(p => !p.bot).some(p => p.survived) ? 'survived' : 'all fallen',
    party,
    history: game.history.map(h => ({
      round: h.round,
      title: h.title || '',
      narration: h.narration || '',
      actions: (h.actions || []).map(a => ({ name: a.name, choice: a.optionText })),
    })),
    finalNarration: game.finalNarration || game.currentNarration || '',
  };
  questHistory.push(summary);
  fs.writeFile(QUEST_HISTORY_PATH, JSON.stringify(questHistory, null, 2), err => {
    if (err) console.error('[History] Failed to save:', err.message);
    else console.log(`[History] Saved quest summary (total: ${questHistory.length})`);
  });
}

// --- TTS cache (text hash -> mp3 Buffer) ------------------------------------
const ttsCache = new Map();

function getPublicUrl() {
  // Render.com sets this automatically
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  return `http://${getLocalIP()}:${PORT}`;
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect('/tv'));
app.get('/tv', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/phone', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/qr', async (_req, res) => {
  const url = `${getPublicUrl()}/phone`;
  const png = await QRCode.toDataURL(url, { margin: 1, scale: 10 });
  res.json({ url, png });
});

app.get('/api/tts', async (req, res) => {
  if (!openaiApiKey) {
    console.warn('[TTS]    request received but OPENAI_API_KEY is not set');
    res.status(503).end(); return;
  }
  const text = String(req.query.text || '').trim().slice(0, 4096);
  if (!text) { res.status(400).end(); return; }

  const cacheKey = crypto.createHash('md5').update(text).digest('hex');
  if (ttsCache.has(cacheKey)) {
    console.log(`[TTS]    cache hit  len=${text.length}  key=${cacheKey.slice(0,8)}`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(ttsCache.get(cacheKey));
  }

  console.log(`[TTS]    → OpenAI  len=${text.length}  voice=${OPENAI_TTS_VOICE}  preview="${text.slice(0, 60).replace(/\n/g, ' ')}…"`);
  const t0 = Date.now();
  try {
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'tts-1', input: text, voice: OPENAI_TTS_VOICE, speed: 1.3 }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[TTS]    ← OpenAI error ${resp.status}: ${body}`);
      res.status(500).end(); return;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    console.log(`[TTS]    ← OpenAI ok  ${Date.now() - t0}ms  bytes=${buf.length}`);
    ttsCache.set(cacheKey, buf);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (e) {
    console.error('[TTS]    fetch error:', e.message);
    res.status(500).end();
  }
});

// --- Broadcast --------------------------------------------------------------

function broadcast() {
  io.to('tv').emit('tvState', snapshotForTV());
  for (const p of game.players.values()) {
    if (p.isBot || !p.socketId) continue;
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('state', snapshotForPlayer(p.id));
  }
}

// --- Claude integration -----------------------------------------------------

const SYSTEM_PROMPT = `You are the Game Master for a multiplayer party choose-your-own-adventure shown on a TV, with players choosing actions on their phones. Your job is to run a TACTICAL, ENCOUNTER-DRIVEN adventure where combat has real weight, items matter, and every choice has consequences.

═══ ENCOUNTER DESIGN ═══
Drop the party into concrete, specific situations every round. Not "you find trouble" — describe the exact scene:
  • How many enemies, what type, where they are positioned, what they're doing
  • "Four skeleton archers line the balcony above; a shambling troll blocks the exit, mid-swing at Aldric"
  • "Two goblins crouch behind overturned tables with crossbows trained on the door; three more charge blade-first from the left flank"
Vary encounter types: ambushes, boss fights, trapped rooms, hostage situations, social confrontations, environmental hazards. Combat is the spine, but not every round is pure sword-swinging.

═══ PLAYER OPTIONS ═══
Options must reflect the actual tactical situation — not generic, not vague:
  • Target SPECIFIC enemies or positions: "Rush the flanking goblins before they close", "Blast the archers on the balcony"
  • Use the environment: "Kick over the brazier to cut off their retreat", "Swing from the chandelier to reach the balcony"
  • Coordinate: "Draw their fire so the Rogue can flank"
  • Use items: if a player has a Smoke Bomb, Healing Potion, or other usable item, offer it as an option when relevant
  • Class-flavored always:
    - Warrior: charges, shield bashes, holds the line, taunts enemies off allies
    - Mage: targeted spells, area blasts, hexes, utility magic (light, silence, slow)
    - Rogue: flanks, vanishes into shadows, sets traps, pickpockets, backstabs, throws smoke
    - Cleric: heals allies mid-fight, channels divine wrath, wards against undead, buffs
Give 3-4 options per player, meaningfully different in risk and approach.

═══ COMBAT RESOLUTION ═══
Resolve the full fight state before advancing. Name what happened to each enemy:
  • Apply real HP deltas. Warrior tanking two sword strikes: -6 to -12 HP. Mage caught in melee: -8 to -15. A Rogue who successfully flanked: 0 to -3. High DEX = more dodges; high STR = harder hits; high INT = spells land; high CHA = enemies hesitate.
  • Enemies retaliate unless stopped or dead. A goblin whose ally just fell might break and run — or fight with rage.
  • Partial successes are the most interesting: goblins driven back BUT the Cleric took a bolt.
  • Status effects via statusNote: "poisoned" (-3 HP applied next round and noted), "burning", "stunned", "blessed", "limping". Keep these short.
  • Items are consumable power: Healing Potion = +8 to +12 hpDelta. Smoke Bomb = tactical advantage / enemies lose a turn. Track items used via itemsRemoved.

═══ STORY PACING ═══
  • Opening round: a vivid hook with an immediate threat requiring choice.
  • Mid rounds: escalate. Tougher enemies, higher stakes, choices from earlier rounds echoing forward.
  • Final round: a boss, a desperate last stand, or a dramatic escape. isFinal=true wraps everything up.
  • Final narration (isFinal=true): 4-6 sentences. Name every surviving hero. Honor the fallen. Give the adventure a proper ending.

═══ FINAL TITLE ═══
When isFinal=true, the "title" field is the NAME OF THIS ADVENTURE — something a bard would title it. Memorable, specific, earned by what happened: "The Fall of Grimstone Keep", "Victory at a Terrible Price", "How the Goblin King Met His End", "Three Heroes and a Miracle". Never just "The End".

CRITICAL: Respond with VALID JSON ONLY — no markdown, no preamble, no trailing text. Schema:

{
  "title": "short scene title (3-6 words) — or adventure name if isFinal",
  "resolution": [
    { "playerId": "<id>", "result": "one crisp sentence ≤15 words: what they did and what happened" }
  ],
  "narration": "flowing prose — the new scene after the dust settles. 3-4 sentences, 50-65 words. Do NOT re-describe each player's action (that's in resolution); instead open with the consequence and move into the next situation.",
  "playerOptions": [
    { "playerId": "<id>", "options": ["...", "...", "..."] }
  ],
  "stateUpdates": [
    { "playerId": "<id>", "hpDelta": 0, "itemsAdded": [], "itemsRemoved": [], "statusNote": "" }
  ],
  "isFinal": false
}

Rules:
- resolution: one entry per player who had options last round. Skip on the opening round (set to []). Skip when isFinal=true (set to []).
- Always include EVERY active (HP > 0, not waitingForNext) player in playerOptions, unless isFinal=true.
- If a player drops to 0 HP, narrate it and exclude them from further playerOptions.
- stateUpdates only lists players whose state actually changes. Empty list is fine.
- Use exact playerId strings from the input.
- isFinal=true only for the closing wrap-up after the last round; omit playerOptions then.
- Options: under ~12 words each, specific enough to visualise.`;

function describePlayers() {
  return [...game.players.values()].filter(p => p.ready && !p.waitingForNext).map(p => {
    const alive = p.hp > 0 ? '' : ' [DEFEATED]';
    const stats = `STR ${p.stats.str}, DEX ${p.stats.dex}, INT ${p.stats.int}, CHA ${p.stats.cha}`;
    const items = p.items.length ? p.items.join(', ') : 'none';
    const status = p.statusNote ? ` Status: ${p.statusNote}.` : '';
    const away = (!p.connected && !p.isBot) ? ' [DISCONNECTED — act may be auto-chosen]' : '';
    return `- id=${p.id}, name="${p.name}" the ${p.type}${alive}${away}. HP ${p.hp}/${p.maxHp}. ${stats}. Items: ${items}.${status}`;
  }).join('\n');
}

function describeHistory(maxRounds = 3) {
  if (!game.history.length) return '(no prior rounds)';
  const recent = game.history.slice(-maxRounds);
  return recent.map(h => {
    const acts = (h.actions && h.actions.length)
      ? '\n  Actions taken:\n' + h.actions.map(a => `    - ${a.name}: "${a.optionText}"`).join('\n')
      : '';
    return `[Round ${h.round}] ${h.title || ''}\n  ${h.narration}${acts}`;
  }).join('\n\n');
}

function buildQuestHistoryContext() {
  if (!questHistory.length) return '';
  const recent = questHistory.slice(-3);
  const lines = recent.map(q => {
    const humanParty = q.party.filter(p => !p.bot)
      .map(p => `${p.name} the ${p.type} (${p.survived ? `survived, ${p.finalHp}/${p.maxHp} HP` : 'fell'})`)
      .join(', ');
    const scenes = (q.history || []).map(h => h.title).filter(Boolean).join(' → ');
    const roundSummaries = (q.history || []).map(h =>
      `    Round ${h.round} — "${h.title}": ${h.narration}` +
      (h.actions.length ? '\n      Actions: ' + h.actions.map(a => `${a.name} → "${a.choice}"`).join('; ') : '')
    ).join('\n');
    const carryItems = q.party.filter(p => !p.bot && p.survived && p.items && p.items.length)
      .map(p => `${p.name}: [${p.items.join(', ')}]`).join('; ');
    return `Quest (${q.date}) — theme: "${q.theme || 'none'}"\n  Outcome: ${q.outcome}\n  Party: ${humanParty}\n  Scenes: ${scenes}\n  Round details:\n${roundSummaries}\n  Final: "${q.finalNarration.slice(0, 200)}"${carryItems ? `\n  Carried items: ${carryItems}` : ''}`;
  }).join('\n\n---\n\n');
  return `\nPrior quest history — weave in recurring people, places, items, or themes where fitting:\n${lines}\n`;
}

function buildPrompt({ isOpening, isFinalResolution, actions }) {
  const players = describePlayers();
  const theme = game.campaignPrompt
    ? game.campaignPrompt
    : '(none provided — surprise the party with a classic fantasy hook)';

  if (isOpening) {
    return `The party gathers at the start of their adventure.
Total rounds planned: ${game.maxRounds}
Campaign theme: ${theme}
${buildQuestHistoryContext()}
Active players:
${players}

Generate the OPENING scene and per-player options. The opening should hook the party and present an immediate situation requiring choice. Return JSON only.`;
  }

  const actionLines = (actions || []).map(a => {
    const p = game.players.get(a.playerId);
    return `- ${p.name} the ${p.type} (HP ${p.hp}/${p.maxHp}) chose: "${a.optionText}"`;
  }).join('\n');

  const disconnectedNote = (() => {
    const away = [...game.players.values()].filter(
      p => p.ready && !p.isBot && !p.connected && p.hp > 0 && !p.waitingForNext,
    );
    if (!away.length) return '';
    const names = away.map(p => p.name).join(', ');
    return `\nNote: ${names} ${away.length === 1 ? 'has' : 'have'} gone mysteriously silent — their action was chosen automatically. Weave their distraction or struggle into the narrative naturally.\n`;
  })();

  if (isFinalResolution) {
    return `FINAL ROUND RESOLUTION (round ${game.round} of ${game.maxRounds}).
Campaign theme: ${theme}

Recent history:
${describeHistory()}

Current scene: ${game.currentNarration}
${disconnectedNote}
Player choices just made:
${actionLines}

This is the FINAL resolution — wrap up the entire adventure with a climactic conclusion (success, failure, or bittersweet). Set "isFinal": true. Provide narration (4-5 sentences, 70-90 words). Apply final stateUpdates. Do NOT include playerOptions. Return JSON only.

Active players for state references:
${players}`;
  }

  return `Round ${game.round} of ${game.maxRounds}.
Campaign theme: ${theme}

Recent history:
${describeHistory()}

Current scene: ${game.currentNarration}
${disconnectedNote}
Player choices just made:
${actionLines}

Resolve their actions and present the NEXT scene with fresh per-player options. Apply HP/item/status updates as needed. Return JSON only.

Active players (current state):
${players}`;
}

async function callClaude(userPrompt) {
  console.log(`[Claude] → request  round=${game.round} phase=${game.phase} prompt_len=${userPrompt.length}`);
  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: userPrompt },
    ],
  });
  const block = response.content.find(b => b.type === 'text');
  let text = block ? block.text.trim() : '';
  const usage = response.usage || {};
  console.log(`[Claude] ← response ${Date.now() - t0}ms  in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0}`);
  text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    console.error('[Claude] Invalid JSON response:', text.slice(0, 400));
    throw new Error('Claude returned invalid JSON: ' + text.slice(0, 300));
  }
}

// --- Auto-pick timers (for disconnected players) ----------------------------

const autoPickTimers = new Map(); // playerId -> timeoutHandle

function clearAutoPickForPlayer(id) {
  const t = autoPickTimers.get(id);
  if (t) { clearTimeout(t); autoPickTimers.delete(id); }
}

function clearAllAutoPickTimers() {
  for (const t of autoPickTimers.values()) clearTimeout(t);
  autoPickTimers.clear();
}

function scheduleAutoPickForPlayer(id) {
  clearAutoPickForPlayer(id);
  const handle = setTimeout(() => {
    if (game.phase !== 'playing' || game.isProcessing) return;
    if (game.choices.has(id)) return;
    const opts = game.options.get(id);
    if (!opts || !opts.length) return;
    const idx = Math.floor(Math.random() * opts.length);
    submitChoice(id, idx);
  }, 30000);
  autoPickTimers.set(id, handle);
}

function scheduleAutoPicksForDisconnected() {
  for (const p of game.players.values()) {
    if (p.isBot || p.connected) continue;
    if (game.choices.has(p.id)) continue;
    if (!game.options.has(p.id)) continue;
    scheduleAutoPickForPlayer(p.id);
  }
}

// --- Bot timers -------------------------------------------------------------

let botTimers = [];
function clearBotTimers() {
  for (const t of botTimers) clearTimeout(t);
  botTimers = [];
}

function scheduleBotChoices() {
  clearBotTimers();
  if (game.phase !== 'playing' || game.isProcessing) return;
  for (const p of game.players.values()) {
    if (!p.isBot) continue;
    if (game.choices.has(p.id)) continue;
    const opts = game.options.get(p.id);
    if (!opts || !opts.length) continue;
    const delay = 2500 + Math.floor(Math.random() * 4500);
    botTimers.push(setTimeout(() => {
      if (game.phase !== 'playing' || game.isProcessing) return;
      if (game.choices.has(p.id)) return;
      const opts2 = game.options.get(p.id);
      if (!opts2 || !opts2.length) return;
      const idx = Math.floor(Math.random() * opts2.length);
      submitChoice(p.id, idx);
    }, delay));
  }
}

// --- Round flow -------------------------------------------------------------

function submitChoice(playerId, index) {
  if (game.phase !== 'playing' || game.isProcessing) return;
  const opts = game.options.get(playerId);
  if (!opts || index < 0 || index >= opts.length) return;
  if (game.choices.has(playerId)) return;
  game.choices.set(playerId, { index, text: opts[index] });
  broadcast();
  maybeResolveRound();
}

function maybeResolveRound() {
  const needed = activeChoosers();
  if (needed.length === 0) return;
  for (const p of needed) {
    if (!game.choices.has(p.id)) return;
  }
  resolveRound();
}

async function resolveRound() {
  clearBotTimers();
  clearAllAutoPickTimers();
  const actions = [...game.choices.entries()].map(([pid, c]) => {
    const p = game.players.get(pid);
    return { playerId: pid, name: p ? p.name : '?', optionText: c.text, optionIndex: c.index };
  });
  const isFinalResolution = game.round >= game.maxRounds;
  if (!isFinalResolution) game.round += 1;
  await runClaude({ isOpening: false, isFinalResolution, actions });
}

async function startGame(prompt, maxRounds) {
  if (game.phase !== 'lobby') return;
  if (![...game.players.values()].some(p => p.ready)) return;
  game.phase = 'playing';
  game.campaignPrompt = (prompt || '').trim();
  game.maxRounds = Math.max(3, Math.min(15, parseInt(maxRounds, 10) || 5));
  game.round = 1;
  game.history = [];
  await runClaude({ isOpening: true });
}

async function runClaude({ isOpening, isFinalResolution, actions }) {
  const label = isOpening ? 'opening' : isFinalResolution ? 'final' : `round ${game.round}`;
  console.log(`[Game]   → runClaude(${label})  players=${[...game.players.values()].filter(p=>p.ready).length}`);
  game.isProcessing = true;
  broadcast();
  try {
    const userPrompt = buildPrompt({ isOpening, isFinalResolution, actions });
    const result = await callClaude(userPrompt);

    applyStateUpdates(result.stateUpdates || []);
    game.currentTitle = result.title || '';
    game.currentNarration = result.narration || '';
    game.currentResolution = result.resolution || [];
    console.log(`[Game]   ← scene "${game.currentTitle}"  narration_words=${(game.currentNarration.split(/\s+/).length)}  resolution_entries=${game.currentResolution.length}`);

    game.history.push({
      round: game.round,
      title: result.title || '',
      narration: result.narration || '',
      scenario: result.scenario || '',
      actions: actions || [],
    });

    if (isFinalResolution || result.isFinal) {
      game.phase = 'finished';
      game.finalNarration = result.narration || '';
      game.finalTitle = result.title || '';
      game.options.clear();
      game.choices.clear();
      saveQuestSummary();
    } else {
      game.options.clear();
      game.choices.clear();
      for (const po of result.playerOptions || []) {
        const p = game.players.get(po.playerId);
        if (!p || p.hp <= 0) continue;
        if (Array.isArray(po.options) && po.options.length) {
          game.options.set(po.playerId, po.options.slice(0, 4));
        }
      }
    }
  } catch (e) {
    console.error('Claude error:', e);
    game.currentNarration = `(The Storyteller stumbles: ${e.message})`;
  } finally {
    game.isProcessing = false;
    broadcast();
    if (game.phase === 'playing') {
      scheduleBotChoices();
      scheduleAutoPicksForDisconnected();
    }
  }
}

function endGameEarly() {
  if (game.phase !== 'playing') return;
  game.phase = 'finished';
  game.finalNarration = game.finalNarration || 'The adventure was cut short by the gods themselves.';
  game.options.clear();
  game.choices.clear();
  clearBotTimers();
  clearAllAutoPickTimers();
  saveQuestSummary();
  broadcast();
}

function resetToLobby() {
  clearBotTimers();
  clearAllAutoPickTimers();

  // Carry items from surviving human players into the next adventure
  const survivorItems = new Map();
  if (game.phase === 'finished') {
    for (const p of game.players.values()) {
      if (!p.isBot && p.hp > 0 && p.items && p.items.length) {
        survivorItems.set(p.id, [...p.items]);
      }
    }
  }

  resetGameState();

  // Restore carried items (replaces fresh starting gear)
  for (const [id, items] of survivorItems) {
    const p = game.players.get(id);
    if (p) {
      p.items = items;
      console.log(`[Game]   carrying ${items.length} item(s) for ${p.name}: ${items.join(', ')}`);
    }
  }

  broadcast();
}

// --- Socket handlers --------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('joinAsTV', () => {
    socket.join('tv');
    socket.emit('tvState', snapshotForTV());
  });

  socket.on('joinAsPhone', ({ name, token } = {}) => {
    // --- Token reconnect ---
    if (token) {
      const existing = findPlayerByToken(token);
      if (existing) {
        // Disconnect any stale socket for this player
        if (existing.socketId && existing.socketId !== socket.id) {
          const old = io.sockets.sockets.get(existing.socketId);
          if (old) old.disconnect(true);
        }
        existing.socketId = socket.id;
        existing.connected = true;
        socket.data.playerId = existing.id;
        clearAutoPickForPlayer(existing.id);
        socket.emit('joined', { playerId: existing.id, token, isAdmin: existing.isAdmin });
        socket.emit('state', snapshotForPlayer(existing.id));
        broadcast();
        return;
      }
    }

    // --- New join ---
    const trimmed = String(name || '').trim().slice(0, 24);
    if (!trimmed) { socket.emit('joinError', { message: 'Please enter a name.' }); return; }

    const dup = [...game.players.values()].find(
      p => p.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (dup) {
      socket.emit('joinError', { message: 'That name is taken.' });
      return;
    }

    const waitingForNext = game.phase !== 'lobby';
    const id = newId();
    const tok = newToken();
    const player = {
      id,
      name: trimmed,
      socketId: socket.id,
      isAdmin: isAdminName(trimmed),
      isBot: false,
      connected: true,
      ready: false,
      waitingForNext,
      type: null,
      hp: 0, maxHp: 0, stats: {}, items: [], statusNote: '',
    };
    game.players.set(id, player);
    tokens.set(tok, id);
    socket.data.playerId = id;
    socket.emit('joined', { playerId: id, token: tok, isAdmin: player.isAdmin });
    socket.emit('state', snapshotForPlayer(id));
    broadcast();
  });

  socket.on('selectCharacter', ({ type } = {}) => {
    const id = socket.data.playerId;
    const player = id ? game.players.get(id) : null;
    if (!player) return;
    if (!CHARACTERS[type]) return;
    if (player.ready) return;
    Object.assign(player, rollCharacter(type), { ready: true });
    broadcast();
  });

  socket.on('startGame', ({ prompt, maxRounds } = {}) => {
    const id = socket.data.playerId;
    const player = id ? game.players.get(id) : null;
    if (!player || !player.isAdmin) return;
    startGame(prompt, maxRounds);
  });

  socket.on('addBot', () => {
    const id = socket.data.playerId;
    const player = id ? game.players.get(id) : null;
    if (!player || !player.isAdmin) return;
    if (game.phase !== 'lobby') return;
    const types = Object.keys(CHARACTERS);
    const type = types[Math.floor(Math.random() * types.length)];
    const bid = newId();
    const bot = {
      id: bid,
      name: pickBotName(),
      socketId: null,
      isAdmin: false,
      isBot: true,
      connected: true,
      ready: true,
      ...rollCharacter(type),
    };
    game.players.set(bid, bot);
    broadcast();
  });

  socket.on('kickPlayer', ({ playerId } = {}) => {
    const id = socket.data.playerId;
    const admin = id ? game.players.get(id) : null;
    if (!admin || !admin.isAdmin) return;
    if (playerId === admin.id) return;
    const target = game.players.get(playerId);
    if (!target) return;
    if (!target.isBot && target.socketId) {
      const s = io.sockets.sockets.get(target.socketId);
      if (s) { s.emit('kicked'); s.disconnect(true); }
    }
    // Revoke token
    for (const [tok, pid] of tokens.entries()) {
      if (pid === playerId) { tokens.delete(tok); break; }
    }
    clearAutoPickForPlayer(playerId);
    game.players.delete(playerId);
    game.options.delete(playerId);
    game.choices.delete(playerId);
    broadcast();
    if (game.phase === 'playing') maybeResolveRound();
  });

  socket.on('submitChoice', ({ index } = {}) => {
    const id = socket.data.playerId;
    if (!id) return;
    submitChoice(id, parseInt(index, 10));
  });

  socket.on('endGame', () => {
    const id = socket.data.playerId;
    const player = id ? game.players.get(id) : null;
    if (!player || !player.isAdmin) return;
    endGameEarly();
  });

  socket.on('setTTS', ({ enabled } = {}) => {
    const id = socket.data.playerId;
    const player = id ? game.players.get(id) : null;
    if (!player || !player.isAdmin) return;
    game.ttsEnabled = !!enabled;
    console.log(`[TTS]    admin ${enabled ? 'enabled' : 'disabled'} narration`);
    broadcast();
  });

  socket.on('resetGame', () => {
    const id = socket.data.playerId;
    const player = id ? game.players.get(id) : null;
    if (!player || !player.isAdmin) return;
    resetToLobby();
  });

  socket.on('disconnect', () => {
    const id = socket.data.playerId;
    if (!id) return;
    const player = game.players.get(id);
    if (!player) return;
    if (game.phase === 'lobby' || player.waitingForNext) {
      // Remove lobby/waiting players immediately; revoke token
      for (const [tok, pid] of tokens.entries()) {
        if (pid === id) { tokens.delete(tok); break; }
      }
      game.players.delete(id);
    } else {
      player.connected = false;
      player.socketId = null;
      if (game.phase === 'playing' && !game.choices.has(id) && game.options.has(id)) {
        scheduleAutoPickForPlayer(id);
      }
    }
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const publicUrl = getPublicUrl();
  console.log(`\n  TV view:    ${publicUrl}/tv`);
  console.log(`  Phone join: ${publicUrl}/phone`);
  console.log(`  (or scan the QR code shown on the TV view)\n`);
});
