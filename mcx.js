const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// mcx.js
// Simple authoritative multiplayer 2D shooter server + minimal client served from same file.
// Usage: npm install express socket.io
// Run: node mcx.js
// Open http://localhost:3000/ in multiple browser windows.


const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const TICK_RATE = 60; // updates per second
const BROADCAST_RATE = 20; // snapshots per second

// Game constants
const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;
const PLAYER_RADIUS = 16;
const PLAYER_SPEED = 220; // px / sec
const PLAYER_MAX_HEALTH = 100;
const RESPAWN_TIME = 2000; // ms

const BULLET_SPEED = 600;
const BULLET_RADIUS = 4;
const BULLET_LIFETIME = 2000; // ms
const SHOOT_COOLDOWN = 200; // ms per player

// In-memory game state
const players = {}; // socketId -> {id, x, y, vx, vy, angle, input, health, alive, lastShot}
const bullets = {}; // bulletId -> {id, x, y, vx, vy, ownerId, born}

let nextBulletId = 1;

// Serve minimal client
app.get('/', (_, res) => {
    res.type('html').send(CLIENT_HTML);
});

// Also expose client JS separately for clarity (optional)
app.get('/client.js', (_, res) => {
    res.type('application/javascript').send(CLIENT_JS);
});

// Static socket.io client is served automatically at /socket.io/socket.io.js

io.on('connection', (socket) => {
    const startX = Math.random() * (WORLD_WIDTH - 200) + 100;
    const startY = Math.random() * (WORLD_HEIGHT - 200) + 100;

    players[socket.id] = {
        id: socket.id,
        x: startX,
        y: startY,
        vx: 0,
        vy: 0,
        angle: 0,
        input: { up: false, down: false, left: false, right: false, mouseAngle: 0, shoot: false },
        health: PLAYER_MAX_HEALTH,
        alive: true,
        lastShot: 0,
        respawnAt: 0,
    };

    socket.emit('init', { id: socket.id, world: { width: WORLD_WIDTH, height: WORLD_HEIGHT } });

    socket.on('input', (input) => {
        const p = players[socket.id];
        if (!p) return;
        // basic validation
        p.input.up = !!input.up;
        p.input.down = !!input.down;
        p.input.left = !!input.left;
        p.input.right = !!input.right;
        if (typeof input.mouseAngle === 'number') p.input.mouseAngle = input.mouseAngle;
        if (input.shoot) {
            // attempt to shoot - server enforces cooldown
            const now = Date.now();
            if (now - p.lastShot >= SHOOT_COOLDOWN && p.alive) {
                p.lastShot = now;
                const angle = p.input.mouseAngle;
                const bx = p.x + Math.cos(angle) * (PLAYER_RADIUS + BULLET_RADIUS + 2);
                const by = p.y + Math.sin(angle) * (PLAYER_RADIUS + BULLET_RADIUS + 2);
                const vx = Math.cos(angle) * BULLET_SPEED;
                const vy = Math.sin(angle) * BULLET_SPEED;
                const id = String(nextBulletId++);
                bullets[id] = {
                    id,
                    x: bx,
                    y: by,
                    vx,
                    vy,
                    ownerId: socket.id,
                    born: now,
                };
            }
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

// Game loop
let lastTick = Date.now();
setInterval(() => {
    const now = Date.now();
    const dt = Math.min(100, now - lastTick) / 1000; // seconds
    lastTick = now;

    // Update players
    for (const id in players) {
        const p = players[id];
        if (!p.alive) {
            if (p.respawnAt && now >= p.respawnAt) {
                p.alive = true;
                p.health = PLAYER_MAX_HEALTH;
                p.x = Math.random() * (WORLD_WIDTH - 200) + 100;
                p.y = Math.random() * (WORLD_HEIGHT - 200) + 100;
                p.respawnAt = 0;
            }
            continue;
        }

        // movement
        let dx = 0, dy = 0;
        if (p.input.up) dy -= 1;
        if (p.input.down) dy += 1;
        if (p.input.left) dx -= 1;
        if (p.input.right) dx += 1;
        const len = Math.hypot(dx, dy) || 1;
        p.vx = (dx / len) * PLAYER_SPEED;
        p.vy = (dy / len) * PLAYER_SPEED;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        // clamp to world
        p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
        p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
        p.angle = p.input.mouseAngle || p.angle;
    }

    // Update bullets
    for (const id in bullets) {
        const b = bullets[id];
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        // lifetime
        if (now - b.born > BULLET_LIFETIME) {
            delete bullets[id];
            continue;
        }

        // world bounds -> remove
        if (b.x < -50 || b.x > WORLD_WIDTH + 50 || b.y < -50 || b.y > WORLD_HEIGHT + 50) {
            delete bullets[id];
            continue;
        }

        // Collision with players
        for (const pid in players) {
            const p = players[pid];
            if (!p.alive || pid === b.ownerId) continue;
            const dx = p.x - b.x;
            const dy = p.y - b.y;
            const dist2 = dx * dx + dy * dy;
            const minDist = PLAYER_RADIUS + BULLET_RADIUS;
            if (dist2 <= minDist * minDist) {
                // hit
                p.health -= 25;
                if (p.health <= 0) {
                    p.alive = false;
                    p.respawnAt = now + RESPAWN_TIME;
                }
                delete bullets[id];
                break;
            }
        }
    }

}, 1000 / TICK_RATE);

// Broadcast state at lower rate
setInterval(() => {
    const snapshot = {
        time: Date.now(),
        players: Object.values(players).map(p => ({
            id: p.id,
            x: p.x,
            y: p.y,
            angle: p.angle,
            health: p.health,
            alive: p.alive
        })),
        bullets: Object.values(bullets).map(b => ({
            id: b.id,
            x: b.x,
            y: b.y
        }))
    };
    io.emit('snapshot', snapshot);
}, 1000 / BROADCAST_RATE);

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});


// ---- Minimal client served by this file ----
const CLIENT_HTML = `
<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <title>2D Multiplayer Shooter</title>
    <style>
        html,body { margin:0; height:100%; overflow:hidden; background:#111; color:#ddd; font-family:sans-serif;}
        canvas { display:block; background:#0b1622; margin:0 auto; }
        #ui { position:fixed; left:10px; top:10px; z-index:10; }
    </style>
</head>
<body>
    <div id="ui">Connecting...</div>
    <canvas id="c"></canvas>
    <script src="/socket.io/socket.io.js"></script>
    <script src="/client.js"></script>
</body>
</html>
`;

// Client-side JS
const CLIENT_JS = `
// Minimal client for the 2D shooter
const socket = io();
let myId = null;
let world = { width: 1200, height: 800 };
const canvas = document.getElementById('c');
const ui = document.getElementById('ui');
const ctx = canvas.getContext('2d');

function fitCanvas() {
    const ratio = world.width / world.height;
    let w = window.innerWidth;
    let h = Math.min(window.innerHeight, window.innerWidth / ratio);
    canvas.width = world.width * (h / world.height);
    canvas.height = h;
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
}
window.addEventListener('resize', fitCanvas);

let state = { players: [], bullets: [] };
const input = { up:false,down:false,left:false,right:false,mouseAngle:0,shoot:false };

socket.on('init', (data) => {
    myId = data.id;
    world = data.world;
    ui.textContent = 'Connected as ' + myId;
    fitCanvas();
});

socket.on('snapshot', (snap) => {
    state = snap;
});

// Input handling
const keys = {};
window.addEventListener('keydown', (e) => {
    if (e.key === 'w' || e.key === 'ArrowUp') input.up = true;
    if (e.key === 's' || e.key === 'ArrowDown') input.down = true;
    if (e.key === 'a' || e.key === 'ArrowLeft') input.left = true;
    if (e.key === 'd' || e.key === 'ArrowRight') input.right = true;
    sendInput();
});
window.addEventListener('keyup', (e) => {
    if (e.key === 'w' || e.key === 'ArrowUp') input.up = false;
    if (e.key === 's' || e.key === 'ArrowDown') input.down = false;
    if (e.key === 'a' || e.key === 'ArrowLeft') input.left = false;
    if (e.key === 'd' || e.key === 'ArrowRight') input.right = false;
    sendInput();
});

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // map to world coordinates
    const sx = cx / canvas.width * world.width;
    const sy = cy / canvas.height * world.height;
    const me = state.players.find(p => p.id === myId);
    if (me) {
        input.mouseAngle = Math.atan2(sy - me.y, sx - me.x);
        sendInput();
    }
});

canvas.addEventListener('mousedown', () => {
    input.shoot = true;
    sendInput();
    // short pulse so server treats single shots
    setTimeout(() => { input.shoot = false; }, 20);
});

function sendInput() {
    socket.emit('input', input);
}

// Rendering
function render() {
    // clear
    ctx.clearRect(0,0,canvas.width,canvas.height);

    // background grid
    ctx.fillStyle = '#071019';
    ctx.fillRect(0,0,canvas.width,canvas.height);

    // scale to world
    const sx = canvas.width / world.width;
    const sy = canvas.height / world.height;

    // draw bullets
    for (const b of state.bullets) {
        ctx.fillStyle = '#ffde59';
        ctx.beginPath();
        ctx.arc(b.x * sx, b.y * sy, 4 * sx, 0, Math.PI*2);
        ctx.fill();
    }

    // draw players
    for (const p of state.players) {
        const px = p.x * sx, py = p.y * sy;
        // body
        ctx.fillStyle = p.alive ? (p.id === myId ? '#4fd1c5' : '#90cdf4') : '#444';
        ctx.beginPath();
        ctx.arc(px, py, 16 * sx, 0, Math.PI*2);
        ctx.fill();
        // facing line
        ctx.strokeStyle = '#033';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(p.angle) * 24 * sx, py + Math.sin(p.angle) * 24 * sy);
        ctx.stroke();
        // health bar
        ctx.fillStyle = '#333';
        ctx.fillRect(px - 20 * sx, py + 20 * sy, 40 * sx, 6 * sy);
        ctx.fillStyle = '#e53e3e';
        const hpW = Math.max(0, (p.health / 100) * 40 * sx);
        ctx.fillRect(px - 20 * sx, py + 20 * sy, hpW, 6 * sy);
        // id
        ctx.fillStyle = '#ddd';
        ctx.font = (12 * sx) + 'px sans-serif';
        ctx.fillText(p.id === myId ? 'You' : (p.id.substring(0,4)), px - 18 * sx, py - 22 * sy);
    }

    requestAnimationFrame(render);
}
requestAnimationFrame(render);
`;

