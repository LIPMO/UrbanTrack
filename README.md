# UrbanTrack - Full project

Included:
- server/ (Express + WebSocket)
- client/ (React + Mapbox)
- branding/

Quick start:
1. unzip UrbanTrack_full_project.zip
2. npm install
3. cd client && npm install
4. Create client/.env with REACT_APP_MAPBOX_TOKEN=your_token (or edit App.js to use MapTiler)
5. Development: npm run dev
6. Production: cd client && npm run build && npm start

Security notes:
- Email-only login here is for convenience. In production, implement passwordless email verification or OAuth.
- Use HTTPS (TLS) and secure websockets (wss).
- Add rate-limiting, input validation, and database (Redis/Postgres) for scale.
