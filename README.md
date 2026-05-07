# NJ Property Scout

Real estate investment research tool for New Jersey foreclosures and short sales.

## Files
- `index.html` — the app frontend
- `functions/api/search.js` — Cloudflare Worker backend (handles Gemini API securely)
- `wrangler.toml` — Cloudflare Pages config

## Deployment Steps

### 1. Upload to GitHub
- Create a new repository called `nj-property-scout`
- Upload all these files

### 2. Connect to Cloudflare Pages
- Go to cloudflare.com → Pages → Create a project
- Connect your GitHub repository
- Build settings: leave blank (no build command needed)
- Deploy

### 3. Add your Gemini API Key
- In Cloudflare Pages → Settings → Environment Variables
- Add variable: `GEMINI_API_KEY` = your key from aistudio.google.com

### 4. Connect your domain
- In Cloudflare Pages → Custom Domains
- Add: properties.verityhealthgroup.com

That's it!
