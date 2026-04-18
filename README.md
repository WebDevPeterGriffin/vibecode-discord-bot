# VibeCode Discord Bot

A Discord bot that lets your server members ask the [VibeCode AI](https://george420-vibecodebible.hf.space) questions via slash commands, button clicks, or direct messages.

---

## Features

| Feature | Details |
|---|---|
| `/ask` slash command | Sends the answer privately to the user's DMs (ephemeral fallback if DMs are disabled) |
| Startup button | Posts a "💬 Ask VibeCode AI" button in `#vibecode-ai` on every restart |
| Direct messages | Users can DM the bot directly and get answers |
| Typing indicator | Shows a typing indicator while the API is fetching a response |
| Rate limiting | Max 1 request per user per 10 seconds |
| Long answers | Automatically splits responses that exceed Discord's 2000-character limit |

---

## Setup

### 1. Create a Discord Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent**
   - **Server Members Intent** (optional but recommended)
5. Copy the **Bot Token** — this is your `BOT_TOKEN`
6. Copy the **Application ID** from the **General Information** page — this is your `APPLICATION_ID`

### 2. Invite the Bot to Your Server

Use this OAuth2 URL (replace `YOUR_CLIENT_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274878024704&scope=bot%20applications.commands
```

Required permissions:
- `Send Messages`
- `Read Message History`
- `View Channels`
- `Manage Messages` (to clean up old startup buttons)

### 3. Get Server & Channel IDs

1. In Discord, go to **Settings → Advanced** and enable **Developer Mode**
2. Right-click your server name → **Copy Server ID** — this is your `GUILD_ID`
3. Right-click the `#vibecode-ai` channel → **Copy Channel ID** — this is your `VIBECODE_CHANNEL_ID`

### 4. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Discord bot token |
| `APPLICATION_ID` | ✅ | Discord application / client ID |
| `GUILD_ID` | ✅ | Discord server (guild) ID |
| `VIBECODE_CHANNEL_ID` | ✅ | ID of the `#vibecode-ai` channel |
| `VIBECODE_API` | ❌ | VibeCode API base URL (default: `https://george420-vibecodebible.hf.space`) |
| `PORT` | ❌ | HTTP port for keep-alive server (set automatically by Render) |

### 5. Install Dependencies & Run

```bash
npm install
npm start
```

---

## Deploying to Render

1. Push this repo to GitHub
2. Go to [https://render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Set:
   - **Environment:** `Node`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
5. Add all environment variables from the table above under **Environment**
6. Deploy — Render assigns a port automatically via `process.env.PORT`

> The Express keep-alive server on `PORT` is required for Render to keep the service alive and detect crashes.

---

## Project Structure

```
vibecode-discord-bot/
├── index.js          # Main bot logic
├── package.json      # Dependencies
├── .env.example      # Environment variable template
├── .gitignore        # Ignores node_modules and .env
└── README.md         # This file
```

---

## API Reference

The bot calls:

```
POST https://george420-vibecodebible.hf.space/ask
Content-Type: application/json

{ "question": "your question here" }
```

Response:
```json
{ "answer": "the AI's answer" }
```
