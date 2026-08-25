// server/test_game.js
const assert = require('assert');
const ServerGame = require('./game');

console.log('Running ServerGame tests...');

// ── Test 1: Initialization ──────────────────────────────────────────────────
(function testInit() {
  const players = [
    { id: 'p1', name: 'Aman', type: 'human', isHost: true },
    { id: 'p2', name: 'Bob', type: 'human' }
  ];
  const pegs = [
    { id: 'peg_0', color: 'red' },
    { id: 'peg_1', color: 'blue' }
  ];
  const settings = { continueTurnOnMatch: true, timerEnabled: true, turnTimerSeconds: 15 };

  const game = new ServerGame('ROOM1', players, pegs, settings);

  assert.strictEqual(game.roomCode, 'ROOM1');
  assert.strictEqual(game.players.length, 2);
  assert.strictEqual(game.players[0].name, 'Aman');
  assert.strictEqual(game.players[0].isHost, true);
  assert.strictEqual(game.pegs.length, 2);
  assert.strictEqual(game.currentPlayerIndex, 0);
  assert.strictEqual(game.phase, 'waitingForRoll');
  assert.strictEqual(game.diceColor, null);

  console.log('✔ Test 1: Initialization passed');
})();

// ── Test 2: Roll request ─────────────────────────────────────────────────────
(function testRoll() {
  const players = [
    { id: 'p1', name: 'Aman', type: 'human' },
    { id: 'p2', name: 'Bob', type: 'human' }
  ];
  const pegs = [{ id: 'peg_0', color: 'red' }];
  const game = new ServerGame('ROOM1', players, pegs, {});

  // Try to roll for p2 (but it is p1's turn) -> should return null
  const badRoll = game.handleRollRequest('p2');
  assert.strictEqual(badRoll, null);

  // Roll for p1 with forced color 'red'
  const result = game.handleRollRequest('p1', 'red');
  assert.notStrictEqual(result, null);
  assert.strictEqual(result.type, 'roll_result');
  assert.strictEqual(result.color, 'red');
  assert.strictEqual(game.phase, 'waitingForPick');
  assert.strictEqual(game.diceColor, 'red');

  console.log('✔ Test 2: Roll request passed');
})();

// ── Test 3: Match / Pick peg ─────────────────────────────────────────────────
(function testPickMatch() {
  const players = [
    { id: 'p1', name: 'Aman', type: 'human' },
    { id: 'p2', name: 'Bob', type: 'human' }
  ];
  const pegs = [
    { id: 'peg_0', color: 'red' },
    { id: 'peg_1', color: 'blue' }
  ];
  const game = new ServerGame('ROOM1', players, pegs, { continueTurnOnMatch: true });

  game.handleRollRequest('p1', 'red');
  const pickResult = game.handlePickRequest('p1', 'peg_0');

  assert.notStrictEqual(pickResult, null);
  assert.strictEqual(pickResult.matched, true);
  assert.strictEqual(game.players[0].score, 1);
  assert.strictEqual(game.pegs[0].isCollected, true);
  
  // Since continueTurnOnMatch is true, turn stays on p1 but phase is waitingForRoll
  assert.strictEqual(game.currentPlayerIndex, 0);
  assert.strictEqual(game.phase, 'waitingForRoll');
  assert.strictEqual(game.diceColor, null);

  console.log('✔ Test 3: Match / Pick peg passed');
})();

// ── Test 4: Mismatch / Pass Turn ─────────────────────────────────────────────
(function testPickMismatch() {
  const players = [
    { id: 'p1', name: 'Aman', type: 'human' },
    { id: 'p2', name: 'Bob', type: 'human' }
  ];
  const pegs = [
    { id: 'peg_0', color: 'red' },
    { id: 'peg_1', color: 'blue' },
    { id: 'peg_2', color: 'green' } // need > 2 uncollected pegs to reveal
  ];
  const game = new ServerGame('ROOM1', players, pegs, {});

  game.handleRollRequest('p1', 'red');
  
  // Pick green peg (mismatch)
  const pickResult = game.handlePickRequest('p1', 'peg_2');

  assert.notStrictEqual(pickResult, null);
  assert.strictEqual(pickResult.matched, false);
  assert.strictEqual(pickResult.revealPicked, true);
  assert.strictEqual(game.pegs[2].isRevealed, true);
  
  // Turn passes to Bob (index 1)
  assert.strictEqual(game.currentPlayerIndex, 1);
  assert.strictEqual(game.phase, 'waitingForRoll');

  console.log('✔ Test 4: Mismatch / Pass Turn passed');
})();

// ── Test 5: Timeouts and Offline player skip ────────────────────────────────
(function testTimeoutOffline() {
  const players = [
    { id: 'p1', name: 'Aman', type: 'human', isConnected: true },
    { id: 'p2', name: 'Bob', type: 'human', isConnected: true }
  ];
  const pegs = [
    { id: 'peg_0', color: 'red' },
    { id: 'peg_1', color: 'blue' },
    { id: 'peg_2', color: 'green' }
  ];
  const game = new ServerGame('ROOM1', players, pegs, { timerEnabled: true });

  // P1 does mismatch, turn goes to Bob
  game.handleRollRequest('p1', 'red');
  game.handlePickRequest('p1', 'peg_2');

  assert.strictEqual(game.currentPlayerIndex, 1); // Now Bob's turn
  assert.strictEqual(game.players[1].isConnected, true);

  // Bob disconnects during his turn
  game.players[1].isConnected = false;

  // Running tick on server should immediately time out Bob because Bob is offline
  const tickResult = game.tick();
  assert.notStrictEqual(tickResult, null);
  assert.strictEqual(tickResult.type, 'timeout_result');

  // Turn goes back to Aman (index 0)
  assert.strictEqual(game.currentPlayerIndex, 0);

  console.log('✔ Test 5: Timeouts and Offline player skip passed');
})();

// ── Test 6: 6x Combo Bomb Award, Placement, and Detonation ──────────────────
(function testBombMechanics() {
  const players = [
    { id: 'p1', name: 'Aman', type: 'human', isConnected: true },
    { id: 'p2', name: 'Bob', type: 'human', isConnected: true }
  ];
  const pegs = [
    { id: 'peg_0', color: 'red' },
    { id: 'peg_1', color: 'red' },
    { id: 'peg_2', color: 'red' },
    { id: 'peg_3', color: 'red' },
    { id: 'peg_4', color: 'red' },
    { id: 'peg_5', color: 'red' },
    { id: 'peg_6', color: 'blue' },
    { id: 'peg_7', color: 'green' }
  ];
  const game = new ServerGame('ROOM1', players, pegs, { continueTurnOnMatch: true });

  // P1 gets 5 consecutive matches in the same turn
  for (let i = 0; i < 5; i++) {
    game.handleRollRequest('p1', 'red');
    const res = game.handlePickRequest('p1', `peg_${i}`);
    assert.strictEqual(res.matched, true);
  }

  // After 5 matches, P1 should have 1 bomb in inventory
  assert.strictEqual(game.players[0].bombs, 1, 'P1 should be awarded 1 bomb on 5x combo');

  // P1 places bomb under peg_6
  const placeRes = game.handlePlaceBombRequest('p1', 'peg_6');
  assert.notStrictEqual(placeRes, null);
  assert.strictEqual(game.players[0].bombs, 0, 'Bomb should be deducted from inventory');
  assert.strictEqual(game.bombedPegId, 'peg_6');
  assert.strictEqual(game.bombTurnsLeft, 4); // 2 players * 2 rounds = 4 turns

  // P1 mismatches with peg_7 -> turn passes to Bob
  game.handleRollRequest('p1', 'blue');
  game.handlePickRequest('p1', 'peg_7');
  assert.strictEqual(game.currentPlayerIndex, 1); // Bob's turn

  // Bob has initial score 0. Let's give Bob 10 points to verify -5 penalty.
  game.players[1].score = 10;

  // Bob rolls blue and taps peg_6 (which has the hidden bomb and matches blue!)
  game.handleRollRequest('p2', 'blue');
  game.handlePickRequest('p2', 'peg_6');

  // Bomb explodes! Bob loses 5 points strictly (10 - 5 = 5), peg is NOT collected, color is NOT revealed
  assert.strictEqual(game.players[1].score, 5, 'Bob should have net 5 points (10 - 5 = 5, no match points)');
  const bombedPeg = game.pegs.find(p => p.id === 'peg_6');
  assert.strictEqual(bombedPeg.isCollected, false, 'Bombed peg should NOT be collected');
  assert.strictEqual(bombedPeg.isRevealed, false, 'Bombed peg should NOT be revealed');
  assert.strictEqual(game.bombedPegId, null, 'Bomb should be cleared after detonation');
  assert.strictEqual(game.bombBannerType, 'exploded');

  console.log('✔ Test 6: 5x Combo Bomb Award, Placement, and Detonation passed');
})();

console.log('All ServerGame tests passed successfully! 🎉');
