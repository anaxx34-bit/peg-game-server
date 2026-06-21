const { WebSocketServer } = require('ws');
const http = require('http');

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

        case 'create_room': {
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

        case 'return_to_lobby': {
          if (!currentRoomCode) return;
          const room = rooms.get(currentRoomCode);
          if (!room) return;

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
          console.log(`Room ${currentRoomCode} returned to lobby`);

          if (room.isPublic) broadcastPublicRooms();
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
            // Check if player is reconnecting
            const existingPlayer = room.players.find(p => p.id === message.playerId);
            if (existingPlayer) {
              currentPlayerId = message.playerId;
              currentRoomCode = roomCode;
              existingPlayer.isConnected = true;
              existingPlayer.ws = ws;

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
          room.pegs = message.pegs;
          room.gameState = null;
          room.settings = {
            continueTurnOnMatch: message.continueTurnOnMatch,
            timerEnabled: message.timerEnabled,
            turnTimerSeconds: message.turnTimerSeconds,
            boardStyle: message.boardStyle,
            boardFinish: message.boardFinish,
            pegFinish: message.pegFinish,
          };

          broadcastToRoom(currentRoomCode, {
            type: 'game_started',
            players: message.players,
            pegs: message.pegs,
            continueTurnOnMatch: message.continueTurnOnMatch,
            timerEnabled: message.timerEnabled,
            turnTimerSeconds: message.turnTimerSeconds,
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
          // Also fix currentRoomCode if it was lost
          if (!currentRoomCode && rc) currentRoomCode = rc;
          broadcastToRoom(rc, {
            type: 'game_action',
            action: message.action,
            senderId: currentPlayerId,
          });
          break;
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    allClients.delete(ws);

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
            // Not in-game: remove immediately from lobby
            room.players.splice(playerIndex, 1);
            console.log(`Player ${player.name} left lobby ${currentRoomCode}`);

            if (room.players.filter(p => p.type === 'human').length === 0) {
              rooms.delete(currentRoomCode);
              console.log(`Room ${currentRoomCode} deleted (empty lobby)`);
              if (room.isPublic) broadcastPublicRooms();
            } else {
              if (currentPlayerId === room.hostId) {
                const nextHuman = room.players.find(p => p.type === 'human');
                if (nextHuman) {
                  room.hostId = nextHuman.id;
                  nextHuman.isHost = true;
                  nextHuman.isReady = true;
                }
              }

              broadcastToRoom(currentRoomCode, {
                type: 'room_update',
                players: room.players.map(p => getClientInfo(p)),
                hostId: room.hostId,
                entryFee: room.entryFee || 100,
              });

              if (room.isPublic) broadcastPublicRooms();
            }
          }
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WS Error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket Server is listening on http://localhost:${PORT}`);
});
