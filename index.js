const { WebSocketServer } = require('ws');
const http = require('http');
const ServerGame = require('./game');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Peg Game Server is running!\n');
});

const wss = new WebSocketServer({ server });

// Map to store active rooms: roomCode -> roomData
const rooms = new Map();

// Set of all connected clients (for public room broadcasts)
const allClients = new Set();

// Map of active online players: playerId -> WebSocket object
const activePlayers = new Map();

// Grace period before deleting an empty in-game room (ms)
const ROOM_DELETE_GRACE_MS = 90000; // 90 seconds

// Helper to generate a unique room code (6 characters)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

// Helper to get client info
function getClientInfo(player) {
  return {
    id: player.id,
    name: player.name,
    type: player.type,
    isReady: player.isReady,
    isConnected: player.isConnected,
    isHost: player.isHost,
    avatarEmoji: player.avatarEmoji || '👤',
    colorValue: player.colorValue || 0xff2d8c83,
    level: player.level || 1,
  };
}

// Helper to broadcast to a room
function broadcastToRoom(roomCode, message) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const data = JSON.stringify(message);
  room.players.forEach(player => {
    if (player.ws && player.ws.readyState === 1) { // OPEN
      player.ws.send(data);
    }
  });
}

// Build public rooms list (open, not in-game, not full)
function getPublicRoomsList() {
  const list = [];
  rooms.forEach((room) => {
    if (!room.isPublic) return;
    if (room.inGame) return;
    if (room.players.filter(p => p.type === 'human').length >= 6) return;

    const host = room.players.find(p => p.id === room.hostId);
    list.push({
      roomCode: room.code,
      hostName: host ? host.name : 'Host',
      hostEmoji: host ? (host.avatarEmoji || '👤') : '👤',
      playerCount: room.players.length,
      maxPlayers: 6,
      entryFee: room.entryFee || 100,
    });
  });
  return list;
}

// Broadcast updated public rooms list to ALL connected clients
function broadcastPublicRooms() {
  const roomsList = getPublicRoomsList();
  const message = JSON.stringify({ type: 'public_rooms_update', rooms: roomsList });
  allClients.forEach(ws => {
    if (ws.readyState === 1) {
      ws.send(message);
    }
  });
}

// Schedule room deletion with a grace period (for in-game disconnects)
function scheduleRoomDelete(roomCode, room) {
  // Clear any existing timer
  if (room.deleteTimer) {
    clearTimeout(room.deleteTimer);
  }
  room.deleteTimer = setTimeout(() => {
    // Only delete if still no active humans
    const activeHumans = room.players.filter(p => p.type === 'human' && p.isConnected);
    if (activeHumans.length === 0) {
      rooms.delete(roomCode);
      console.log(`Room ${roomCode} deleted after grace period`);
      if (room.isPublic) broadcastPublicRooms();
    }
  }, ROOM_DELETE_GRACE_MS);
}

// Cleanly and immediately remove a player from all non-in-game lobby rooms
function removePlayerFromLobbies(playerId, ws) {
  rooms.forEach((room, roomCode) => {
    if (!room.inGame) {
      const pIndex = room.players.findIndex(p => (playerId && p.id === playerId) || (ws && p.ws === ws));
      if (pIndex !== -1) {
        const removed = room.players.splice(pIndex, 1)[0];
        console.log(`Player ${removed.name} (${removed.id}) removed immediately from lobby room ${roomCode}`);

        const activeHumans = room.players.filter(p => p.type === 'human' && p.isConnected);
        if (activeHumans.length === 0) {
          rooms.delete(roomCode);
          console.log(`Room ${roomCode} deleted immediately (no active human players in lobby)`);
          if (room.isPublic) broadcastPublicRooms();
        } else {
          // If the player who left was the host, migrate host to the next active human
          if (removed.id === room.hostId || removed.isHost) {
            const nextHost = activeHumans[0];
            room.hostId = nextHost.id;
            nextHost.isHost = true;
            nextHost.isReady = true;
            console.log(`Host migrated to ${nextHost.name} in lobby room ${roomCode}`);
          }
          broadcastToRoom(roomCode, {
            type: 'room_update',
            players: room.players.map(p => getClientInfo(p)),
            hostId: room.hostId,
            entryFee: room.entryFee || 100,
            notification: `${removed.name} left the room`,
          });
          if (room.isPublic) broadcastPublicRooms();
        }
      }
    }
  });
}

wss.on('connection', (ws) => {
  if (ws._socket) {
    ws._socket.setNoDelay(true);
  }
  let currentRoomCode = null;
  let currentPlayerId = null;

  // Track every connected client for public broadcast
  allClients.add(ws);

  // Send current public room list immediately on connect
  ws.send(JSON.stringify({ type: 'public_rooms_update', rooms: getPublicRoomsList() }));

  ws.on('message', (messageData) => {
    try {
      const message = JSON.parse(messageData);
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Resolve room code: prefer server-tracked value, fall back to message payload
      const resolvedRoomCode = currentRoomCode || (message.roomCode ? message.roomCode.toUpperCase() : null);
      console.log('Received:', message.type, 'from room:', resolvedRoomCode || 'null');

      switch (message.type) {

        // ── On-demand refresh of public rooms list ──
        case 'list_public_rooms': {
          ws.send(JSON.stringify({ type: 'public_rooms_update', rooms: getPublicRoomsList() }));
          break;
        }

        case 'register_player': {
          currentPlayerId = message.playerId;
          if (currentPlayerId) {
            ws.playerId = currentPlayerId;
            ws.playerName = message.playerName || 'Guest';
            ws.playerEmoji = message.avatarEmoji || '👤';
            ws.playerColor = message.colorValue || 0xff2d8c83;
            ws.playerLevel = message.level || 1;
            activePlayers.set(currentPlayerId, ws);
            console.log(`Registered player ${ws.playerName} (${currentPlayerId}) as online`);
          }
          break;
        }

        case 'get_online_friends': {
          const friendIds = message.friendIds || [];
          const onlineFriends = [];
          friendIds.forEach(fid => {
            const friendSocket = activePlayers.get(fid);
            if (friendSocket && friendSocket.readyState === 1) {
              onlineFriends.push({
                id: fid,
                name: friendSocket.playerName || 'Guest',
                avatarEmoji: friendSocket.playerEmoji || '👤',
                colorValue: friendSocket.playerColor || 0xff2d8c83,
                level: friendSocket.playerLevel || 1,
                status: friendSocket.currentRoomCode ? 'in_game' : 'online',
              });
            }
          });
          ws.send(JSON.stringify({
            type: 'online_friends_update',
            friends: onlineFriends,
          }));
          break;
        }

        case 'send_invite': {
          const targetPlayerId = message.targetPlayerId;
          const roomCode = message.roomCode;
          const senderName = message.senderName || 'A friend';
          const senderEmoji = message.senderEmoji || '🦊';

          console.log(`Sending invite from ${senderName} to ${targetPlayerId} for room ${roomCode}`);

          const targetSocket = activePlayers.get(targetPlayerId);
          if (targetSocket && targetSocket.readyState === 1) {
            targetSocket.send(JSON.stringify({
              type: 'invite_received',
              senderId: currentPlayerId,
              senderName: senderName,
              senderEmoji: senderEmoji,
              roomCode: roomCode,
            }));
            ws.send(JSON.stringify({
              type: 'invite_sent_status',
              success: true,
              targetPlayerId: targetPlayerId,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'invite_sent_status',
              success: false,
              message: 'Player is offline',
              targetPlayerId: targetPlayerId,
            }));
          }
          break;
        }

        case 'create_room': {
          // Clean up any old lobby room this player was in before creating a new one
          removePlayerFromLobbies(message.playerId, ws);

          const roomCode = generateRoomCode();
          currentPlayerId = message.playerId;
          currentRoomCode = roomCode;

          const newPlayer = {
            id: message.playerId,
            name: message.playerName || 'Host',
            type: 'human',
            isReady: true,
            isConnected: true,
            isHost: true,
            avatarEmoji: message.avatarEmoji || '🦊',
            colorValue: message.colorValue || 0xff2d8c83,
            level: message.level || 1,
            ws: ws,
          };

          const entryFee = parseInt(message.entryFee) || 100;
          const isPublic = message.isPublic === true;

          rooms.set(roomCode, {
            code: roomCode,
            players: [newPlayer],
            hostId: message.playerId,
            inGame: false,
            pegs: null,
            entryFee: entryFee,
            isPublic: isPublic,
            deleteTimer: null,
          });

          ws.send(JSON.stringify({
            type: 'room_created',
            roomCode: roomCode,
            players: [getClientInfo(newPlayer)],
            hostId: message.playerId,
            myPlayerId: message.playerId,
            entryFee: entryFee,
            isPublic: isPublic,
          }));

          console.log(`Room created: ${roomCode} by ${newPlayer.name} (${isPublic ? 'public' : 'private'})`);

          if (isPublic) broadcastPublicRooms();
          break;
        }

        case 'check_room': {
          const roomCode = (message.roomCode || '').toUpperCase();
          const room = rooms.get(roomCode);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            return;
          }
          const isReconnecting = room.players.some(p => p.id === message.playerId);
          if (room.inGame && !isReconnecting) {
            ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress' }));
            return;
          }
          if (room.players.length >= 6 && !isReconnecting) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
            return;
          }
          const host = room.players.find(p => p.id === room.hostId);
          ws.send(JSON.stringify({
            type: 'room_preview',
            roomCode: roomCode,
            hostName: host ? host.name : 'Host',
            entryFee: room.entryFee || 100,
            playerCount: room.players.length,
            isPublic: room.isPublic || false,
            isReconnecting: isReconnecting,
          }));
          break;
        }

        case 'update_entry_fee': {
          if (!currentRoomCode) return;
          const room = rooms.get(currentRoomCode);
          if (!room || room.inGame) return;
          if (room.hostId !== currentPlayerId) return;

          const fee = parseInt(message.entryFee);
          if (!isNaN(fee) && fee >= 100 && fee <= 1000) {
            room.entryFee = fee;
            broadcastToRoom(currentRoomCode, {
              type: 'room_update',
              players: room.players.map(p => getClientInfo(p)),
              hostId: room.hostId,
              entryFee: room.entryFee,
            });
            console.log(`Room ${currentRoomCode} entry fee updated to ${fee}`);
            if (room.isPublic) broadcastPublicRooms();
          }
          break;
        }

        case 'player_waiting_in_lobby': {
          // A player navigated to lobby/room from result screen — notify others still waiting
          if (!currentRoomCode) return;
          const room = rooms.get(currentRoomCode);
          if (!room) return;
          const sender = room.players.find(p => p.id === currentPlayerId);
          if (!sender) return;

          // Broadcast to all OTHER players in the room
          const notifyData = JSON.stringify({
            type: 'player_waiting_lobby',
            playerName: sender.name,
            playerEmoji: sender.avatarEmoji || '👤',
          });
          room.players.forEach(player => {
            if (player.id !== currentPlayerId && player.ws && player.ws.readyState === 1) {
              player.ws.send(notifyData);
            }
          });
          console.log(`${sender.name} is waiting in lobby for room ${currentRoomCode}`);
          break;
        }

        case 'return_to_lobby': {
          if (!currentRoomCode) return;
          const room = rooms.get(currentRoomCode);
          if (!room) return;

          // Only perform room state reset if we are actually transitioning from active play to lobby
          if (room.inGame) {
            room.inGame = false;
            room.pegs = null;
            room.gameState = null;
            room.players.forEach(p => {
              p.isReady = (p.id === room.hostId);
            });

            broadcastToRoom(currentRoomCode, {
              type: 'returned_to_lobby',
              players: room.players.map(p => getClientInfo(p)),
              hostId: room.hostId,
              entryFee: room.entryFee || 100,
            });
            console.log(`Room ${currentRoomCode} returned to lobby (state reset)`);

            if (room.isPublic) broadcastPublicRooms();
          } else {
            // Already in lobby (e.g. host returned first), just send current lobby info back to this client
            ws.send(JSON.stringify({
              type: 'returned_to_lobby',
              players: room.players.map(p => getClientInfo(p)),
              hostId: room.hostId,
              entryFee: room.entryFee || 100,
            }));
            console.log(`Room ${currentRoomCode} already in lobby, synced client`);
          }
          break;
        }

        case 'join_room': {
          const roomCode = (message.roomCode || '').toUpperCase();
          const room = rooms.get(roomCode);

          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            return;
          }

          if (room.inGame) {
            // Check if game is actually finished on server
            const isGameFinished = room.gameInstance && (room.gameInstance.isGameOver || room.gameInstance.isFinished || room.gameInstance.winnerId);
            if (isGameFinished) {
              room.inGame = false;
              room.pegs = null;
              room.gameState = null;
              console.log(`Room ${roomCode} auto-reset from finished game to lobby for joining player`);
            } else {
              // Check if player is reconnecting
              const existingPlayer = room.players.find(p => p.id === message.playerId);
              if (existingPlayer) {
                currentPlayerId = message.playerId;
                currentRoomCode = roomCode;
                existingPlayer.isConnected = true;
                existingPlayer.ws = ws;

                if (room.gameInstance) {
                  const gamePlayer = room.gameInstance.players.find(p => p.id === message.playerId);
                  if (gamePlayer) {
                    gamePlayer.isConnected = true;
                  }
                  // Sync host just in case
                  room.gameInstance.players.forEach(p => {
                    p.isHost = (p.id === room.hostId);
                  });
                  room.gameState = room.gameInstance.getSnapshot();
                }

                // Cancel any pending room deletion
                if (room.deleteTimer) {
                  clearTimeout(room.deleteTimer);
                  room.deleteTimer = null;
                  console.log(`Room ${roomCode} deletion cancelled - player reconnected`);
                }

                console.log(`Player ${existingPlayer.name} reconnected to ${roomCode}`);

                // Send full state for reconnection
                ws.send(JSON.stringify({
                  type: 'reconnected',
                  roomCode: roomCode,
                  players: room.players.map(p => getClientInfo(p)),
                  hostId: room.hostId,
                  inGame: true,
                  pegs: room.pegs,
                  entryFee: room.entryFee || 100,
                  continueTurnOnMatch: room.settings ? room.settings.continueTurnOnMatch : true,
                  timerEnabled: room.settings ? room.settings.timerEnabled : true,
                  turnTimerSeconds: room.settings ? room.settings.turnTimerSeconds : 15,
                  boardStyle: room.settings ? room.settings.boardStyle : 'flat2D3DDisc',
                  boardFinish: room.settings ? room.settings.boardFinish : 'golden',
                  pegFinish: room.settings ? room.settings.pegFinish : 'lightCream',
                  gameState: room.gameState,
                }));

                // Notify others of reconnection
                broadcastToRoom(roomCode, {
                  type: 'player_reconnected',
                  playerId: message.playerId,
                  players: room.players.map(p => getClientInfo(p)),
                });
                return;
              }

              ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress' }));
              return;
            }
          }

          if (room.players.length >= 6) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
            return;
          }

          // Check if this player already exists in the room (rejoining lobby)
          const existingLobbyPlayer = room.players.find(p => p.id === message.playerId);
          if (existingLobbyPlayer) {
            currentPlayerId = message.playerId;
            currentRoomCode = roomCode;
            existingLobbyPlayer.isConnected = true;
            existingLobbyPlayer.ws = ws;

            if (existingLobbyPlayer.disconnectTimer) {
              clearTimeout(existingLobbyPlayer.disconnectTimer);
              existingLobbyPlayer.disconnectTimer = null;
            }

            ws.send(JSON.stringify({
              type: 'room_joined',
              roomCode: roomCode,
              players: room.players.map(p => getClientInfo(p)),
              hostId: room.hostId,
              myPlayerId: message.playerId,
              entryFee: room.entryFee || 100,
            }));
            broadcastToRoom(roomCode, {
              type: 'room_update',
              players: room.players.map(p => getClientInfo(p)),
              hostId: room.hostId,
              entryFee: room.entryFee || 100,
            });
            return;
          }

          // Clean up any other lobby rooms this player might have been in
          rooms.forEach((r, code) => {
            if (code !== roomCode && !r.inGame) {
              const pIdx = r.players.findIndex(p => p.id === message.playerId || p.ws === ws);
              if (pIdx !== -1) {
                const rem = r.players.splice(pIdx, 1)[0];
                const activeH = r.players.filter(p => p.type === 'human' && p.isConnected);
                if (activeH.length === 0) {
                  rooms.delete(code);
                  if (r.isPublic) broadcastPublicRooms();
                } else {
                  if (rem.id === r.hostId || rem.isHost) {
                    r.hostId = activeH[0].id;
                    activeH[0].isHost = true;
                    activeH[0].isReady = true;
                  }
                  broadcastToRoom(code, {
                    type: 'room_update',
                    players: r.players.map(p => getClientInfo(p)),
                    hostId: r.hostId,
                    entryFee: r.entryFee || 100,
                  });
                  if (r.isPublic) broadcastPublicRooms();
                }
              }
            }
          });

          currentPlayerId = message.playerId;
          currentRoomCode = roomCode;

          const newPlayer = {
            id: message.playerId,
            name: message.playerName || `Player ${room.players.length + 1}`,
            type: 'human',
            isReady: false,
            isConnected: true,
            isHost: false,
            avatarEmoji: message.avatarEmoji || '👤',
            colorValue: message.colorValue || 0xff2d8c83,
            level: message.level || 1,
            ws: ws,
          };

          room.players.push(newPlayer);

          ws.send(JSON.stringify({
            type: 'room_joined',
            roomCode: roomCode,
            players: room.players.map(p => getClientInfo(p)),
            hostId: room.hostId,
            myPlayerId: message.playerId,
            entryFee: room.entryFee || 100,
          }));

          broadcastToRoom(roomCode, {
            type: 'room_update',
            players: room.players.map(p => getClientInfo(p)),
            hostId: room.hostId,
            entryFee: room.entryFee || 100,
          });

          console.log(`Player ${newPlayer.name} joined room ${roomCode}`);

          if (room.isPublic) broadcastPublicRooms();
          break;
        }

        case 'ready_status': {
          if (!currentRoomCode) return;
          const room = rooms.get(currentRoomCode);
          if (!room || room.inGame) return;

          const player = room.players.find(p => p.id === currentPlayerId);
          if (player) {
            player.isReady = message.isReady;
            broadcastToRoom(currentRoomCode, {
              type: 'room_update',
              players: room.players.map(p => getClientInfo(p)),
              hostId: room.hostId,
              entryFee: room.entryFee || 100,
            });
          }
          break;
        }

        case 'add_bot': {
          if (!currentRoomCode) return;
          const room = rooms.get(currentRoomCode);
          if (!room || room.inGame) return;
          if (room.hostId !== currentPlayerId) return;
          if (room.players.length >= 6) return;

          const botId = `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          const botEmojis = ['🤖', '👽', '👾', '🦁', '🐻', '🐼', '🐨', '🐯'];
          const botColors = [0xff6b4cc4, 0xff00858f, 0xffb24788, 0xff59689f, 0xff8c5b9f, 0xff39757f];
          const botCount = room.players.filter(p => p.type === 'bot').length;
          const botPlayer = {
            id: botId,
            name: message.botName || `Bot ${botCount + 1}`,
            type: 'bot',
            isReady: true,
            isConnected: true,
            isHost: false,
            avatarEmoji: botEmojis[botCount % botEmojis.length],
            colorValue: botColors[botCount % botColors.length],
            level: Math.floor(Math.random() * 25) + 5,
            ws: null,
          };

          room.players.push(botPlayer);

          broadcastToRoom(currentRoomCode, {
            type: 'room_update',
            players: room.players.map(p => getClientInfo(p)),
            hostId: room.hostId,
            entryFee: room.entryFee || 100,
          });

          if (room.isPublic) broadcastPublicRooms();
          break;
        }

        case 'remove_player': {
          if (!currentRoomCode) return;
          const room = rooms.get(currentRoomCode);
          if (!room || room.inGame) return;

          const targetPlayerId = message.targetPlayerId;
          const isKicking = currentPlayerId === room.hostId && targetPlayerId !== currentPlayerId;
          const isLeaving = targetPlayerId === currentPlayerId;

          if (isKicking || isLeaving) {
            const playerIndex = room.players.findIndex(p => p.id === targetPlayerId);
            if (playerIndex !== -1) {
              const removedPlayer = room.players[playerIndex];
              room.players.splice(playerIndex, 1);

              if (targetPlayerId === room.hostId && room.players.length > 0) {
                const nextHuman = room.players.find(p => p.type === 'human');
                if (nextHuman) {
                  room.hostId = nextHuman.id;
                  nextHuman.isHost = true;
                  nextHuman.isReady = true;
                } else {
                  rooms.delete(currentRoomCode);
                  if (room.isPublic) broadcastPublicRooms();
                  return;
                }
              }

              if (removedPlayer.ws && removedPlayer.ws.readyState === 1) {
                removedPlayer.ws.send(JSON.stringify({ type: 'kicked' }));
              }

              if (room.players.filter(p => p.type === 'human').length === 0) {
                rooms.delete(currentRoomCode);
                console.log(`Room ${currentRoomCode} deleted (empty)`);
              } else {
                broadcastToRoom(currentRoomCode, {
                  type: 'room_update',
                  players: room.players.map(p => getClientInfo(p)),
                  hostId: room.hostId,
                  entryFee: room.entryFee || 100,
                });
              }

              if (room.isPublic) broadcastPublicRooms();
            }
          }
          break;
        }

        case 'start_game': {
          if (!currentRoomCode) return;
          const room = rooms.get(currentRoomCode);
          if (!room || room.inGame) return;
          if (room.hostId !== currentPlayerId) return;

          room.inGame = true;
          room.settings = {
            continueTurnOnMatch: message.continueTurnOnMatch,
            timerEnabled: message.timerEnabled,
            turnTimerSeconds: message.turnTimerSeconds,
            boardStyle: message.boardStyle,
            boardFinish: message.boardFinish,
            pegFinish: message.pegFinish,
          };

          const game = new ServerGame(currentRoomCode, message.players, message.pegs, room.settings);
          room.gameInstance = game;
          room.gameState = game.getSnapshot();
          room.pegs = game.pegs;

          broadcastToRoom(currentRoomCode, {
            type: 'game_started',
            players: game.players,
            pegs: game.pegs,
            continueTurnOnMatch: game.continueTurnOnMatch,
            timerEnabled: game.timerEnabled,
            turnTimerSeconds: game.turnTimerSeconds,
            boardStyle: message.boardStyle,
            boardFinish: message.boardFinish,
            pegFinish: message.pegFinish,
            entryFee: room.entryFee || 100,
          });

          console.log(`Game started in room ${currentRoomCode}`);

          if (room.isPublic) broadcastPublicRooms();
          break;
        }

        case 'sync_pegs': {
          // Accept roomCode from message as fallback
          const rc = currentRoomCode || (message.roomCode ? message.roomCode.toUpperCase() : null);
          if (!rc) return;
          const room = rooms.get(rc);
          if (!room || !room.inGame) return;
          room.pegs = message.pegs;
          // Also forward to other players in room for live sync
          const data = JSON.stringify({ type: 'sync_pegs', pegs: message.pegs, senderId: currentPlayerId });
          room.players.forEach(p => {
            if (p.id !== currentPlayerId && p.ws && p.ws.readyState === 1) {
              p.ws.send(data);
            }
          });
          break;
        }

        case 'sync_state': {
          const rc = currentRoomCode || (message.roomCode ? message.roomCode.toUpperCase() : null);
          if (!rc) return;
          const room = rooms.get(rc);
          if (!room || !room.inGame) return;
          room.gameState = message.gameState;
          // Forward to other players
          const data = JSON.stringify({ type: 'sync_state', gameState: message.gameState, senderId: currentPlayerId });
          room.players.forEach(p => {
            if (p.id !== currentPlayerId && p.ws && p.ws.readyState === 1) {
              p.ws.send(data);
            }
          });
          break;
        }

        case 'update_player_info': {
          if (!currentRoomCode || !currentPlayerId) return;
          const room = rooms.get(currentRoomCode);
          if (!room) return;

          const player = room.players.find(p => p.id === currentPlayerId);
          if (player) {
            player.name = message.playerName || player.name;
            player.avatarEmoji = message.avatarEmoji || player.avatarEmoji;
            player.colorValue = message.colorValue !== undefined ? message.colorValue : player.colorValue;
            player.level = message.level !== undefined ? message.level : player.level;

            broadcastToRoom(currentRoomCode, {
              type: 'player_info_updated',
              playerId: currentPlayerId,
              playerName: player.name,
              avatarEmoji: player.avatarEmoji,
              colorValue: player.colorValue,
              level: player.level,
              players: room.players.map(p => getClientInfo(p)),
            });

            console.log(`Player ${player.name} updated profile info in room ${currentRoomCode}`);
            if (room.isPublic) broadcastPublicRooms();
          }
          break;
        }

        case 'game_action': {
          const rc = currentRoomCode || (message.roomCode ? message.roomCode.toUpperCase() : null);
          if (!rc) return;
          if (!currentRoomCode && rc) currentRoomCode = rc;

          const room = rooms.get(rc);
          if (room && room.inGame && room.gameInstance) {
            const action = message.action;
            let result = null;

            if (action.type === 'roll_request') {
              result = room.gameInstance.handleRollRequest(currentPlayerId, action.color);
            } else if (action.type === 'pick_request') {
              result = room.gameInstance.handlePickRequest(currentPlayerId, action.pegId);
            } else if (action.type === 'swap_request') {
              result = room.gameInstance.handleSwapRequest(currentPlayerId, action.color);
            } else if (action.type === 'powerup_request') {
              result = room.gameInstance.handlePowerUpRequest(currentPlayerId, action.powerUpType);
            } else if (action.type === 'place_bomb_request') {
              result = room.gameInstance.handlePlaceBombRequest(currentPlayerId, action.pegId);
            } else if (action.type === 'timeout') {
              result = room.gameInstance.handleTimeout();
            } else if (action.type === 'emoji' || action.type === 'chat_quote') {
              broadcastToRoom(rc, {
                type: 'game_action',
                action: action,
                senderId: currentPlayerId,
              });
              return;
            }

            if (result) {
              room.gameState = room.gameInstance.getSnapshot();
              room.pegs = room.gameInstance.pegs;

              broadcastToRoom(rc, {
                type: 'game_action',
                action: result,
                senderId: currentPlayerId,
              });
              return;
            }
          }
          break;
        }
      }

      // Keep presence properties synchronized
      if (currentPlayerId) {
        ws.playerId = currentPlayerId;
        activePlayers.set(currentPlayerId, ws);
      }
      ws.currentRoomCode = currentRoomCode;

    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    allClients.delete(ws);
    if (ws.playerId) {
      activePlayers.delete(ws.playerId);
    }

    if (currentRoomCode && currentPlayerId) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        const playerIndex = room.players.findIndex(p => p.id === currentPlayerId);
        if (playerIndex !== -1) {
          const player = room.players[playerIndex];

          if (room.inGame) {
            // Mark as disconnected but KEEP in room for reconnection
            player.isConnected = false;
            player.ws = null;
            console.log(`Player ${player.name} disconnected (in-game) from room ${currentRoomCode}`);

            if (room.gameInstance) {
              const gamePlayer = room.gameInstance.players.find(p => p.id === currentPlayerId);
              if (gamePlayer) {
                gamePlayer.isConnected = false;
                gamePlayer.isHost = false;
              }
            }

            // Migrate host if needed
            if (currentPlayerId === room.hostId) {
              const nextHuman = room.players.find(p => p.type === 'human' && p.isConnected);
              if (nextHuman) {
                player.isHost = false;
                room.hostId = nextHuman.id;
                nextHuman.isHost = true;
                nextHuman.isReady = true;
                console.log(`Host migrated to ${nextHuman.name} in room ${currentRoomCode}`);
              }
            }

            if (room.gameInstance) {
              const nextHostPlayer = room.gameInstance.players.find(p => p.id === room.hostId);
              if (nextHostPlayer) {
                nextHostPlayer.isHost = true;
              }
            }

            // Notify remaining players
            broadcastToRoom(currentRoomCode, {
              type: 'player_disconnected',
              playerId: currentPlayerId,
              players: room.players.map(p => getClientInfo(p)),
              hostId: room.hostId,
            });

            // Schedule room cleanup after grace period (NOT immediate)
            const activeHumans = room.players.filter(p => p.type === 'human' && p.isConnected);
            if (activeHumans.length === 0) {
              console.log(`Room ${currentRoomCode}: all players offline — waiting ${ROOM_DELETE_GRACE_MS / 1000}s before delete`);
              scheduleRoomDelete(currentRoomCode, room);
            }
          } else {
            // Not in-game (Lobby / Waiting Room):
            // Remove disconnected player immediately, migrate host to next human or delete room if empty
            console.log(`Player ${player.name} disconnected from lobby room ${currentRoomCode}`);
            removePlayerFromLobbies(currentPlayerId, ws);
          }
        }
      }
    } else {
      // Fallback cleanup if currentRoomCode wasn't set on this socket
      removePlayerFromLobbies(currentPlayerId, ws);
    }
  });

  ws.on('error', (err) => {
    console.error('WS Error:', err);
  });
});

// Start a global interval timer to tick all active games
setInterval(() => {
  rooms.forEach((room, roomCode) => {
    if (room.inGame && room.gameInstance) {
      const result = room.gameInstance.tick();
      if (result) {
        room.gameState = room.gameInstance.getSnapshot();
        room.pegs = room.gameInstance.pegs;
        broadcastToRoom(roomCode, {
          type: 'game_action',
          action: result,
          senderId: room.gameInstance.players[room.gameInstance.currentPlayerIndex].id
        });
      }
    }
  });
}, 1000);

server.listen(PORT, () => {
  console.log(`WebSocket Server is listening on http://localhost:${PORT}`);
});
