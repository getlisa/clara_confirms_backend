# Clara Confirms

Confirm inspections with confidence. Manage locations, inspections, calls, and audit trails in one place.

## Repo structure

- **clara-confirms** – Frontend (React + Vite), deploy to Vercel
- **clara_confirms_backend** – Backend (Node.js + Express + PostgreSQL)

## Local setup

### Backend

```bash
cd clara_confirms_backend
cp .env.example .env   # or create .env with DATABASE_URL, JWT_SECRET, SENDGRID_API_KEY, etc.
npm install
npm run migrate         # run DB migrations
npm run dev
```

Runs at `http://localhost:3000` by default.

### Frontend

```bash
cd clara-confirms
cp .env.example .env    # set VITE_API_URL=http://localhost:3000
npm install
npm run dev
```

Runs at `http://localhost:8080` by default.

## Deploy

- **Vercel**: Import this repo, set root directory to `clara-confirms`, add `VITE_API_URL` to environment.
- **Backend**: Deploy `clara_confirms_backend` to your Node host; set `FRONTEND_URL` and other env vars.
