import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import MapboxGL from 'mapbox-gl';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './App.css';

MapboxGL.accessToken = process.env.REACT_APP_MAPBOX_TOKEN || '';

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [pseudo, setPseudo] = useState('');
  async function submit(e){
    e.preventDefault();
    try {
      const res = await axios.post('/api/login', { email, pseudo });
      if (res.data.ok) onLogin({ id: res.data.id, pseudo: res.data.pseudo });
    } catch(err){ toast.error('Login failed'); }
  }
  return (<form className='login' onSubmit={submit}>
    <img src="/branding/logo_mark.svg" alt="UrbanTrack" style={{width:64,marginBottom:12}} />
    <h2>UrbanTrack — Connecte. Ride. Progresse.</h2>
    <input placeholder='email' value={email} onChange={e=>setEmail(e.target.value)} required />
    <input placeholder='pseudo (facultatif)' value={pseudo} onChange={e=>setPseudo(e.target.value)} />
    <button type='submit'>Se connecter</button>
  </form>);
}

function MapPage({ user }) {
  const mapRef = useRef();
  const wsRef = useRef();
  const markersRef = useRef({});
  const [leaderboard, setLeaderboard] = useState([]);

  useEffect(()=>{
    const map = new MapboxGL.Map({
      container: 'map',
      style: 'https://api.maptiler.com/maps/streets/style.json?key=GET_YOUR_OWN' ,
      center: [3.161,50.723],
      zoom: 13
    });
    mapRef.current = map;
    return ()=> map.remove();
  },[]);

  useEffect(()=>{
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}`);
    wsRef.current = ws;
    ws.onmessage = (ev)=>{
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        Object.values(msg.riders||{}).forEach(r => placeMarker(r));
      } else if (msg.type === 'rider_update') {
        placeMarker(msg.rider);
      } else if (msg.type === 'game_event') {
        if (msg.kmsGained) toast.info(`${msg.name} +${msg.pointsGained} pts (${msg.kmsGained} km)`);
      }
    };
    ws.onopen = ()=> {
      console.log('ws open');
    };
    return ()=> { ws.close(); };
  },[]);

  function placeMarker(r){
    const map = mapRef.current;
    if (!map) return;
    if (markersRef.current[r.id]) {
      markersRef.current[r.id].setLngLat([r.lon, r.lat]);
    } else {
      const el = document.createElement('div');
      el.className = 'marker';
      el.innerText = r.name ? r.name[0] : 'R';
      const marker = new MapboxGL.Marker(el).setLngLat([r.lon, r.lat]).addTo(map);
      markersRef.current[r.id] = marker;
    }
  }

  useEffect(()=>{
    if (!user) return;
    if (!navigator.geolocation) { toast.error('Geolocation not available'); return; }
    const id = navigator.geolocation.watchPosition(pos=>{
      const { latitude: lat, longitude: lon } = pos.coords;
      const payload = { type:'position', payload: { id: user.id, lat, lon, ts: Date.now() } };
      wsRef.current && wsRef.current.send(JSON.stringify(payload));
    }, err => { console.warn(err); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
    return ()=> navigator.geolocation.clearWatch(id);
  }, [user]);

  useEffect(()=> {
    axios.get('/api/leaderboard').then(r=> setLeaderboard(r.data.leaderboard||[]));
  },[]);

  return (<div className='mapwrap'>
    <div id='map' />
    <aside className='panel'>
      <h3>Salut {user.pseudo}</h3>
      <h4>Leaderboard</h4>
      <ol>{leaderboard.map(x => <li key={x.id}>{x.name} — {Math.round(x.distance)} m — {x.score} pts</li>)}</ol>
      <p style={{fontSize:12,marginTop:8}}>UrbanTrack — Connecte. Ride. Progresse.</p>
    </aside>
    <ToastContainer position='bottom-right' />
  </div>);
}

export default function App(){
  const [user, setUser] = useState(null);
  return user ? <MapPage user={user} /> : <Login onLogin={setUser} />;
}
