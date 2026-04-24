const crypto = require("crypto");
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();
const ROOM_CODE_LENGTH = 6;
const MIN_TOTAL_PLAYERS = 2;
const MAX_TOTAL_PLAYERS = 6;
const THEMES = new Set(["", "light", "neon"]);
const BOT_THINK_TIME_MS = 650;

app.use(express.static(__dirname));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePlayerName(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);

  return cleaned || "Player";
}

function normalizeRoomCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(String(password || ""))
    .digest("hex");
}

function normalizeSettings(settings = {}) {
  const size = clamp(Number(settings.size) || 4, 3, 10);
  const theme = THEMES.has(settings.theme) ? settings.theme : "";
  const totalPlayers = clamp(Number(settings.totalPlayers) || 2, MIN_TOTAL_PLAYERS, MAX_TOTAL_PLAYERS);
  const botCount = clamp(Number(settings.botCount) || 0, 0, totalPlayers - 1);

  return { size, theme, totalPlayers, botCount };
}

function getRequiredHumanCount(settings) {
  return Math.max(1, settings.totalPlayers - settings.botCount);
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => {
      const index = Math.floor(Math.random() * alphabet.length);
      return alphabet[index];
    }).join("");
  } while (rooms.has(code));

  return code;
}

function createBotPlayer(roomCode, number) {
  return {
    id: `BOT-${roomCode}-${number}`,
    name: `Bot ${number}`,
    isBot: true
  };
}

function isBotPlayer(player) {
  return Boolean(player?.isBot);
}

function getHumanPlayers(room) {
  return room.players.filter(player => !isBotPlayer(player));
}

function getBotPlayers(room) {
  return room.players.filter(isBotPlayer);
}

function syncRoomBots(room) {
  const humans = getHumanPlayers(room);
  const maxBotsAllowed = Math.max(0, room.settings.totalPlayers - humans.length);
  room.settings.botCount = Math.min(room.settings.botCount, maxBotsAllowed);
  room.players = humans.concat(
    Array.from({ length: room.settings.botCount }, (_unused, index) => createBotPlayer(room.code, index + 1))
  );
}

function boxKey(row, col) {
  return `${row}-${col}`;
}

function edgeKeyFromCoords(r1, c1, r2, c2) {
  if (r1 > r2 || (r1 === r2 && c1 > c2)) {
    [r1, c1, r2, c2] = [r2, c2, r1, c1];
  }

  return `${r1},${c1}|${r2},${c2}`;
}

function parseEdgeKey(key) {
  const parts = String(key || "").split("|");
  if (parts.length !== 2) return null;

  const start = parts[0].split(",").map(Number);
  const end = parts[1].split(",").map(Number);
  if (start.length !== 2 || end.length !== 2) return null;

  const [r1, c1] = start;
  const [r2, c2] = end;

  if ([r1, c1, r2, c2].some(Number.isNaN)) {
    return null;
  }

  return { r1, c1, r2, c2 };
}

function normalizeEdgeKey(key) {
  const parsed = parseEdgeKey(key);
  if (!parsed) return "";

  return edgeKeyFromCoords(parsed.r1, parsed.c1, parsed.r2, parsed.c2);
}

function isValidEdge(size, key) {
  const edge = parseEdgeKey(key);
  if (!edge) return false;

  const { r1, c1, r2, c2 } = edge;
  const inBounds = [r1, c1, r2, c2].every(value => value >= 0 && value < size);
  if (!inBounds) return false;

  const sameRow = r1 === r2 && Math.abs(c1 - c2) === 1;
  const sameCol = c1 === c2 && Math.abs(r1 - r2) === 1;
  return sameRow || sameCol;
}

function boxEdges(row, col) {
  return [
    edgeKeyFromCoords(row, col, row, col + 1),
    edgeKeyFromCoords(row, col, row + 1, col),
    edgeKeyFromCoords(row, col + 1, row + 1, col + 1),
    edgeKeyFromCoords(row + 1, col, row + 1, col + 1)
  ];
}

function getAdjacentBoxes(size, key) {
  const edge = parseEdgeKey(key);
  if (!edge) return [];

  const { r1, c1, r2, c2 } = edge;
  const adjacent = [];

  if (r1 === r2) {
    const row = r1;
    const col = Math.min(c1, c2);
    if (row > 0) adjacent.push({ row: row - 1, col });
    if (row < size - 1) adjacent.push({ row, col });
  } else {
    const row = Math.min(r1, r2);
    const col = c1;
    if (col > 0) adjacent.push({ row, col: col - 1 });
    if (col < size - 1) adjacent.push({ row, col });
  }

  return adjacent;
}

function serializeRoom(room, notice = "") {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    started: room.started,
    players: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      index,
      isBot: Boolean(player.isBot)
    })),
    settings: { ...room.settings },
    notice
  };
}

function serializeGameState(room) {
  if (!room.gameState) return null;

  return {
    roomCode: room.code,
    size: room.gameState.size,
    theme: room.gameState.theme,
    players: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      index,
      isBot: Boolean(player.isBot)
    })),
    scores: room.gameState.scores.slice(),
    currentPlayer: room.gameState.currentPlayer,
    lines: room.gameState.lines.map(line => ({ ...line })),
    boxes: room.gameState.boxes.map(box => ({ ...box })),
    lastMove: room.gameState.lastMove ? { ...room.gameState.lastMove } : null,
    finished: room.gameState.finished
  };
}

function broadcastRoomState(room, notice = "") {
  io.to(room.code).emit("room-state", serializeRoom(room, notice));
}

function broadcastGameState(room) {
  const snapshot = serializeGameState(room);
  if (snapshot) {
    io.to(room.code).emit("game-state", snapshot);
  }
}

function getRoomForSocket(socket) {
  if (!socket.data.roomCode) return null;
  return rooms.get(socket.data.roomCode) || null;
}

function createInitialGameState(room) {
  return {
    size: room.settings.size,
    theme: room.settings.theme,
    scores: new Array(room.players.length).fill(0),
    currentPlayer: 0,
    lines: [],
    boxes: [],
    lastMove: null,
    finished: false
  };
}

function applyMove(room, playerId, rawMoveKey) {
  if (!room.gameState) {
    return { ok: false, error: "The match has not started yet." };
  }

  const moveKey = normalizeEdgeKey(rawMoveKey);
  if (!moveKey || !isValidEdge(room.gameState.size, moveKey)) {
    return { ok: false, error: "That move is not valid on this board." };
  }

  const playerIndex = room.players.findIndex(player => player.id === playerId);
  if (playerIndex === -1) {
    return { ok: false, error: "You are not part of this room." };
  }

  if (playerIndex !== room.gameState.currentPlayer) {
    return { ok: false, error: "It is not your turn yet." };
  }

  const existingLines = new Set(room.gameState.lines.map(line => line.key));
  if (existingLines.has(moveKey)) {
    return { ok: false, error: "That line is already taken." };
  }

  existingLines.add(moveKey);
  room.gameState.lines.push({
    key: moveKey,
    ownerIndex: playerIndex
  });

  const claimedBoxes = [];
  for (const adjacent of getAdjacentBoxes(room.gameState.size, moveKey)) {
    const currentBoxKey = boxKey(adjacent.row, adjacent.col);
    const alreadyClaimed = room.gameState.boxes.some(box => box.key === currentBoxKey);
    if (alreadyClaimed) continue;

    const completed = boxEdges(adjacent.row, adjacent.col)
      .every(edge => existingLines.has(edge));

    if (completed) {
      room.gameState.boxes.push({
        key: currentBoxKey,
        ownerIndex: playerIndex
      });
      room.gameState.scores[playerIndex] += 1;
      claimedBoxes.push(currentBoxKey);
    }
  }

  if (!claimedBoxes.length) {
    room.gameState.currentPlayer = (room.gameState.currentPlayer + 1) % room.players.length;
  }

  room.gameState.lastMove = {
    key: moveKey,
    ownerIndex: playerIndex,
    claimedBoxes
  };

  const totalBoxes = (room.gameState.size - 1) * (room.gameState.size - 1);
  if (room.gameState.boxes.length === totalBoxes) {
    room.gameState.finished = true;
    room.started = false;
  }

  return { ok: true };
}

function listAllMoves(size) {
  const moves = [];

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size - 1; col++) {
      moves.push(edgeKeyFromCoords(row, col, row, col + 1));
    }
  }

  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size; col++) {
      moves.push(edgeKeyFromCoords(row, col, row + 1, col));
    }
  }

  return moves;
}

function countBoxSides(size, lineSet, row, col) {
  return boxEdges(row, col).reduce((count, edge) => count + (lineSet.has(edge) ? 1 : 0), 0);
}

function inspectMove(size, lineSet, moveKey) {
  let completedBoxes = 0;
  let createdThirdEdges = 0;
  let createdSecondEdges = 0;

  for (const adjacent of getAdjacentBoxes(size, moveKey)) {
    const sides = countBoxSides(size, lineSet, adjacent.row, adjacent.col) + 1;
    if (sides === 4) completedBoxes++;
    else if (sides === 3) createdThirdEdges++;
    else if (sides === 2) createdSecondEdges++;
  }

  return {
    completedBoxes,
    createdThirdEdges,
    createdSecondEdges,
    isBoundary: getAdjacentBoxes(size, moveKey).length === 1
  };
}

function chooseBotMove(room) {
  if (!room.gameState) return "";

  const size = room.gameState.size;
  const lineSet = new Set(room.gameState.lines.map(line => line.key));
  const entries = listAllMoves(size)
    .filter(moveKey => !lineSet.has(moveKey))
    .map(moveKey => ({
      moveKey,
      stats: inspectMove(size, lineSet, moveKey)
    }));

  if (!entries.length) return "";

  const scoredMoves = entries.filter(entry => entry.stats.completedBoxes > 0);
  const safeMoves = entries.filter(entry => entry.stats.completedBoxes === 0 && entry.stats.createdThirdEdges === 0);
  const riskyMoves = entries.filter(entry => entry.stats.createdThirdEdges > 0);

  const orderByRisk = source => {
    return source.sort((left, right) => {
      if (right.stats.completedBoxes !== left.stats.completedBoxes) {
        return right.stats.completedBoxes - left.stats.completedBoxes;
      }
      if (left.stats.createdThirdEdges !== right.stats.createdThirdEdges) {
        return left.stats.createdThirdEdges - right.stats.createdThirdEdges;
      }
      if (left.stats.createdSecondEdges !== right.stats.createdSecondEdges) {
        return left.stats.createdSecondEdges - right.stats.createdSecondEdges;
      }
      if (left.stats.isBoundary !== right.stats.isBoundary) {
        return left.stats.isBoundary ? -1 : 1;
      }
      return 0;
    });
  };

  if (scoredMoves.length) {
    return orderByRisk(scoredMoves)[0].moveKey;
  }

  if (safeMoves.length) {
    return orderByRisk(safeMoves)[0].moveKey;
  }

  return orderByRisk(riskyMoves)[0].moveKey;
}

function clearBotTurnTimer(room) {
  if (room.botTurnTimer) {
    clearTimeout(room.botTurnTimer);
    room.botTurnTimer = null;
  }
}

function runBotTurn(room) {
  clearBotTurnTimer(room);

  if (!room.started || !room.gameState || room.gameState.finished) {
    return;
  }

  const currentPlayer = room.players[room.gameState.currentPlayer];
  if (!isBotPlayer(currentPlayer)) {
    return;
  }

  const moveKey = chooseBotMove(room);
  if (!moveKey) {
    room.gameState.finished = true;
    room.started = false;
    broadcastGameState(room);
    broadcastRoomState(room, "Match finished. Host can start a rematch.");
    return;
  }

  const result = applyMove(room, currentPlayer.id, moveKey);
  if (!result.ok) {
    console.error("Bot move failed:", result.error);
    return;
  }

  broadcastGameState(room);

  if (room.gameState?.finished) {
    broadcastRoomState(room, "Match finished. Host can start a rematch.");
    return;
  }

  scheduleBotTurn(room);
}

function scheduleBotTurn(room) {
  clearBotTurnTimer(room);

  if (!room.started || !room.gameState || room.gameState.finished) {
    return;
  }

  const currentPlayer = room.players[room.gameState.currentPlayer];
  if (!isBotPlayer(currentPlayer)) {
    return;
  }

  room.botTurnTimer = setTimeout(() => {
    room.botTurnTimer = null;
    runBotTurn(room);
  }, BOT_THINK_TIME_MS);
}

function leaveRoom(socket, reason = "left the room") {
  const room = getRoomForSocket(socket);
  if (!room) {
    socket.data.roomCode = null;
    return;
  }

  clearBotTurnTimer(room);

  socket.leave(room.code);
  socket.data.roomCode = null;

  const index = room.players.findIndex(player => player.id === socket.id);
  if (index !== -1) {
    room.players.splice(index, 1);
  }

  const remainingHumans = getHumanPlayers(room);
  if (!remainingHumans.length) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = remainingHumans[0].id;
  }

  if (room.started) {
    room.started = false;
    room.gameState = null;
    broadcastRoomState(room, `A player ${reason}. Match stopped.`);
    return;
  }

  syncRoomBots(room);
  broadcastRoomState(room, `A player ${reason}.`);
}

io.on("connection", socket => {
  console.log("Player connected:", socket.id);

  socket.on("create-room", (payload = {}, ack = () => {}) => {
    const password = String(payload.password || "").trim();
    if (!password) {
      ack({ ok: false, error: "Room password is required." });
      return;
    }

    leaveRoom(socket);

    const code = createRoomCode();
    const room = {
      code,
      hostId: socket.id,
      passwordHash: hashPassword(password),
      players: [{
        id: socket.id,
        name: normalizePlayerName(payload.playerName),
        isBot: false
      }],
      settings: normalizeSettings(payload.settings),
      started: false,
      gameState: null,
      botTurnTimer: null
    };

    syncRoomBots(room);
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    
    const humanSeats = getRequiredHumanCount(room.settings);
    const humanNotice = humanSeats > 1
      ? `Share the room code and password with ${humanSeats - 1} friend${humanSeats - 1 === 1 ? "" : "s"}.`
      : "This room can start with just you because the rest are bots.";

    broadcastRoomState(room, `Room created. ${humanNotice}`);
    ack({ ok: true, roomCode: code });
  });

  socket.on("join-room", (payload = {}, ack = () => {}) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);
    if (!room) {
      ack({ ok: false, error: "Room not found." });
      return;
    }

    if (room.started) {
      ack({ ok: false, error: "That room is already in a match." });
      return;
    }

    const humanPlayers = getHumanPlayers(room);
    if (humanPlayers.length >= getRequiredHumanCount(room.settings)) {
      ack({ ok: false, error: "All human seats in that room are already filled." });
      return;
    }

    if (room.passwordHash !== hashPassword(payload.password)) {
      ack({ ok: false, error: "Wrong room password." });
      return;
    }

    leaveRoom(socket);

    const existingHumans = getHumanPlayers(room);
    room.players = existingHumans.concat(getBotPlayers(room));
    room.players.splice(existingHumans.length, 0, {
      id: socket.id,
      name: normalizePlayerName(payload.playerName),
      isBot: false
    });

    syncRoomBots(room);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    broadcastRoomState(room, "Friend joined the room.");
    ack({ ok: true, roomCode: room.code });
  });

  socket.on("update-room-settings", (payload = {}, ack = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) {
      ack({ ok: false, error: "Join a room first." });
      return;
    }

    if (room.hostId !== socket.id) {
      ack({ ok: false, error: "Only the host can change room settings." });
      return;
    }

    if (room.started) {
      ack({ ok: false, error: "You cannot change settings during a live match." });
      return;
    }

    const requested = normalizeSettings(payload);
    const humanPlayers = getHumanPlayers(room);
    const totalPlayers = Math.max(requested.totalPlayers, humanPlayers.length);
    const botCount = Math.min(requested.botCount, totalPlayers - humanPlayers.length);

    room.settings = {
      size: requested.size,
      theme: requested.theme,
      totalPlayers,
      botCount
    };

    syncRoomBots(room);
    broadcastRoomState(room, "Room settings updated.");
    ack({ ok: true });
  });

  socket.on("start-online-game", (ack = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) {
      ack({ ok: false, error: "Join a room first." });
      return;
    }

    if (room.hostId !== socket.id) {
      ack({ ok: false, error: "Only the host can start the match." });
      return;
    }

    const humanPlayers = getHumanPlayers(room);
    const requiredHumans = getRequiredHumanCount(room.settings);
    if (humanPlayers.length < requiredHumans) {
      ack({
        ok: false,
        error: `You need ${requiredHumans} human player${requiredHumans === 1 ? "" : "s"} before starting.`
      });
      return;
    }

    syncRoomBots(room);
    room.started = true;
    room.gameState = createInitialGameState(room);
    broadcastRoomState(room, "Match started.");
    broadcastGameState(room);
    scheduleBotTurn(room);
    ack({ ok: true });
  });

  socket.on("play-move", (payload = {}, ack = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) {
      ack({ ok: false, error: "Join a room first." });
      return;
    }

    const result = applyMove(room, socket.id, payload.moveKey);
    if (!result.ok) {
      io.to(socket.id).emit("action-error", { message: result.error });
      ack({ ok: false, error: result.error });
      return;
    }

    broadcastGameState(room);

    if (room.gameState?.finished) {
      broadcastRoomState(room, "Match finished. Host can start a rematch.");
      } else {
      scheduleBotTurn(room);
    }

    ack({ ok: true });
  });

  socket.on("leave-room", (ack = () => {}) => {
    leaveRoom(socket, "left the room");
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    leaveRoom(socket, "disconnected");
    console.log("Player disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
