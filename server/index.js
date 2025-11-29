/**
 * UrbanTrack - Server
 * Express + WebSocket server with email-only login (no password) for demo.
 * Gamification: points per km, badges, challenges.
 *
 * WARNING: For production, replace email-only with magic links or OAuth, secure with HTTPS, and add rate limiting.
 *
 * Env:
 *  PORT (default 3000)
 *  NODE_ENV
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const shortid = require('shortid');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, '..', 'data.json');
const SAVE_INTERVAL_MS = 10_000;
const MAX_SPEED_KMH = 140;
const POINTS_PER_KM = 10;
const BADGE_MILESTONES_METERS = [1000,5000,10000,25000,50000,100000];

function toRad(d){ return d * Math.PI / 180; }
function haversineMeters(a,b){
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDlat = Math.sin(dLat/2);
  const sinDlon = Math.sin(dLon/2);
  const inside = sinDlat*sinDlat + Math.cos(lat1)*Math.cos(lat2)*sinDlon*sinDlon;
  const c = 2 * Math.atan2(Math.sqrt(inside), Math.sqrt(1-inside));
  return R * c;
}

// Load or init data
let DATA = { riders: {}, users: {}, challenges: {} };
if (fs.existsSync(DATA_FILE)) {
  try { DATA = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e){ console.error('Could not parse data.json, starting fresh'); }
}

// ensure default challenges
if (!DATA.challenges.daily_1km) {
  DATA.challenges.daily_1km = { id:'daily_1km', name:'1 km par jour', period:'daily', targetMeters:1000 };
}
if (!DATA.challenges.weekly_5km) {
  DATA.challenges.weekly_5km = { id:'weekly_5km', name:'5 km par semaine', period:'weekly', targetMeters:5000 };
}

function saveData(){ fs.writeFileSync(DATA_FILE, JSON.stringify(DATA,null,2)); }
setInterval(saveData, SAVE_INTERVAL_MS);

// Express app
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '..', 'client', 'build')));

// API: login with email only
app.post('/api/login', (req,res)=>{
  const email = (req.body.email||'').trim().toLowerCase();
  const pseudo = (req.body.pseudo||'').trim().slice(0,40) || ('Rider-'+Math.random().toString(36).slice(2,8));
  if (!email || !email.includes('@')) return res.status(400).json({ ok:false, error:'invalid_email' });
  if (!DATA.users[email]) {
    const id = shortid.generate();
    DATA.users[email] = { id, email, pseudo, createdAt: Date.now() };
    // init rider
    DATA.riders[id] = { id, name: pseudo, last:null, history:[], distance:0, score:0, badges:[], challenges:{}, createdAt:Date.now(), visible:true };
  }
  const user = DATA.users[email];
  res.json({ ok:true, id: user.id, pseudo: DATA.riders[user.id].name });
});

// API: snapshot
app.get('/api/riders', (req,res)=> res.json({ ok:true, riders: DATA.riders }));
app.get('/api/leaderboard', (req,res)=>{
  const arr = Object.values(DATA.riders).map(r => ({ id:r.id, name:r.name, distance:r.distance||0, score:r.score||0 })).sort((a,b)=>b.score-a.score);
  res.json({ ok:true, leaderboard: arr.slice(0,200) });
});

// Serve React app
app.get('*', (req,res)=>{
  const index = path.join(__dirname, '..', 'client', 'build', 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(404).send('Build your client (npm run build) or run client in dev.');
});

// Create server + ws
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// broadcast helper
function broadcastJSON(obj){
  const raw = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(raw); });
}

function checkAndAwardBadges(rider, prevDistance, newDistance){
  rider.badges = rider.badges || [];
  const newly = [];
  for (const m of BADGE_MILESTONES_METERS) {
    if ((prevDistance||0) < m && newDistance >= m) {
      const badgeId = 'badge_' + m;
      if (!rider.badges.includes(badgeId)) {
        rider.badges.push(badgeId);
        newly.push({ id: badgeId, label: (m/1000)+' km' });
      }
    }
  }
  return newly;
}

function awardPointsPerKm(rider, prevDistance, newDistance){
  const prevKm = Math.floor((prevDistance||0)/1000);
  const newKm = Math.floor(newDistance/1000);
  const kmsGained = Math.max(0, newKm - prevKm);
  const pointsGained = kmsGained * POINTS_PER_KM;
  if (pointsGained) rider.score = (rider.score||0) + pointsGained;
  return { kmsGained, pointsGained };
}

function updateChallengesForRider(rider, addedMeters, ts){
  rider.challenges = rider.challenges || {};
  const events = [];
  const now = new Date(ts||Date.now());
  for (const [cid, chal] of Object.entries(DATA.challenges)) {
    if (!rider.challenges[cid]) rider.challenges[cid] = { progressMeters:0, lastReset:null, completed:false };
    const prog = rider.challenges[cid];
    if (chal.period === 'daily') {
      const dayKey = now.toISOString().slice(0,10);
      if (prog.lastReset !== dayKey) { prog.progressMeters = 0; prog.lastReset = dayKey; prog.completed = false; }
    } else if (chal.period === 'weekly') {
      const start = new Date(now); const day = start.getDay(); const diff = (day+6)%7; start.setDate(now.getDate()-diff);
      const weekKey = start.toISOString().slice(0,10);
      if (prog.lastReset !== weekKey) { prog.progressMeters = 0; prog.lastReset = weekKey; prog.completed = false; }
    }
    if (prog.completed) continue;
    prog.progressMeters += addedMeters;
    if (prog.progressMeters >= chal.targetMeters) {
      prog.completed = true; prog.completedAt = Date.now();
      const bonus = Math.floor(chal.targetMeters/1000) * 5;
      rider.score = (rider.score||0) + bonus;
      events.push({ type:'challenge_completed', challengeId:cid, riderId:rider.id, bonusPoints:bonus });
    }
  }
  return events;
}

function handlePosition(payload){
  if (!payload || typeof payload.lat !== 'number' || typeof payload.lon !== 'number' || !payload.id) return { accepted:false, reason:'invalid' };
  const now = Date.now(); const ts = payload.ts || now;
  const id = payload.id;
  if (!DATA.riders[id]) return { accepted:false, reason:'unknown_rider' };
  const rider = DATA.riders[id];
  const last = rider.last;
  let meters = 0;
  if (last && last.ts && ts > last.ts) {
    meters = haversineMeters({lat:last.lat, lon:last.lon}, {lat:payload.lat, lon:payload.lon});
    const dt = (ts - last.ts)/1000; const speedMs = dt>0? meters/dt : 0; const speedKmh = speedMs*3.6;
    if (speedKmh > MAX_SPEED_KMH) { rider.suspicious = (rider.suspicious||0)+1; return { accepted:false, reason:'speed' }; }
    rider.distance = (rider.distance||0) + meters;
    rider.history = rider.history || [];
    rider.history.push({ lat: payload.lat, lon: payload.lon, ts, meters: Math.round(meters) });
    if (rider.history.length > 200) rider.history.shift();
    const prevDistance = rider.distance - meters;
    const { kmsGained, pointsGained } = awardPointsPerKm(rider, prevDistance, rider.distance);
    const newlyBadges = checkAndAwardBadges(rider, prevDistance, rider.distance);
    const challengeEvents = updateChallengesForRider(rider, meters, ts);
    broadcastJSON({ type:'rider_update', rider:{ id:rider.id, name:rider.name, lat:payload.lat, lon:payload.lon, distance: Math.round(rider.distance), score: rider.score }});
    if ((kmsGained && kmsGained>0) || newlyBadges.length || challengeEvents.length) {
      broadcastJSON({ type:'game_event', riderId:rider.id, name:rider.name, kmsGained, pointsGained, newBadges: newlyBadges, challengeEvents });
    }
  }
  rider.last = { lat: payload.lat, lon: payload.lon, ts };
  rider.updatedAt = Date.now();
  return { accepted:true, id: rider.id };
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection',(ws)=>{
  try { ws.send(JSON.stringify({ type:'snapshot', riders: DATA.riders, challenges: DATA.challenges })); } catch(e){}
  ws.on('message', msg=>{
    let parsed;
    try { parsed = JSON.parse(msg.toString()); } catch(e){ ws.send(JSON.stringify({ type:'error', message:'invalid_json' })); return; }
    if (parsed.type === 'position') {
      const res = handlePosition(parsed.payload || parsed);
      ws.send(JSON.stringify({ type:'ack', result: res }));
    } else if (parsed.type === 'whoami') {
      const newId = shortid.generate();
      ws.send(JSON.stringify({ type:'whoami', id: newId }));
    }
  });
});

process.on('SIGINT', ()=>{ console.log('saving...'); saveData(); process.exit(0); });
process.on('SIGTERM', ()=>{ console.log('saving...'); saveData(); process.exit(0); });

server.listen(PORT, ()=> console.log('UrbanTrack server running on port', PORT));
