# Acuity Scheduling → PassKit Membership Card Bridge (Vercel)

Automatically creates PassKit mobile wallet membership cards when a member signs up for a membership through Acuity Scheduling. Deployed on **Vercel** for 24/7 uptime with zero infrastructure management.

## How It Works

```
Member signs up     Acuity fires       Vercel function     PassKit creates      Member gets
in Acuity      →    webhook       →    processes it   →    membership card  →   email to install
Scheduling          (order.completed)  & calls PassKit      in their system      on Apple/Google Wallet
```

**Example:** Tina Cevizovic signs up for "UNDEFINED x ONE MEMBERSHIP" in Acuity Scheduling → she automatically receives an email from PassKit with a link to install her membership card on her phone's wallet. No manual work required.

## Project Structure

```
acuity-passkit-bridge/
├── api/                    # Vercel serverless functions
│   ├── webhook.js          # ← Acuity webhook receiver (main endpoint)
│   ├── process-order.js    # Manual order re-processing
│   ├── status.js           # Health check & config status
│   ├── logs.js             # Activity log
│   ├── test-acuity.js      # Test Acuity API connection
│   └── test-passkit.js     # Test PassKit API connection
├── lib/
│   └── helpers.js          # Shared: API clients, JWT auth, core logic
├── public/
│   └── index.html          # Dashboard UI
├── vercel.json             # URL rewrites & config
├── package.json
└── .env.example            # Environment variable template
```

## Deploy to Vercel

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/acuity-passkit-bridge.git
git push -u origin main
```

### Step 2: Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in
2. Click **"Add New... → Project"**
3. Import your GitHub repository
4. Vercel auto-detects the config — just click **Deploy**

### Step 3: Add Environment Variables

In Vercel Dashboard → Your Project → **Settings** → **Environment Variables**, add:

| Variable | Value | Where to find it |
|----------|-------|-------------------|
| `ACUITY_USER_ID` | Your Acuity User ID | Acuity → Integrations → API |
| `ACUITY_API_KEY` | Your Acuity API Key | Same page as above |
| `PASSKIT_API_KEY` | Your PassKit API Key | PassKit Dashboard → Developer Tools → REST Credentials |
| `PASSKIT_API_SECRET` | Your PassKit API Secret | Same page as above |
| `PASSKIT_API_URL` | `https://api.pub1.passkit.io` | Use `pub2` for USA data instance |
| `PASSKIT_PROGRAM_ID` | Your program ID | PassKit Dashboard → Your program |
| `MEMBERSHIP_PRODUCT_FILTER` | *(optional)* e.g. `UNDEFINED x ONE MEMBERSHIP` | Leave empty to process all orders |

`tierId` is fixed in code to `membership`.
`externalId` is set from Acuity's 8-character alphanumeric certificate code.

After adding variables, click **Redeploy** to apply them.

### Step 4: Set Up Acuity Webhook

1. In Acuity Scheduling, go to **Integrations**
2. Scroll to **API** section → find **Webhooks** → click **Set Up**
3. In the **"Order Completed"** field, enter:
   ```
   https://your-project-name.vercel.app/webhook/acuity
   ```
4. Save

That's it! Your webhook URL is always-on, no local machine or ngrok needed.

### Step 5 (Optional): Add Upstash Redis for Persistent Logs

By default, logs are written to Vercel's function logs (visible in the dashboard) but the in-app activity log resets between function invocations. To get **persistent logs** in the dashboard UI:

1. In Vercel Dashboard → **Marketplace** (or **Storage**) → add **Upstash Redis**
2. Link the integration to this project
3. Confirm env vars are present: `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
4. Install dependency: add `"@upstash/redis": "^1.35.6"` to your `package.json` dependencies
5. Redeploy

This is totally optional — the bridge works fine without it.

## Dashboard

Visit `https://your-project-name.vercel.app` to see:

- **Live status** of API connections
- **Configuration check** for all required credentials
- **Activity log** (persistent with Upstash Redis, ephemeral without)
- **Test buttons** for Acuity and PassKit connections
- **Manual order re-processing** for testing or fixing failures
- **Webhook URL** ready to copy into Acuity

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/webhook/acuity` | Acuity webhook receiver (set this in Acuity) |
| `POST` | `/api/process-order?orderId=123` | Manually process an order |
| `GET`  | `/api/status` | Health check & config |
| `GET`  | `/api/logs` | Activity log (requires Redis for persistence) |
| `GET`  | `/api/test-acuity` | Test Acuity connection |
| `GET`  | `/api/test-passkit` | Test PassKit connection |

## Architecture

```
                              ┌──────────────────────────────────────────┐
                              │            Vercel (always on)            │
┌──────────────┐              │                                          │
│   Acuity     │  webhook     │  ┌──────────────────┐                    │
│   Scheduling │ ─────────────┼─►│ api/webhook.js    │                    │
│              │  POST         │  │ (serverless fn)   │                    │
└──────────────┘              │  └────────┬─────────┘                    │
                              │           │                              │
                              │           ▼                              │
                              │  ┌──────────────────┐   Acuity API       │
                              │  │ lib/helpers.js    │◄──────────────────►│ GET /orders/:id
                              │  │ (shared logic)    │                    │
                              │  └────────┬─────────┘                    │
                              │           │                              │
                              │           ▼           PassKit API         │
                              │     PUT /members/member ─────────────────►│
                              │                                          │
                              │  ┌──────────────────┐                    │
                              │  │ public/index.html │ ← Dashboard UI    │
                              │  └──────────────────┘                    │
                              └──────────────────────────────────────────┘
                                                        │
                                                        ▼
                                               PassKit sends email
                                               to member with wallet
                                               install link
```

## Key Differences from Local Version

| Feature | Local (Express) | Vercel (Serverless) |
|---------|----------------|---------------------|
| Uptime | Only when laptop is on | 24/7 always-on |
| URL | Requires ngrok | Permanent `*.vercel.app` URL |
| Scaling | Single process | Auto-scales per request |
| Logs | In-memory (lost on restart) | Vercel function logs + optional Redis |
| Cost | Free (your machine) | Free tier: 100GB bandwidth, 100hr compute |
| Webhook processing | Fire-and-forget (async) | Must complete before response |
| SSL | Manual or ngrok | Automatic HTTPS |

## Troubleshooting

**Webhook returns 500 / Acuity retries constantly**
- Check Vercel → Functions → Logs for error details
- Verify all env variables are set correctly in Vercel Settings

**"PassKit connection test failed"**
- Verify `PASSKIT_API_KEY` and `PASSKIT_API_SECRET` in Vercel env vars
- Check if you need `pub2` instead of `pub1`

**"Acuity connection test failed"**  
- Verify `ACUITY_USER_ID` and `ACUITY_API_KEY`
- Ensure your Acuity plan includes API access

**Dashboard log is empty**
- Without Redis, the dashboard log won't persist between function calls
- Check Vercel Dashboard → Functions → Logs for all output
- Add Upstash Redis for persistent in-app logs

**After changing env vars, nothing happened**
- You need to **Redeploy** after changing environment variables in Vercel

## License

MIT
