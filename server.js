const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200); res.end('Tank CTF Server Running');
});
const wss = new WebSocket.Server({ server });

// ── CONSTANTS (must match client) ─────────────────────────────
const ARENA      = { x:90, y:30, w:620, h:390 };
const MAX_AMMO   = 5;
const RELOAD_MS  = 2000;
const CAGE_SECS  = 10;
const ROT_SPEED  = 3.6;
const MOVE_SPD   = 1.6;
const BULLET_SPD = 7;
const TANK_R     = 14;
const BULLET_R   = 3;
const TICK_MS    = 1000 / 60; // 60 ticks per second
const SPAWNS     = [[{x:130,y:110},{x:130,y:340}],[{x:670,y:110},{x:670,y:340}]];
const FLAG_POS   = [{x:105,y:225},{x:695,y:225}];
const CAP_ZONE   = [{x:58,y:175,w:80,h:100},{x:662,y:175,w:80,h:100}];
const OBSTACLES  = [
  {x:370,y:60,w:18,h:80},{x:370,y:310,w:18,h:80},
  {x:200,y:180,w:60,h:14},{x:200,y:180,w:14,h:50},
  {x:540,y:180,w:60,h:14},{x:586,y:180,w:14,h:50},
  {x:200,y:290,w:14,h:50},{x:200,y:326,w:60,h:14},
  {x:540,y:326,w:60,h:14},{x:586,y:290,w:14,h:50},
  {x:290,y:150,w:14,h:14},{x:310,y:165,w:14,h:14},
  {x:460,y:260,w:14,h:14},{x:480,y:275,w:14,h:14},
];

// ── ROOMS ─────────────────────────────────────────────────────
const rooms = {}; // roomCode -> Room

function genCode() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

class Room {
  constructor(code) {
    this.code = code;
    this.clients = {}; // slot -> ws
    this.state = null;
    this.holding = [false,false,false,false];
    this.reloadTimers = [[],[],[],[]];
    this.ticker = null;
    this.started = false;
  }

  addClient(slot, ws) {
    this.clients[slot] = ws;
    this.broadcast('players', { slots: Object.keys(this.clients).map(Number) });
    if (Object.keys(this.clients).length >= 2) {
      this.broadcast('canstart', {});
    }
  }

  removeClient(slot) {
    delete this.clients[slot];
    this.holding[slot] = false;
    this.broadcast('players', { slots: Object.keys(this.clients).map(Number) });
  }

  start() {
    this.started = true;
    this.state = this.initState();
    this.broadcast('start', {});
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  initState() {
    return {
      tanks: [
        this.mkTank(0,0), this.mkTank(1,0),
        this.mkTank(2,1), this.mkTank(3,1),
      ],
      bullets: [],
      flags: [
        {team:0, x:FLAG_POS[0].x, y:FLAG_POS[0].y, held:false, heldBy:-1},
        {team:1, x:FLAG_POS[1].x, y:FLAG_POS[1].y, held:false, heldBy:-1},
      ],
      gameOver: false,
      winner: -1,
    };
  }

  mkTank(id, team) {
    const sp = SPAWNS[team][id%2];
    return { id, team, x:sp.x, y:sp.y, angle:team===0?45:135, rotDir:1,
      ammo:MAX_AMMO, alive:true, caging:false, cageTimer:0, hasFlag:false };
  }

  handleInput(slot, type, angle) {
    const t = this.state?.tanks[slot];
    if (!t) return;
    if (type === 'down') {
      if (!t.alive || t.caging) return;
      this.holding[slot] = true;
      if (angle !== undefined) t.angle = angle;
      // Shoot
      if (t.ammo > 0) {
        t.ammo--;
        const rad = t.angle * Math.PI / 180;
        this.state.bullets.push({
          x: t.x + Math.cos(rad)*(TANK_R+2),
          y: t.y + Math.sin(rad)*(TANK_R+2),
          vx: Math.cos(rad)*BULLET_SPD,
          vy: Math.sin(rad)*BULLET_SPD,
          team: t.team, owner: slot, life: 180,
        });
        // Reload
        setTimeout(() => {
          if (t.ammo < MAX_AMMO) t.ammo++;
        }, RELOAD_MS);
      }
    } else {
      this.holding[slot] = false;
      if (t) t.rotDir *= -1;
    }
  }

  tick() {
    if (!this.state || this.state.gameOver) return;
    const dt = 1; // 1 frame at 60fps

    const s = this.state;

    // Update tanks
    s.tanks.forEach((t, i) => {
      // Rotation
      if (!this.holding[i]) t.angle = (t.angle + ROT_SPEED * t.rotDir * dt + 360) % 360;
      // Cage
      if (t.caging) {
        t.cageTimer -= dt / 60;
        if (t.cageTimer <= 0) { t.caging = false; t.alive = true; }
      }
      if (!t.alive) return;
      // Movement
      if (this.holding[i]) {
        const rad = t.angle * Math.PI / 180;
        this.moveTank(t, t.x + Math.cos(rad)*MOVE_SPD*dt, t.y + Math.sin(rad)*MOVE_SPD*dt);
      }
      // Flag pickup
      s.flags.forEach(f => {
        if (f.team === t.team || f.held) return;
        if (dist2(t,f) < (TANK_R+14)**2) { f.held=true; f.heldBy=t.id; t.hasFlag=true; }
      });
      // Capture
      if (t.hasFlag && inRect(t.x, t.y, CAP_ZONE[t.team])) this.triggerWin(t.team);
    });

    // Move flags
    s.flags.forEach(f => {
      if (f.held && f.heldBy >= 0) {
        const c = s.tanks[f.heldBy];
        if (c && c.alive && !c.caging) { f.x=c.x; f.y=c.y+12; }
        else { f.held=false; if(c)c.hasFlag=false; f.heldBy=-1; }
      }
    });

    // Bullets
    s.bullets = s.bullets.filter(b => {
      b.x += b.vx*dt; b.y += b.vy*dt; b.life -= dt;
      if (b.life<=0||b.x<ARENA.x||b.x>ARENA.x+ARENA.w||b.y<ARENA.y||b.y>ARENA.y+ARENA.h) return false;
      for (const o of OBSTACLES) if (circleRect(b.x,b.y,BULLET_R,o.x,o.y,o.w,o.h)) return false;
      for (const t of s.tanks) {
        if (!t.alive||t.caging||t.team===b.team) continue;
        if (dist2(b,t) < (TANK_R+BULLET_R)**2) { this.killTank(t); return false; }
      }
      return true;
    });

    // Broadcast state to all clients
    this.broadcast('state', {
      tanks: s.tanks.map((t,i) => ({
        x:t.x, y:t.y, angle:t.angle, rotDir:t.rotDir,
        alive:t.alive, caging:t.caging, cageTimer:t.cageTimer,
        hasFlag:t.hasFlag, ammo:t.ammo, holding:this.holding[i],
      })),
      bullets: s.bullets.map(b => ({x:b.x,y:b.y,vx:b.vx,vy:b.vy,team:b.team})),
      flags: s.flags.map(f => ({x:f.x,y:f.y,held:f.held,heldBy:f.heldBy,team:f.team})),
      gameOver: s.gameOver,
      winner: s.winner,
    });
  }

  moveTank(t, nx, ny) {
    nx = Math.max(ARENA.x+TANK_R, Math.min(ARENA.x+ARENA.w-TANK_R, nx));
    ny = Math.max(ARENA.y+TANK_R, Math.min(ARENA.y+ARENA.h-TANK_R, ny));
    let bx=false, by=false;
    for (const o of OBSTACLES) {
      if (circleRect(nx,t.y,TANK_R,o.x,o.y,o.w,o.h)) bx=true;
      if (circleRect(t.x,ny,TANK_R,o.x,o.y,o.w,o.h)) by=true;
    }
    if (!bx&&!by) { t.x=nx; t.y=ny; }
    else if (!bx) { t.x=t.x+(nx-t.x)*0.5; }
    else if (!by) { t.y=t.y+(ny-t.y)*0.5; }
    // Tank-tank collision
    this.state.tanks.forEach(o => {
      if (o.id===t.id||!o.alive||o.caging) return;
      const dx=t.x-o.x, dy=t.y-o.y, d=Math.sqrt(dx*dx+dy*dy), mn=TANK_R*2;
      if (d<mn&&d>0) {
        const p=(mn-d)/2;
        t.x+=(dx/d)*p; t.y+=(dy/d)*p;
        o.x-=(dx/d)*p; o.y-=(dy/d)*p;
        t.x=Math.max(ARENA.x+TANK_R,Math.min(ARENA.x+ARENA.w-TANK_R,t.x));
        t.y=Math.max(ARENA.y+TANK_R,Math.min(ARENA.y+ARENA.h-TANK_R,t.y));
        o.x=Math.max(ARENA.x+TANK_R,Math.min(ARENA.x+ARENA.w-TANK_R,o.x));
        o.y=Math.max(ARENA.y+TANK_R,Math.min(ARENA.y+ARENA.h-TANK_R,o.y));
      }
    });
  }

  killTank(t) {
    this.state.flags.forEach(f => {
      if (f.heldBy===t.id) { f.held=false; f.heldBy=-1; t.hasFlag=false; f.x=FLAG_POS[f.team].x; f.y=FLAG_POS[f.team].y; }
    });
    this.holding[t.id] = false;
    t.alive=false; t.caging=true; t.cageTimer=CAGE_SECS; t.rotDir=1;
    const sp=SPAWNS[t.team][t.id%2];
    t.x=sp.x; t.y=sp.y; t.angle=t.team===0?45:135;
  }

  triggerWin(team) {
    if (this.state.gameOver) return;
    this.state.gameOver=true; this.state.winner=team;
    clearInterval(this.ticker);
  }

  broadcast(type, data) {
    const msg = JSON.stringify({type, ...data});
    Object.values(this.clients).forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  }

  send(slot, type, data) {
    const ws = this.clients[slot];
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type,...data}));
  }
}

// ── PHYSICS HELPERS ───────────────────────────────────────────
function circleRect(cx,cy,cr,rx,ry,rw,rh){
  const nx=Math.max(rx,Math.min(cx,rx+rw)), ny=Math.max(ry,Math.min(cy,ry+rh));
  return (cx-nx)**2+(cy-ny)**2<cr*cr;
}
function dist2(a,b){ return (a.x-b.x)**2+(a.y-b.y)**2; }
function inRect(px,py,r){ return px>=r.x&&px<=r.x+r.w&&py>=r.y&&py<=r.y+r.h; }

// ── WEBSOCKET HANDLER ─────────────────────────────────────────
wss.on('connection', ws => {
  let myRoom = null;
  let mySlot = -1;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'host') {
      const code = genCode();
      const room = new Room(code);
      rooms[code] = room;
      myRoom = room;
      mySlot = 0;
      room.addClient(0, ws);
      ws.send(JSON.stringify({type:'hosted', code, slot:0}));
    }

    else if (msg.type === 'join') {
      const room = rooms[msg.code];
      if (!room) { ws.send(JSON.stringify({type:'error',msg:'Room not found'})); return; }
      const slot = msg.slot;
      if (room.clients[slot]) { ws.send(JSON.stringify({type:'error',msg:'Slot taken'})); return; }
      myRoom = room;
      mySlot = slot;
      room.addClient(slot, ws);
      ws.send(JSON.stringify({type:'joined', slot, code:msg.code}));
    }

    else if (msg.type === 'start') {
      if (myRoom && mySlot === 0 && !myRoom.started) myRoom.start();
    }

    else if (msg.type === 'input') {
      if (myRoom && myRoom.started) myRoom.handleInput(mySlot, msg.action, msg.angle);
    }
  });

  ws.on('close', () => {
    if (myRoom) {
      myRoom.removeClient(mySlot);
      if (Object.keys(myRoom.clients).length === 0) {
        clearInterval(myRoom.ticker);
        delete rooms[myRoom.code];
      }
    }
  });
});

server.listen(PORT, () => console.log(`Tank CTF server running on port ${PORT}`));
