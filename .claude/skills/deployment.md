# Deployment Skill

Use this skill when deploying the API to Railway or preparing for production.

## Railway Deployment

### Prerequisites

1. Railway account (https://railway.app)
2. Railway CLI installed: `npm install -g @railway/cli`
3. GitHub repository connected

### Initial Setup

```bash
# Login to Railway
railway login

# Link project
railway link

# Create PostgreSQL database
railway add --database postgres
```

### Environment Variables

Set these in Railway dashboard (Settings → Variables):

```env
# Required
DATABASE_URL          # Auto-set by Railway PostgreSQL
PORT=3001
CORS_ORIGIN=https://your-frontend.vercel.app

# Game Core (if published to npm)
# If using local file reference, need different approach

# Future: Auth
JWT_SECRET=generate-32-char-random-string
```

### railway.json (Optional)

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm run start",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

### Deploy Commands

```bash
# Deploy current branch
railway up

# Deploy with logs
railway up --detach && railway logs

# Check status
railway status
```

## Handling @poke-tcg/game-core

Since game-core is a local package (`file:../pokemon-tcg-game-core`), options:

### Option 1: Monorepo (Recommended)

```
pokemon-tcg-monorepo/
├── packages/
│   ├── api/          # This backend
│   ├── frontend/     # Next.js app
│   └── game-core/    # Shared logic
├── package.json      # Workspace root
└── turbo.json        # Turborepo config
```

### Option 2: Publish to npm

```bash
cd ../pokemon-tcg-game-core
npm publish --access public
# Then update package.json to use "@poke-tcg/game-core": "^1.0.0"
```

### Option 3: Git Submodule

```bash
git submodule add ../pokemon-tcg-game-core packages/game-core
# Update package.json: "file:./packages/game-core"
```

## Pre-Deployment Checklist

### Code Quality

```bash
# Type check
npx tsc --noEmit

# Lint
npm run lint

# Tests
npm run test

# Build
npm run build
```

### Security

- [ ] No secrets in code (use env vars)
- [ ] CORS configured for production frontend only
- [ ] Rate limiting enabled (future)
- [ ] Input validation on all endpoints

### Database

```bash
# Generate Prisma client
npm run db:generate

# Push schema (first deploy)
npm run db:push

# Or run migrations
npm run db:migrate
```

### Health Check

Ensure `/health` endpoint exists and returns:

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Production Considerations

### CORS

Update `src/index.ts` for production:

```typescript
const ALLOWED_ORIGINS = [
  process.env.CORS_ORIGIN,
  'https://your-app.vercel.app',
  'https://your-custom-domain.com'
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
```

### Socket.io CORS

```typescript
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});
```

### Logging (Future)

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined,
});
```

### Rate Limiting (Future)

```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // requests per window
  message: { error: 'Too many requests' },
});

app.use('/api', limiter);
```

## Monitoring

### Railway Dashboard

- View logs: Railway dashboard → Deployments → Logs
- View metrics: Railway dashboard → Metrics
- Set alerts: Railway dashboard → Settings → Alerts

### Health Check Monitoring

Use external service (UptimeRobot, Pingdom) to monitor:
- `https://your-api.railway.app/health`

## Rollback

```bash
# List deployments
railway deployments

# Rollback to previous
railway rollback
```

## Useful Commands

```bash
# View environment
railway variables

# Open shell in container
railway shell

# View recent logs
railway logs --tail 100

# Connect to database
railway connect postgres
```
