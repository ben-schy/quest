'use strict';
const crypto = require('crypto');

// --- Constants ---------------------------------------------------------------

const ADMINS = new Set(['ben', 'fertz']);

const CHARACTERS = {
  Warrior: {
    blurb: 'Strong melee fighter. Best at direct combat and feats of strength.',
    hpRange: [25, 35],
    statRanges: { str: [13, 18], dex: [8, 12], int: [6, 10], cha: [8, 12] },
    startingItems: ['Iron Sword', 'Wooden Shield', 'Trail Rations'],
  },
  Mage: {
    blurb: 'Wielder of arcane spells. Strong with magic, fragile in body.',
    hpRange: [12, 18],
    statRanges: { str: [6, 10], dex: [8, 12], int: [14, 18], cha: [10, 14] },
    startingItems: ['Oaken Staff', 'Spellbook', 'Pouch of Reagents'],
  },
  Rogue: {
    blurb: 'Quick and cunning. Best at stealth, traps, and surprise.',
    hpRange: [18, 25],
    statRanges: { str: [8, 12], dex: [14, 18], int: [10, 14], cha: [10, 14] },
    startingItems: ['Twin Daggers', 'Lockpicks', 'Smoke Bomb'],
  },
  Cleric: {
    blurb: 'Devoted healer. Channels divine power to mend and protect.',
    hpRange: [20, 28],
    statRanges: { str: [10, 14], dex: [8, 12], int: [10, 14], cha: [13, 18] },
    startingItems: ['Iron Mace', 'Holy Symbol', 'Healing Potion'],
  },
};

const BOT_NAMES = [
  'Grommash', 'Lyralei', 'Thordak', 'Vex', 'Mira', 'Zog',
  'Brann', 'Sylvi', 'Ordric', 'Kaela', 'Ruun', 'Nyssa',
];

// --- ID / token helpers ------------------------------------------------------

function newId() { return crypto.randomBytes(6).toString('hex'); }
function newToken() { return crypto.randomBytes(16).toString('hex'); }

// --- Game state (single session) --------------------------------------------

const game = {
  phase: 'lobby',       // lobby | playing | finished
  campaignPrompt: '',
  round: 0,
  maxRounds: 5,
  players: new Map(),   // id -> player
  options: new Map(),   // playerId -> [string]
  choices: new Map(),   // playerId -> { index, text }
  currentTitle: '',
  currentNarration: '',
  currentResolution: [], // [{ playerId, result }] — last round's per-player outcomes
  finalNarration: '',
  finalTitle: '',
  history: [],
  isProcessing: false,
  ttsEnabled: true,     // admin-controlled TTS flag
};

// token -> playerId  (persists across game resets; cleared on kick)
const tokens = new Map();

// --- Character helpers -------------------------------------------------------

function rollInRange([lo, hi]) {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function rollCharacter(type) {
  const def = CHARACTERS[type];
  if (!def) throw new Error(`Unknown character type: ${type}`);
  const maxHp = rollInRange(def.hpRange);
  const stats = {};
  for (const [k, range] of Object.entries(def.statRanges)) stats[k] = rollInRange(range);
  return { type, maxHp, hp: maxHp, stats, items: [...def.startingItems], statusNote: '' };
}

function pickBotName() {
  const taken = new Set([...game.players.values()].map(p => p.name.toLowerCase()));
  const avail = BOT_NAMES.filter(n => !taken.has(n.toLowerCase()));
  const pool = avail.length ? avail : BOT_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// --- Public snapshots --------------------------------------------------------

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    isAdmin: !!p.isAdmin,
    isBot: !!p.isBot,
    connected: !!p.isBot || !!p.connected,
    ready: !!p.ready,
    hp: p.hp, maxHp: p.maxHp,
    stats: p.stats,
    items: p.items,
    statusNote: p.statusNote,
  };
}

function activeChoosers() {
  return [...game.players.values()].filter(p => p.ready && p.hp > 0 && !p.waitingForNext);
}

function snapshotForPlayer(playerId) {
  const player = game.players.get(playerId);
  const myResult = game.currentResolution.find(r => r.playerId === playerId);
  return {
    self: player ? publicPlayer(player) : null,
    phase: game.phase,
    round: game.round,
    maxRounds: game.maxRounds,
    campaignPrompt: game.campaignPrompt,
    players: [...game.players.values()].map(publicPlayer),
    currentTitle: game.currentTitle,
    currentNarration: game.currentNarration,
    myResult: myResult ? myResult.result : null,
    finalNarration: game.finalNarration,
    finalTitle: game.finalTitle,
    isProcessing: game.isProcessing,
    options: game.options.get(playerId) || [],
    hasChosen: game.choices.has(playerId),
    choicesSubmitted: game.choices.size,
    choicesNeeded: activeChoosers().length,
    isAdmin: !!(player && player.isAdmin),
    waitingForNext: !!(player && player.waitingForNext),
    ttsEnabled: game.ttsEnabled,
    history: game.history,
  };
}

function snapshotForTV() {
  const pending = activeChoosers().filter(p => !game.choices.has(p.id)).map(p => p.id);
  return {
    phase: game.phase,
    round: game.round,
    maxRounds: game.maxRounds,
    campaignPrompt: game.campaignPrompt,
    players: [...game.players.values()].map(publicPlayer),
    currentTitle: game.currentTitle,
    currentNarration: game.currentNarration,
    currentResolution: game.currentResolution,
    finalNarration: game.finalNarration,
    finalTitle: game.finalTitle,
    isProcessing: game.isProcessing,
    pendingChoices: pending,
    choicesSubmitted: game.choices.size,
    choicesNeeded: activeChoosers().length,
    ttsEnabled: game.ttsEnabled,
    history: game.history,
  };
}

// --- State mutations ---------------------------------------------------------

function applyStateUpdates(updates) {
  for (const u of updates || []) {
    const p = game.players.get(u.playerId);
    if (!p) continue;
    if (typeof u.hpDelta === 'number') {
      p.hp = Math.max(0, Math.min(p.maxHp, p.hp + u.hpDelta));
    }
    if (Array.isArray(u.itemsAdded)) {
      for (const it of u.itemsAdded) p.items.push(it);
    }
    if (Array.isArray(u.itemsRemoved)) {
      for (const it of u.itemsRemoved) {
        const idx = p.items.findIndex(x => x.toLowerCase() === String(it).toLowerCase());
        if (idx >= 0) p.items.splice(idx, 1);
      }
    }
    if (typeof u.statusNote === 'string') p.statusNote = u.statusNote;
  }
}

// Resets all game state back to lobby, re-rolls chars for existing human players.
// Does NOT clear the tokens map or broadcast — caller handles that.
function resetGameState() {
  game.phase = 'lobby';
  game.campaignPrompt = '';
  game.round = 0;
  game.history = [];
  game.options.clear();
  game.choices.clear();
  game.currentTitle = '';
  game.currentNarration = '';
  game.currentResolution = [];
  game.finalNarration = '';
  game.finalTitle = '';
  game.isProcessing = false;
  for (const p of game.players.values()) {
    p.waitingForNext = false;
    if (p.type) {
      const fresh = rollCharacter(p.type);
      p.hp = fresh.hp; p.maxHp = fresh.maxHp;
      p.stats = fresh.stats; p.items = fresh.items; p.statusNote = '';
    }
  }
}

// --- Lookup helpers ----------------------------------------------------------

function isAdminName(name) {
  return ADMINS.has(String(name || '').trim().toLowerCase());
}

function findPlayerBySocket(socketId) {
  for (const p of game.players.values()) if (p.socketId === socketId) return p;
  return null;
}

function findPlayerByToken(token) {
  const playerId = tokens.get(token);
  if (!playerId) return null;
  return game.players.get(playerId) || null;
}

// --- Exports -----------------------------------------------------------------

module.exports = {
  ADMINS, CHARACTERS, BOT_NAMES,
  game, tokens,
  newId, newToken,
  rollInRange, rollCharacter, pickBotName,
  publicPlayer, activeChoosers, snapshotForPlayer, snapshotForTV,
  applyStateUpdates, resetGameState,
  isAdminName, findPlayerBySocket, findPlayerByToken,
};
