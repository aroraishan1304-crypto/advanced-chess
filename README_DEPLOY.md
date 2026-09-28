# Advanced Chess — Live Play a Friend

This version adds a real server-backed private friend-game system to the existing chess app.

## What is included

- Create a private game and get a shareable link.
- Join from a second phone/computer with the link.
- White/Black assignment by the server.
- Server-authoritative legal moves.
- Live board synchronization.
- Server-authoritative clocks and increments.
- Check, checkmate, stalemate, insufficient-material, repetition and 50-move handling.
- Resign, abort, draw offer/accept/decline, and rematch-by-creating-a-new-game.
- Automatic reconnection through Server-Sent Events.
- A small heartbeat so a waiting live game can keep a free hosting instance awake.

## The only setup you need to do

### 1. Put this folder on GitHub

Create a new GitHub repository (for example `advanced-chess`) and upload the **contents of this folder**.

Do not upload `node_modules`.

You should see these items at the top level of the repository:

- `chess.html`
- `server.js`
- `package.json`
- `render.yaml`
- `stockfish/`

### 2. Deploy on Render

Open Render and create a **New → Web Service** from that GitHub repository.

Use:

- Runtime: **Node**
- Build Command: **npm install**
- Start Command: **npm start**
- Plan: **Free**

The included `render.yaml` contains the same configuration, so the Blueprint flow can also be used.

Render gives the service a public `onrender.com` URL. That URL is your new chess website.

### 3. Play

Open the Render URL.

Click **Play a Friend → Create game**.

Choose your name and time control.

The game screen shows a **Copy link** button. Send that link to your friend.

Your friend opens it, enters their name, and joins.

No `127.0.0.1`, port forwarding, or IP-address sharing is needed.

## Local testing

From this folder on a computer with Node.js installed:

```text
npm install
npm start
```

Then open:

```text
http://127.0.0.1:5500/chess.html
```

The live friend feature will also work locally if both browsers use the same computer's reachable LAN address, but the public Render URL is the intended setup for playing from different devices/houses.

## Important hosting note

The included server keeps active games in memory. That is intentional to keep the project simple and free. A Render free service can spin down after a period without inbound traffic, and Render can restart free services; when the server process is restarted, in-memory games are lost. The client heartbeat helps during long games, but this is not yet a persistent tournament-grade backend.
