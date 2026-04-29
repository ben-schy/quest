# Quest

A multiplayer choose-your-own-adventure where the **TV** shows the story, **phones** are the controllers, and **Claude** is the Game Master.

Players scan a QR code, pick a class (Warrior, Mage, Rogue, Cleric), and get random stats and starting items. Each round Claude sets a tactical scene, gives every player 3–4 choices on their phone, then resolves the whole party's actions — tracking HP, damage, items, and status effects — before rolling into the next encounter.

## Setup

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Powers the Game Master (Claude) |
| `OPENAI_API_KEY` | No | Powers TTS narration (OpenAI tts-1). Silent if absent. |
| `TTS_VOICE` | No | OpenAI voice name (default: `onyx`) |
| `PORT` | No | Server port (default: `3000`) |

Copy `.env.example` to `.env` and fill in your keys for local dev.

### Local

```bash
npm install
npm start
```

Open `http://<your-lan-ip>:3000/tv` on the TV screen, then players scan the QR code.

### Deploy to Render

1. Push this repo to GitHub.
2. In [Render](https://render.com), create a new **Web Service** pointing at the repo (or use the `render.yaml` blueprint).
3. Set `ANTHROPIC_API_KEY` (and optionally `OPENAI_API_KEY`) in the Render environment variables dashboard.
4. Deploy. The TV URL is `https://<your-app>.onrender.com/tv`.

> **Note:** Render's free tier has an ephemeral filesystem — `quest_history.json` (cross-session memory) won't survive redeploys. Upgrade to a paid plan with a persistent disk, or swap in a database, if you want history to persist.

## Roles

| Role | How to become one |
|---|---|
| **Admin** | Join with a name registered in `lib/game.js` (`ADMINS` set) |
| **Player** | Anyone else who joins |

Admins can: set a campaign theme, choose the number of rounds (3 / 5 / 7 / 10), add bots, kick players, toggle TTS narration, end the game early, and start a new adventure with the same party.

## How a round works

1. Claude sets a scene with specific enemies, positions, and stakes.
2. Every active player gets 3–4 tactical options on their phone, tailored to their class.
3. Players choose. Bots auto-pick after a few seconds. Disconnected players are auto-picked after 30 s.
4. Claude resolves all actions — narrating outcomes, applying HP deltas, tracking items and status effects — then sets the next scene.
5. After the final round, Claude names the adventure and delivers a closing narration.

## Quest history

Completed adventures are saved to `quest_history.json`. Claude reads the last 3 quests when opening a new one, weaving in recurring characters, places, and items for continuity.

Survivors carry their items into the next adventure (same server session).

## Files

```
server.js          Express + Socket.IO server, game loop, Claude & TTS calls
lib/game.js        Pure game state and helpers (also used by tests)
public/
  tv.html / tv.js        TV display
  index.html / phone.js  Phone client
  styles.css             Shared styles
test/game.test.js  Unit tests (node --test)
render.yaml        Render.com deployment blueprint
```
