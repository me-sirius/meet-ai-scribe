# Meet AI Scribe

Meet AI Scribe is a full-stack app that joins Google Meet calls with a bot, captures live captions, generates a meeting summary, and stores meeting history.

## What It Includes

- User authentication (signup/login with JWT)
- Google Meet bot automation (Playwright + persistent Chrome profile)
- Live caption streaming during active meetings
- AI summary generation (Gemini)
- PostgreSQL persistence via Prisma (`users`, `meetings`, `transcript_lines`)
- Frontend meeting history view

## Project Structure

- `backend/` Express API, bot automation, Prisma, meeting persistence
- `frontend/` React + Vite web app
- `meet-caption-extension/` reserved extension workspace (currently empty)

## Tech Stack

- Backend: Node.js, Express, Playwright, Prisma
- Frontend: React, Vite, Axios
- Database: PostgreSQL (Supabase works well)
- AI: Gemini API

## Quick Start

### 1) Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2) Configure environment files

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Minimum backend vars:

- `DATABASE_URL`
- `DIRECT_URL` (used by Prisma CLI and migrations)
- `GEMINI_API_KEY`
- `JWT_SECRET` (recommended for production)

Useful bot vars:

- `CHROME_AUTOMATION_USER_DATA_DIR` (default: `chrome-bot-profile`)
- `CHROME_PROFILE_DIRECTORY`
- `CHROME_CHANNEL` (recommended: `chrome`)
- `CHROME_EXECUTABLE_PATH` (optional absolute path override)
- `CHROME_DISABLE_SANDBOX` (set `true` on hosts that require no-sandbox)
- `MEET_BOT_HEADLESS` (set `true` for servers)

Frontend vars:

- `VITE_API_BASE_URL` (optional, defaults to `http://localhost:4000`)
- `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (if used by your frontend flow)

### 3) Initialize database

```bash
cd backend
npm run db:generate
npm run db:push
```

Optional one-time migration from legacy JSON users:

```bash
npm run db:import-users
```

### 4) Run locally

Terminal 1:

```bash
cd backend
npm run dev
```

Terminal 2:

```bash
cd frontend
npm run dev
```

Defaults:

- Backend: `http://localhost:4000`
- Frontend: `http://localhost:5173`

## Core API Endpoints

- `POST /auth/signup`
- `POST /auth/login`
- `GET /auth/me`
- `POST /start-bot`
- `GET /bot-run/:runId/live`
- `GET /meetings`

## Backend Scripts

- `npm run dev` start API with nodemon
- `npm start` start API in normal mode
- `npm run db:generate` generate Prisma client
- `npm run db:push` sync schema to database
- `npm run db:migrate` create and apply Prisma migration
- `npm run db:studio` open Prisma Studio
- `npm run db:import-users` import users from legacy JSON

## Notes

- Do not commit `.env` files or secrets.
- Keep the bot profile directory out of git (`chrome-bot-profile/`).
- First run may require Google account sign-in in the bot browser profile.
- Heroku deploys: ensure Chromium is installed for the backend package during build (this repo uses `PLAYWRIGHT_BROWSERS_PATH=0` in `heroku-postbuild`) so runtime can find the Playwright executable.
- Heroku deploys: add the Apt buildpack before Node.js so Linux browser dependencies from `Aptfile` are available.
	- `heroku buildpacks:clear -a <app-name>`
	- `heroku buildpacks:add --index 1 https://github.com/heroku/heroku-buildpack-apt -a <app-name>`
	- `heroku buildpacks:add --index 2 heroku/nodejs -a <app-name>`
