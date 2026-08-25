// server/game.js

class ServerGame {
  constructor(roomCode, players, pegs, settings) {
    this.roomCode = roomCode;
    this.continueTurnOnMatch = settings.continueTurnOnMatch !== false;
    this.timerEnabled = settings.timerEnabled !== false;
    this.turnTimerSeconds = settings.turnTimerSeconds || 15;

    // Initialize players
    this.players = players.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type || 'human',
      isHost: p.isHost || false,
      isConnected: p.isConnected !== false,
      avatarEmoji: p.avatarEmoji || '👤',
      colorValue: p.colorValue || 0xff2d8c83,
      level: p.level || 1,
      score: p.score || 0,
      collection: p.collection || [],
      shields: p.shields || 0,
      magicHands: p.magicHands || 0,
      secondChances: p.secondChances || 0,
      swapDice: p.swapDice || 0,
      bombs: p.bombs || 0,
      correctStreak: p.correctStreak || 0,
      matchStreak: p.matchStreak || 0,
      diceColorMatchCounts: p.diceColorMatchCounts || {}
    }));

    // Initialize pegs
    this.pegs = pegs.map(peg => ({
      id: peg.id,
      color: peg.color,
      position: peg.position,
      isCollected: peg.isCollected || false,
      isRevealed: peg.isRevealed || false
    }));

    this.currentPlayerIndex = 0;
    this.phase = 'waitingForRoll';
    this.diceColor = null;
    this.rolledColor = null;
    this.lastDiceColor = null;
    this.lastPickedPegId = null;

    this.magicHandArmed = false;
    this.shieldArmed = false;
    this.secondChanceArmed = false;

    this.bombedPegId = null;
    this.bombPlacedByPlayerName = null;
    this.bombTurnsLeft = 0;
    this.bombBannerSequence = 0;
    this.bombBannerMessage = null;
    this.bombBannerType = null;

    this.comboCount = 0;
    this.lastComboSequence = 0;
    this.powerUpUsedSequence = 0;
    this.powerUpUsedPlayerIndex = null;
    this.powerUpUsedType = null;
    this.powerUpAwardSequence = 0;
    this.powerUpAwardedPlayerIndex = null;
    this.powerUpAwardedType = null;
    this.powerUpAwardedTypes = [];
    this.magicHandAwardSequence = 0;
    this.magicHandAwardedPlayerIndex = null;
    this.jackpotSequence = 0;
    this.jackpotPlayerIndex = null;
    this.result = null;

    this.turnTimeLeft = this.turnTimerSeconds;
    this.message = `${this.players[0].name}, roll the dice`;
  }

  rollDice(excludeColor) {
    const colors = ['red', 'blue', 'green', 'yellow', 'black', 'white'];
    const available = colors.filter(c => c !== excludeColor);
    return available[Math.floor(Math.random() * available.length)];
  }

  handleRollRequest(playerId, colorName = null) {
    if (this.phase !== 'waitingForRoll') return null;
    if (this.players[this.currentPlayerIndex].id !== playerId) return null;

    // Hide all non-collected pegs when starting a new roll/turn
    this.pegs.forEach(p => {
      if (!p.isCollected) p.isRevealed = false;
    });

    // Use forced color (from optimistic client generation) or choose random
    let color = colorName;
    if (!color) {
      color = this.rollDice(this.lastDiceColor);
    }

    this.rolledColor = color;
    this.diceColor = color;
    this.phase = 'waitingForPick';
    this.lastPickedPegId = null;
    this.message = this.shieldArmed
      ? `🛡️ Shield armed: find a hidden ${color} peg`
      : `Find a hidden ${color} peg`;
    
    this.turnTimeLeft = this.turnTimerSeconds;

    return {
      type: 'roll_result',
      color: color,
      snapshot: this.getSnapshot()
    };
  }

  handleSwapRequest(playerId, colorName = null) {
    const player = this.players[this.currentPlayerIndex];
    if (player.id !== playerId) return null;
    if (player.swapDice <= 0) return null;
    if (this.phase === 'finished' || this.phase === 'revealing') return null;

    player.swapDice -= 1;
    this.powerUpUsedType = 'swapDice';
    this.powerUpUsedPlayerIndex = this.currentPlayerIndex;
    this.powerUpUsedSequence += 1;

    let color = colorName;
    if (!color) {
      color = this.rollDice(this.diceColor);
    }

    // Hide all non-collected pegs when swapping
    this.pegs.forEach(p => {
      if (!p.isCollected) p.isRevealed = false;
    });

    this.rolledColor = color;
    this.diceColor = color;
    this.phase = 'waitingForPick';
    this.lastPickedPegId = null;
    this.message = `Swapped dice! Find a hidden ${color} peg`;
    
    this.turnTimeLeft = this.turnTimerSeconds;

    return {
      type: 'swap_result',
      color: color,
      snapshot: this.getSnapshot()
    };
  }

  handlePowerUpRequest(playerId, powerUpType) {
    if (this.players[this.currentPlayerIndex].id !== playerId) return null;
    if (this.phase !== 'waitingForPick' && this.phase !== 'waitingForRoll') return null;

    const player = this.players[this.currentPlayerIndex];
    if (powerUpType === 'shield') {
      if (player.shields <= 0) return null;
      this.shieldArmed = !this.shieldArmed;
      if (this.shieldArmed) {
        this.powerUpUsedType = 'shield';
        this.powerUpUsedPlayerIndex = this.currentPlayerIndex;
        this.powerUpUsedSequence += 1;
        this.magicHandArmed = false;
        this.secondChanceArmed = false;
        this.message = this.diceColor
          ? `🛡️ Shield armed: find a hidden ${this.diceColor} peg`
          : '🛡️ Shield armed: roll the dice';
      } else {
        this.message = this.diceColor
          ? `Find a hidden ${this.diceColor} peg`
          : `${player.name}, roll the dice`;
      }
    } else if (powerUpType === 'magicHand') {
      if (player.magicHands <= 0) return null;
      this.magicHandArmed = !this.magicHandArmed;
      if (this.magicHandArmed) {
        this.powerUpUsedType = 'magicHand';
        this.powerUpUsedPlayerIndex = this.currentPlayerIndex;
        this.powerUpUsedSequence += 1;
        this.shieldArmed = false;
        this.secondChanceArmed = false;
        this.message = '✨ Magic Hand armed! Tap any hidden peg to collect it.';
      } else {
        this.message = this.diceColor
          ? `Find a hidden ${this.diceColor} peg`
          : `${player.name}, roll the dice`;
      }
    } else if (powerUpType === 'secondChance') {
      if (player.secondChances <= 0) return null;
      this.secondChanceArmed = !this.secondChanceArmed;
      if (this.secondChanceArmed) {
        this.powerUpUsedType = 'secondChance';
        this.powerUpUsedPlayerIndex = this.currentPlayerIndex;
        this.powerUpUsedSequence += 1;
        this.shieldArmed = false;
        this.magicHandArmed = false;
        this.message = this.diceColor
          ? '🎯 Second Chance armed: mismatch = roll again!'
          : '🎯 Second Chance armed: roll the dice';
      } else {
        this.message = this.diceColor
          ? `Find a hidden ${this.diceColor} peg`
          : `${player.name}, roll the dice`;
      }
    }

    return {
      type: 'powerup_result',
      powerUpType: powerUpType,
      snapshot: this.getSnapshot()
    };
  }

  handlePickRequest(playerId, pegId) {
    if (this.players[this.currentPlayerIndex].id !== playerId) return null;
    
    const usingMagicHand = this.magicHandArmed && this.players[this.currentPlayerIndex].magicHands > 0;
    if (!usingMagicHand && (this.phase !== 'waitingForPick' || !this.diceColor)) {
      return null;
    }

    const peg = this.pegs.find(p => p.id === pegId);
    if (!peg || peg.isCollected) return null;

    const usingShield = !usingMagicHand && this.shieldArmed && this.players[this.currentPlayerIndex].shields > 0;
    const usingSecondChance = !usingMagicHand && !usingShield && this.secondChanceArmed && this.players[this.currentPlayerIndex].secondChances > 0;

    const matched = (peg.color === this.diceColor) || usingMagicHand;
    const revealPicked = !peg.isRevealed && (this.pegs.filter(p => !p.isCollected).length > 2);

    let revealColor = null;
    if (revealPicked) {
      revealColor = peg.color;
    }

    const maxPowerUpInventory = 3;
    let shieldEarned = false;
    let magicHandEarned = false;
    let secondChanceEarned = false;
    let swapDiceEarned = false;

    if (matched) {
      peg.isCollected = true;
      const isLastPeg = !this.pegs.some(p => !p.isCollected);

      const player = this.players[this.currentPlayerIndex];
      const nextStreak = usingMagicHand ? 0 : player.correctStreak + 1;
      const nextMatchStreak = usingMagicHand ? 0 : player.matchStreak + 1;

      if (this.continueTurnOnMatch) {
        shieldEarned = !usingMagicHand && nextStreak === 2 && player.shields < maxPowerUpInventory;
        secondChanceEarned = !usingMagicHand && nextStreak === 3 && player.secondChances < maxPowerUpInventory;
        magicHandEarned = !usingMagicHand && nextStreak === 4 && player.magicHands < maxPowerUpInventory;

        const colorCount = player.collection.filter(c => c === peg.color).length + 1;
        swapDiceEarned = colorCount === 2 && player.swapDice < maxPowerUpInventory;
      } else {
        shieldEarned = !usingMagicHand && nextStreak === 2 && player.shields < maxPowerUpInventory;
        magicHandEarned = !usingMagicHand && nextStreak === 3 && player.magicHands < maxPowerUpInventory;
        secondChanceEarned = !usingMagicHand && nextStreak >= 4 && player.secondChances < maxPowerUpInventory;

        if (!usingMagicHand && this.diceColor) {
          const nextColorCount = (player.diceColorMatchCounts[this.diceColor] || 0) + 1;
          player.diceColorMatchCounts[this.diceColor] = nextColorCount;
          swapDiceEarned = nextColorCount === 2 && player.swapDice < maxPowerUpInventory;
        }
      }

      const baseGain = isLastPeg ? 2 : 1;
      const currentCombo = this.comboCount + 1;
      const multiplier = currentCombo >= 5 ? 5 : currentCombo >= 3 ? 3 : currentCombo >= 2 ? 2 : 1;
      const scoreGain = baseGain * multiplier;

      // Check if this picked peg had a hidden bomb planted under it
      if (this.bombedPegId && pegId === this.bombedPegId) {
        player.score = Math.max(0, player.score - 5);
        this.bombedPegId = null;
        this.bombTurnsLeft = 0;
        this.bombBannerSequence += 1;
        this.bombBannerType = 'exploded';
        this.bombBannerMessage = `💥 BOOM! ${player.name} triggered the Bomb! (-5 Points)`;
      }

      // Update player stats
      player.score += scoreGain;
      player.collection.push(peg.color);
      player.correctStreak = this.continueTurnOnMatch
        ? (nextStreak === 4 ? 0 : nextStreak)
        : (secondChanceEarned ? 0 : nextStreak);
      player.matchStreak = nextMatchStreak;
      player.shields += (shieldEarned ? 1 : 0);
      player.magicHands += (magicHandEarned ? 1 : 0) - (usingMagicHand ? 1 : 0);
      player.secondChances += (secondChanceEarned ? 1 : 0);
      player.swapDice += (swapDiceEarned ? 1 : 0);

      const bombEarned = (this.comboCount + 1) === 5;
      if (bombEarned) {
        player.bombs = (player.bombs || 0) + 1;
      }

      // Power Up awarded tracking
      const earnedTypes = [];
      if (shieldEarned) earnedTypes.push('shield');
      if (magicHandEarned) earnedTypes.push('magicHand');
      if (secondChanceEarned) earnedTypes.push('secondChance');
      if (swapDiceEarned) earnedTypes.push('swapDice');
      if (bombEarned) earnedTypes.push('bomb');

      if (earnedTypes.length > 0) {
        this.powerUpAwardSequence += 1;
        this.powerUpAwardedPlayerIndex = this.currentPlayerIndex;
        this.powerUpAwardedTypes = earnedTypes;
        this.powerUpAwardedType = earnedTypes[0];
      } else {
        this.powerUpAwardedType = null;
        this.powerUpAwardedTypes = [];
      }

      if (magicHandEarned) {
        this.magicHandAwardSequence += 1;
        this.magicHandAwardedPlayerIndex = this.currentPlayerIndex;
      }

      if (isLastPeg) {
        this.jackpotSequence += 1;
        this.jackpotPlayerIndex = this.currentPlayerIndex;
      }

      this.comboCount += 1;
      this.lastComboSequence += 1;

      this.magicHandArmed = false;
      this.shieldArmed = false;
      this.secondChanceArmed = false;
      this.lastPickedPegId = pegId;

      const hasWon = this._checkWinConditions();
      if (!hasWon) {
        if (this.continueTurnOnMatch) {
          this.lastDiceColor = this.diceColor;
          this.diceColor = null;
          this.phase = 'waitingForRoll';
          this.turnTimeLeft = this.turnTimerSeconds;
          this.message = `${player.name} matched! Roll again.`;
        } else {
          this._passTurn();
        }
      }
    } else {
      // Mismatch
      const player = this.players[this.currentPlayerIndex];
      
      // Check if this picked peg had a hidden bomb planted under it
      if (this.bombedPegId && pegId === this.bombedPegId) {
        player.score = Math.max(0, player.score - 5);
        this.bombedPegId = null;
        this.bombTurnsLeft = 0;
        this.bombBannerSequence += 1;
        this.bombBannerType = 'exploded';
        this.bombBannerMessage = `💥 BOOM! ${player.name} triggered the Bomb! (-5 Points)`;
      }

      if (usingShield) {
        player.shields -= 1;
        this.shieldArmed = false;
        this.lastPickedPegId = pegId;
        this.message = '🛡️ Shield protected your streak! Try picking again with the same dice.';
        this.pegs.forEach(p => {
          if (!p.isCollected) p.isRevealed = false;
        });
        this.turnTimeLeft = this.turnTimerSeconds;
        // Player gets to retry pick immediately, turn does not change
      } else if (usingSecondChance) {
        player.secondChances -= 1;
        this.secondChanceArmed = false;
        if (revealPicked) peg.isRevealed = true;
        this.lastPickedPegId = pegId;
        this.lastDiceColor = this.diceColor;
        this.diceColor = null;
        this.phase = 'waitingForRoll';
        this.turnTimeLeft = this.turnTimerSeconds;
        this.message = 'Second Chance used! Roll the dice again.';
        this.pegs.forEach(p => {
          if (!p.isCollected) p.isRevealed = false;
        });
      } else {
        if (revealPicked) peg.isRevealed = true;
        player.correctStreak = 0;
        player.matchStreak = 0;
        this.comboCount = 0;
        this.lastPickedPegId = pegId;
        this._passTurn();
      }
    }

    return {
      type: 'pick_result',
      pegId: pegId,
      matched: matched,
      revealPicked: revealPicked,
      revealColor: revealColor,
      snapshot: this.getSnapshot()
    };
  }

  handlePlaceBombRequest(playerId, pegId) {
    if (this.players[this.currentPlayerIndex].id !== playerId) return null;
    const player = this.players[this.currentPlayerIndex];
    if ((player.bombs || 0) <= 0) return null;

    const peg = this.pegs.find(p => p.id === pegId);
    if (!peg || peg.isCollected) return null;

    player.bombs = Math.max(0, (player.bombs || 0) - 1);
    this.bombedPegId = pegId;
    this.bombPlacedByPlayerName = player.name;
    this.bombTurnsLeft = this.players.length * 2;
    this.bombBannerSequence += 1;
    this.bombBannerType = 'placed';
    this.bombBannerMessage = `💣 ${player.name} planted a HIDDEN BOMB under a disc! Be Alert! ⚠️`;

    return {
      type: 'place_bomb_result',
      pegId: pegId,
      snapshot: this.getSnapshot()
    };
  }

  handleTimeout() {
    const player = this.players[this.currentPlayerIndex];
    player.correctStreak = 0;
    player.matchStreak = 0;
    this.comboCount = 0;

    if (this.lastPickedPegId) {
      const lastPeg = this.pegs.find(p => p.id === this.lastPickedPegId);
      if (lastPeg && !lastPeg.isCollected) {
        lastPeg.isRevealed = false;
      }
    }

    this._passTurn();
    this.message = `${player.name} timed out! ${this.players[this.currentPlayerIndex].name}, your turn.`;
    
    return {
      type: 'timeout_result',
      snapshot: this.getSnapshot()
    };
  }

  tick() {
    if (this.phase === 'finished' || !this.timerEnabled) return null;

    const currPlayer = this.players[this.currentPlayerIndex];
    if (!currPlayer.isConnected) {
      return this.handleTimeout();
    }

    if (this.turnTimeLeft <= 1) {
      return this.handleTimeout();
    } else {
      this.turnTimeLeft -= 1;
      return null;
    }
  }

  _passTurn() {
    this.lastDiceColor = this.diceColor;
    this.diceColor = null;
    this.shieldArmed = false;
    this.magicHandArmed = false;
    this.secondChanceArmed = false;
    this.comboCount = 0;

    // Manage bomb timer and defusal
    if (this.bombedPegId) {
      this.bombTurnsLeft -= 1;
      if (this.bombTurnsLeft <= 0) {
        this.bombedPegId = null;
        this.bombBannerSequence += 1;
        this.bombBannerType = 'defused';
        this.bombBannerMessage = '🛡️ Bomb has been defused automatically!';
      }
    }

    let nextIdx = (this.currentPlayerIndex + 1) % this.players.length;
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[nextIdx].isConnected) {
        break;
      }
      nextIdx = (nextIdx + 1) % this.players.length;
    }
    this.currentPlayerIndex = nextIdx;
    this.phase = 'waitingForRoll';
    this.turnTimeLeft = this.turnTimerSeconds;
    this.message = `${this.players[this.currentPlayerIndex].name}, roll the dice`;
  }

  _checkWinConditions() {
    const activePlayerCount = this.players.length;
    const earlyWinner = this.players.find(player => {
      const colorCounts = {};
      player.collection.forEach(color => {
        colorCounts[color] = (colorCounts[color] || 0) + 1;
      });
      const completedSets = Object.values(colorCounts).filter(count => count >= 3).length;
      return completedSets >= activePlayerCount;
    });

    if (earlyWinner) {
      this.phase = 'finished';
      this.result = this._calculateResult(earlyWinner, 'colorSets');
      this.message = `${earlyWinner.name} completed ${activePlayerCount} color sets!`;
      return true;
    }

    if (!this.pegs.some(p => !p.isCollected)) {
      this.phase = 'finished';
      this.result = this._calculateResult(null, 'boardCleared');
      this.message = 'Game complete';
      return true;
    }

    return false;
  }

  _calculateResult(winner, method) {
    const sorted = [...this.players].sort((a, b) => {
      if (winner) {
        if (a.id === winner.id) return -1;
        if (b.id === winner.id) return 1;
      }
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.collection.length - a.collection.length;
    });

    let winners = [];
    let reason = 'mostPoints';

    if (winner) {
      winners = [winner];
      reason = 'colorSets';
    } else {
      const topScore = sorted[0].score;
      const topPegs = sorted[0].collection.length;
      winners = sorted.filter(p => p.score === topScore && p.collection.length === topPegs);

      if (sorted.length > 1 && sorted[1].score === topScore) {
        reason = 'mostPegs';
      }
    }

    return {
      winners: winners.map(w => ({
        id: w.id,
        name: w.name,
        type: w.type,
        score: w.score,
        collection: w.collection,
        avatarEmoji: w.avatarEmoji,
        colorValue: w.colorValue,
        level: w.level
      })),
      players: sorted.map(p => ({
        id: p.id,
        name: p.name,
        type: p.type,
        score: p.score,
        collection: p.collection,
        avatarEmoji: p.avatarEmoji,
        colorValue: p.colorValue,
        level: p.level
      })),
      reason: reason
    };
  }

  getSnapshot() {
    return {
      players: this.players,
      pegs: this.pegs,
      currentPlayerIndex: this.currentPlayerIndex,
      phase: this.phase,
      diceColor: this.diceColor,
      rolledColor: this.rolledColor,
      lastDiceColor: this.lastDiceColor,
      lastPickedPegId: this.lastPickedPegId,
      magicHandArmed: this.magicHandArmed,
      shieldArmed: this.shieldArmed,
      secondChanceArmed: this.secondChanceArmed,
      comboCount: this.comboCount,
      lastComboSequence: this.lastComboSequence,
      powerUpUsedSequence: this.powerUpUsedSequence,
      powerUpUsedPlayerIndex: this.powerUpUsedPlayerIndex,
      powerUpUsedType: this.powerUpUsedType,
      powerUpAwardSequence: this.powerUpAwardSequence,
      powerUpAwardedPlayerIndex: this.powerUpAwardedPlayerIndex,
      powerUpAwardedType: this.powerUpAwardedType,
      powerUpAwardedTypes: this.powerUpAwardedTypes,
      magicHandAwardSequence: this.magicHandAwardSequence,
      magicHandAwardedPlayerIndex: this.magicHandAwardedPlayerIndex,
      jackpotSequence: this.jackpotSequence,
      jackpotPlayerIndex: this.jackpotPlayerIndex,
      bombedPegId: this.bombedPegId,
      bombPlacedByPlayerName: this.bombPlacedByPlayerName,
      bombTurnsLeft: this.bombTurnsLeft,
      bombBannerSequence: this.bombBannerSequence,
      bombBannerMessage: this.bombBannerMessage,
      bombBannerType: this.bombBannerType,
      result: this.result,
      message: this.message,
      turnTimeLeft: this.turnTimeLeft,
      maxTurnTime: this.turnTimerSeconds,
      timerEnabled: this.timerEnabled
    };
  }
}

module.exports = ServerGame;
