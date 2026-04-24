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
const MAX_PLAYERS_PER_ROOM = 2;
const THEMES = new Set(["", "light", "neon"]);

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
  return { size, theme };
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
      index
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
      index
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

function leaveRoom(socket, reason = "left the room") {
  const room = getRoomForSocket(socket);
  if (!room) {
    socket.data.roomCode = null;
    return;
  }

  socket.leave(room.code);
  socket.data.roomCode = null;

  const index = room.players.findIndex(player => player.id === socket.id);
  if (index !== -1) {
    room.players.splice(index, 1);
  }

  if (!room.players.length) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
  }

  if (room.started) {
    room.started = false;
    room.gameState = null;
    broadcastRoomState(room, `A player ${reason}. Match stopped.`);
    return;
  }

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
        name: normalizePlayerName(payload.playerName)
      }],
      settings: normalizeSettings(payload.settings),
      started: false,
      gameState: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    broadcastRoomState(room, "Room created. Share the room code and password with your friend.");
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

    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
      ack({ ok: false, error: "That room is already full." });
      return;
    }

    if (room.passwordHash !== hashPassword(payload.password)) {
      ack({ ok: false, error: "Wrong room password." });
      return;
    }

    leaveRoom(socket);

    room.players.push({
      id: socket.id,
      name: normalizePlayerName(payload.playerName)
    });

    socket.join(room.code);
    socket.data.roomCode = room.code;
    broadcastRoomState(room, "Friend joined the room.");
    ack({ ok: true, roomCode: room.code });
  });

  socket.on("update-room-settings", payload => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.started) return;

    room.settings = normalizeSettings(payload);
    broadcastRoomState(room, "Room settings updated.");
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

    if (room.players.length !== MAX_PLAYERS_PER_ROOM) {
      ack({ ok: false, error: "You need 2 players before starting." });
      return;
    }

    room.started = true;
    room.gameState = createInitialGameState(room);
    broadcastRoomState(room, "Match started.");
    broadcastGameState(room);
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
