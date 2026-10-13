import express from 'express';
import { createServer as createHttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
const app = express();
const server = createHttpServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingInterval: 10000,
  pingTimeout: 5000,
});
interface RoomPlayer {
  id: string;
  name: string;
  character: 'arthur' | 'lucas';
  ready: boolean;
  score: number;
  slot: 1 | 2;
}
interface RoomState {
  code: string;
  hostId: string;
  players: Record<string, RoomPlayer>;
  gameState: 'lobby' | 'char_select' | 'playing' | 'round_over' | 'game_over';
  round: number;
  maxRounds: number;
  mapIndex: number;
  roundWinnerSlot?: 1 | 2 | null;
}
const rooms = new Map<string, RoomState>();
function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}
io.on('connection', (socket: Socket) => {
  let currentRoomCode: string | null = null;
  socket.on('create_room', ({ playerName, character }: { playerName: string; character: 'arthur' | 'lucas' }, callback) => {
    const code = generateRoomCode();
    socket.join(code);
    currentRoomCode = code;
    const room: RoomState = {
      code,
      hostId: socket.id,
      players: {
        [socket.id]: {
          id: socket.id,
          name: playerName?.trim() || 'Jogador 1',
          character: character || 'arthur',
          ready: true,
          score: 0,
          slot: 1,
        },
      },
      gameState: 'lobby',
      round: 1,
      maxRounds: 3,
      mapIndex: 0,
    };
    rooms.set(code, room);
    if (typeof callback === 'function') {
      callback({ success: true, room });
    }
    socket.emit('room_updated', room);
  });
  socket.on('join_room', ({ code, playerName, character }: { code: string; playerName: string; character: 'arthur' | 'lucas' }, callback) => {
    const cleanCode = (code || '').trim().toUpperCase();
    const room = rooms.get(cleanCode);
    if (!room) {
      if (typeof callback === 'function') callback({ success: false, error: 'Sala não encontrada!' });
      return;
    }
    const playerKeys = Object.keys(room.players);
    if (playerKeys.length >= 2 && !room.players[socket.id]) {
      if (typeof callback === 'function') callback({ success: false, error: 'A sala já está cheia (máx 2 jogadores)!' });
      return;
    }
    socket.join(cleanCode);
    currentRoomCode = cleanCode;
    if (!room.players[socket.id]) {
      const existingSlot = playerKeys.length > 0 ? room.players[playerKeys[0]].slot : 2;
      const slot: 1 | 2 = existingSlot === 1 ? 2 : 1;
      room.players[socket.id] = {
        id: socket.id,
        name: playerName?.trim() || `Jogador ${slot}`,
        character: character || (slot === 1 ? 'arthur' : 'lucas'),
        ready: true,
        score: 0,
        slot,
      };
    }
    if (typeof callback === 'function') {
      callback({ success: true, room });
    }
    io.to(cleanCode).emit('room_updated', room);
  });
  socket.on('select_character', ({ character }: { character: 'arthur' | 'lucas' }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].character = character;
    room.players[socket.id].ready = true;
    io.to(currentRoomCode).emit('room_updated', room);
    const playersList = Object.values(room.players);
    if (room.gameState === 'char_select' && playersList.length === 2 && playersList.every(p => p.ready)) {
      room.gameState = 'playing';
      room.mapIndex = (room.round - 1) % 4;
      io.to(currentRoomCode).emit('round_start', {
        round: room.round,
        mapIndex: room.mapIndex,
        players: room.players,
      });
      io.to(currentRoomCode).emit('room_updated', room);
    }
  });
  socket.on('start_match', ({ mapIndex, maxRounds }: { mapIndex?: number; maxRounds?: number }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id) return;
    if (mapIndex !== undefined) room.mapIndex = mapIndex;
    if (maxRounds !== undefined) room.maxRounds = maxRounds;
    room.round = 1;
    for (const pid of Object.keys(room.players)) {
      room.players[pid].score = 0;
      room.players[pid].ready = false;
    }
    room.gameState = 'char_select';
    io.to(currentRoomCode).emit('room_updated', room);
    io.to(currentRoomCode).emit('start_char_selection', { round: 1 });
  });
  socket.on('player_input', (payload) => {
    if (!currentRoomCode) return;
    socket.to(currentRoomCode).emit('remote_input', {
      senderId: socket.id,
      ...payload,
    });
  });
  socket.on('player_action', (action) => {
    if (!currentRoomCode) return;
    socket.to(currentRoomCode).emit('remote_action', {
      senderId: socket.id,
      ...action,
    });
  });
  socket.on('fighter_snapshot', (snap) => {
    if (!currentRoomCode) return;
    socket.to(currentRoomCode).emit('remote_fighter_snapshot', snap);
  });
  socket.on('sync_game_state', (state) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id) return;
    socket.to(currentRoomCode).emit('remote_game_state', state);
  });
  socket.on('round_finished', ({ winnerSlot }: { winnerSlot: 1 | 2 }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== socket.id) return;
    room.roundWinnerSlot = winnerSlot;
    for (const pid of Object.keys(room.players)) {
      if (room.players[pid].slot === winnerSlot) {
        room.players[pid].score += 1;
      }
      room.players[pid].ready = false;
    }
    const hasWonMatch = Object.values(room.players).some(p => p.score >= room.maxRounds);
    if (hasWonMatch) {
      room.gameState = 'game_over';
      io.to(currentRoomCode).emit('match_over', {
        winnerSlot,
        room,
      });
    } else {
      room.gameState = 'round_over';
      io.to(currentRoomCode).emit('round_end', {
        winnerSlot,
        room,
      });
      setTimeout(() => {
        if (!rooms.has(currentRoomCode!)) return;
        room.round += 1;
        room.gameState = 'char_select';
        io.to(currentRoomCode!).emit('start_char_selection', { round: room.round });
        io.to(currentRoomCode!).emit('room_updated', room);
      }, 3000);
    }
  });
  socket.on('request_rematch', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.round = 1;
    for (const pid of Object.keys(room.players)) {
      room.players[pid].score = 0;
      room.players[pid].ready = false;
    }
    room.gameState = 'char_select';
    io.to(currentRoomCode).emit('start_char_selection', { round: 1 });
    io.to(currentRoomCode).emit('room_updated', room);
  });
  socket.on('disconnect', () => {
    if (currentRoomCode) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        delete room.players[socket.id];
        const remaining = Object.keys(room.players);
        if (remaining.length === 0) {
          rooms.delete(currentRoomCode);
        } else {
          if (room.hostId === socket.id) {
            room.hostId = remaining[0];
          }
          io.to(currentRoomCode).emit('player_left', { playerId: socket.id });
          io.to(currentRoomCode).emit('room_updated', room);
        }
      }
    }
  });
});
app.get('/health', (_req, res) => {
res.json({ ok: true });
});
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
console.log(`tortura-server running on port ${PORT}`);
});
