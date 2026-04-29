'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHARACTERS, BOT_NAMES,
  game, tokens,
  newId, newToken,
  rollInRange, rollCharacter, pickBotName,
  publicPlayer, activeChoosers, snapshotForPlayer, snapshotForTV,
  applyStateUpdates, resetGameState,
  isAdminName, findPlayerBySocket, findPlayerByToken,
} = require('../lib/game');

function clearGame() {
  game.phase = 'lobby';
  game.campaignPrompt = '';
  game.round = 0;
  game.history = [];
  game.players.clear();
  game.options.clear();
  game.choices.clear();
  game.currentTitle = '';
  game.currentScenario = '';
  game.currentNarration = '';
  game.finalNarration = '';
  game.isProcessing = false;
  tokens.clear();
}

function makePlayer(overrides = {}) {
  const id = newId();
  return {
    id,
    name: 'Tester',
    socketId: 'sock_' + id,
    isAdmin: false,
    isBot: false,
    connected: true,
    ready: false,
    type: null,
    hp: 20, maxHp: 20,
    stats: { str: 10, dex: 10, int: 10, cha: 10 },
    items: [],
    statusNote: '',
    ...overrides,
  };
}

// --- rollInRange ------------------------------------------------------------

describe('rollInRange', () => {
  test('returns value within [lo, hi]', () => {
    for (let i = 0; i < 200; i++) {
      const v = rollInRange([5, 10]);
      assert.ok(v >= 5 && v <= 10, `${v} not in [5,10]`);
    }
  });

  test('works with a single-value range', () => {
    assert.equal(rollInRange([7, 7]), 7);
  });
});

// --- rollCharacter ----------------------------------------------------------

describe('rollCharacter', () => {
  for (const type of Object.keys(CHARACTERS)) {
    test(`rolls valid ${type}`, () => {
      const c = rollCharacter(type);
      assert.equal(c.type, type);
      const def = CHARACTERS[type];
      assert.ok(c.hp >= def.hpRange[0] && c.hp <= def.hpRange[1]);
      assert.equal(c.hp, c.maxHp);
      assert.deepEqual(c.items, def.startingItems);
      assert.equal(c.statusNote, '');
      for (const [stat, range] of Object.entries(def.statRanges)) {
        assert.ok(
          c.stats[stat] >= range[0] && c.stats[stat] <= range[1],
          `${stat}=${c.stats[stat]} out of range [${range}]`,
        );
      }
    });
  }

  test('throws for unknown type', () => {
    assert.throws(() => rollCharacter('Dragon'));
  });
});

// --- isAdminName ------------------------------------------------------------

describe('isAdminName', () => {
  test('recognises ben and fertz case-insensitively', () => {
    assert.ok(isAdminName('ben'));
    assert.ok(isAdminName('Ben'));
    assert.ok(isAdminName('BEN'));
    assert.ok(isAdminName('fertz'));
    assert.ok(isAdminName('Fertz'));
  });

  test('rejects others', () => {
    assert.ok(!isAdminName('alice'));
    assert.ok(!isAdminName(''));
    assert.ok(!isAdminName(null));
  });
});

// --- newId / newToken -------------------------------------------------------

describe('newId / newToken', () => {
  test('newId produces 12-hex-char strings', () => {
    assert.match(newId(), /^[0-9a-f]{12}$/);
  });

  test('newToken produces 32-hex-char strings', () => {
    assert.match(newToken(), /^[0-9a-f]{32}$/);
  });

  test('ids are unique', () => {
    const set = new Set(Array.from({ length: 100 }, () => newId()));
    assert.equal(set.size, 100);
  });
});

// --- publicPlayer -----------------------------------------------------------

describe('publicPlayer', () => {
  test('exposes expected fields', () => {
    const p = makePlayer({ name: 'Alice', type: 'Warrior', ready: true, isAdmin: true });
    const pub = publicPlayer(p);
    assert.equal(pub.name, 'Alice');
    assert.equal(pub.type, 'Warrior');
    assert.equal(pub.isAdmin, true);
    assert.equal(pub.connected, true);
    assert.equal(pub.ready, true);
  });

  test('bot is always connected', () => {
    const p = makePlayer({ isBot: true, connected: false });
    assert.equal(publicPlayer(p).connected, true);
  });

  test('disconnected human shows connected=false', () => {
    const p = makePlayer({ isBot: false, connected: false });
    assert.equal(publicPlayer(p).connected, false);
  });
});

// --- activeChoosers ---------------------------------------------------------

describe('activeChoosers', () => {
  test('returns only ready, alive players', () => {
    clearGame();
    const a = makePlayer({ ready: true, hp: 10 });
    const b = makePlayer({ ready: true, hp: 0 });   // dead
    const c = makePlayer({ ready: false, hp: 15 });  // not ready
    game.players.set(a.id, a);
    game.players.set(b.id, b);
    game.players.set(c.id, c);
    const choosers = activeChoosers();
    assert.equal(choosers.length, 1);
    assert.equal(choosers[0].id, a.id);
    clearGame();
  });

  test('returns empty when no players', () => {
    clearGame();
    assert.deepEqual(activeChoosers(), []);
  });
});

// --- applyStateUpdates -------------------------------------------------------

describe('applyStateUpdates', () => {
  test('applies hpDelta, clamped to [0, maxHp]', () => {
    clearGame();
    const p = makePlayer({ hp: 20, maxHp: 20 });
    game.players.set(p.id, p);
    applyStateUpdates([{ playerId: p.id, hpDelta: -5 }]);
    assert.equal(game.players.get(p.id).hp, 15);
  });

  test('does not go below 0', () => {
    clearGame();
    const p = makePlayer({ hp: 5, maxHp: 20 });
    game.players.set(p.id, p);
    applyStateUpdates([{ playerId: p.id, hpDelta: -100 }]);
    assert.equal(game.players.get(p.id).hp, 0);
  });

  test('does not exceed maxHp', () => {
    clearGame();
    const p = makePlayer({ hp: 18, maxHp: 20 });
    game.players.set(p.id, p);
    applyStateUpdates([{ playerId: p.id, hpDelta: 10 }]);
    assert.equal(game.players.get(p.id).hp, 20);
  });

  test('adds and removes items', () => {
    clearGame();
    const p = makePlayer({ items: ['Sword', 'Shield'] });
    game.players.set(p.id, p);
    applyStateUpdates([{ playerId: p.id, itemsAdded: ['Potion'], itemsRemoved: ['sword'] }]);
    const items = game.players.get(p.id).items;
    assert.ok(items.includes('Potion'));
    assert.ok(!items.includes('Sword'));
    assert.ok(items.includes('Shield'));
  });

  test('sets statusNote', () => {
    clearGame();
    const p = makePlayer();
    game.players.set(p.id, p);
    applyStateUpdates([{ playerId: p.id, statusNote: 'poisoned' }]);
    assert.equal(game.players.get(p.id).statusNote, 'poisoned');
  });

  test('silently ignores unknown playerId', () => {
    assert.doesNotThrow(() => applyStateUpdates([{ playerId: 'ghost', hpDelta: -5 }]));
  });

  test('handles empty / null updates gracefully', () => {
    assert.doesNotThrow(() => applyStateUpdates(null));
    assert.doesNotThrow(() => applyStateUpdates([]));
  });
});

// --- findPlayerBySocket / findPlayerByToken ---------------------------------

describe('findPlayerBySocket / findPlayerByToken', () => {
  test('findPlayerBySocket returns correct player', () => {
    clearGame();
    const p = makePlayer({ socketId: 'abc123' });
    game.players.set(p.id, p);
    assert.equal(findPlayerBySocket('abc123').id, p.id);
    assert.equal(findPlayerBySocket('nope'), null);
  });

  test('findPlayerByToken returns correct player', () => {
    clearGame();
    const p = makePlayer();
    game.players.set(p.id, p);
    const tok = newToken();
    tokens.set(tok, p.id);
    assert.equal(findPlayerByToken(tok).id, p.id);
    assert.equal(findPlayerByToken('badtoken'), null);
  });

  test('findPlayerByToken returns null when player was deleted', () => {
    clearGame();
    const p = makePlayer();
    game.players.set(p.id, p);
    const tok = newToken();
    tokens.set(tok, p.id);
    game.players.delete(p.id);
    assert.equal(findPlayerByToken(tok), null);
  });
});

// --- pickBotName ------------------------------------------------------------

describe('pickBotName', () => {
  test('returns a string from BOT_NAMES when pool is available', () => {
    clearGame();
    const name = pickBotName();
    assert.ok(BOT_NAMES.includes(name));
  });

  test('avoids names already taken by players', () => {
    clearGame();
    for (const n of BOT_NAMES.slice(0, -1)) {
      const p = makePlayer({ name: n });
      game.players.set(p.id, p);
    }
    const name = pickBotName();
    assert.equal(name, BOT_NAMES[BOT_NAMES.length - 1]);
  });
});

// --- resetGameState ---------------------------------------------------------

describe('resetGameState', () => {
  test('clears round, choices, options, history', () => {
    clearGame();
    game.phase = 'playing';
    game.round = 3;
    game.history.push({ round: 1 });
    game.choices.set('x', {});
    game.options.set('x', ['a']);
    resetGameState();
    assert.equal(game.phase, 'lobby');
    assert.equal(game.round, 0);
    assert.equal(game.history.length, 0);
    assert.equal(game.choices.size, 0);
    assert.equal(game.options.size, 0);
  });

  test('re-rolls characters for players that have a type', () => {
    clearGame();
    const p = makePlayer({ type: 'Warrior', ready: true });
    Object.assign(p, rollCharacter('Warrior'));
    game.players.set(p.id, p);
    p.hp = 1;
    p.statusNote = 'dying';
    resetGameState();
    const updated = game.players.get(p.id);
    assert.equal(updated.statusNote, '');
    assert.ok(updated.hp > 0);
  });

  test('does not touch the tokens map', () => {
    clearGame();
    tokens.set('tok', 'someId');
    resetGameState();
    assert.ok(tokens.has('tok'));
  });
});

// --- snapshotForPlayer / snapshotForTV --------------------------------------

describe('snapshotForPlayer', () => {
  test('returns expected shape', () => {
    clearGame();
    const p = makePlayer({ ready: true, hp: 15 });
    game.players.set(p.id, p);
    const snap = snapshotForPlayer(p.id);
    assert.equal(snap.phase, 'lobby');
    assert.ok(Array.isArray(snap.players));
    assert.equal(snap.self.id, p.id);
    assert.equal(snap.isAdmin, false);
  });

  test('self is null for unknown playerId', () => {
    clearGame();
    const snap = snapshotForPlayer('nonexistent');
    assert.equal(snap.self, null);
  });
});

describe('snapshotForTV', () => {
  test('pendingChoices lists only choosers who have not chosen', () => {
    clearGame();
    game.phase = 'playing';
    const a = makePlayer({ ready: true, hp: 10 });
    const b = makePlayer({ ready: true, hp: 10 });
    game.players.set(a.id, a);
    game.players.set(b.id, b);
    game.choices.set(a.id, { index: 0, text: 'Option A' });
    const snap = snapshotForTV();
    assert.deepEqual(snap.pendingChoices, [b.id]);
  });
});
