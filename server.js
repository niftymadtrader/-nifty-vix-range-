// ==========================================
// NIFTY VIX RANGE CALCULATOR — UPSTOX
// ==========================================

const express = require('express');
const cors = require('cors');
const config = require('./config');
const upstox = require('./upstox-api');
const live = require('./live-streamer');

const app = express();
app.use(cors());
app.use(express.static('public'));

let cache = { data: null, time: 0 };
let streamer = null;  // WebSocket streamer instance

// ═══════════════════════════════════════
// ROUTE 1: /login — Open Upstox login page
// ═══════════════════════════════════════
app.get('/login', (req, res) => {
    const url = upstox.getLoginURL();
    console.log('\n🔐 Opening Upstox login...');
    res.redirect(url);
});

// ═══════════════════════════════════════
// ROUTE 2: /callback — Handle OAuth callback
// ═══════════════════════════════════════
// After Upstox login, browser redirects here with ?code=xxx
// But since redirect_uri is https://127.0.0.1/callback,
// user must manually copy the code from URL
// So we also provide /auth?code=xxx endpoint
app.get('/auth', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        return res.send(`
            <html>
            <body style="background:#06080e;color:#e6edf3;font-family:monospace;padding:40px;text-align:center;">
                <h2 style="color:#f7b731;">⚠ No auth code provided</h2>
                <p>Copy the <b>code</b> value from the URL after Upstox login</p>
                <p style="color:#7d8590;">Example: https://127.0.0.1?code=<b style="color:#26de81;">aBC123xYz</b></p>
                <br>
                <p>Then open:</p>
                <pre style="background:#0d1117;padding:15px;border-radius:8px;display:inline-block;">
http://localhost:${config.PORT}/auth?code=<b style="color:#26de81;">PASTE_YOUR_CODE_HERE</b></pre>
            </body>
            </html>
        `);
    }

    console.log(`\n🔑 Received auth code: ${code.substring(0, 10)}...`);
    const success = await upstox.exchangeCode(code);

    if (success) {
        // Start live WebSocket stream
        const session = upstox.getSession();
        if (session.accessToken && !streamer) {
            streamer = live.startStream(session.accessToken);
        }
        // Backfill today's data from 9:15 AM
        setTimeout(async () => { await live.backfillHistory(); }, 3000);
        res.redirect('/');
    } else {
        res.send(`
            <html>
            <body style="background:#06080e;color:#e6edf3;font-family:monospace;padding:40px;text-align:center;">
                <h2 style="color:#fc5c65;">❌ Login Failed</h2>
                <p>Code may have expired. Try again:</p>
                <a href="/login" style="color:#f7b731;font-size:18px;">🔐 Login Again</a>
            </body>
            </html>
        `);
    }
});

// ═══════════════════════════════════════
// ROUTE 3: /api/range — Main data API
// ═══════════════════════════════════════
app.get('/api/range', async (req, res) => {
    try {
        const now = Date.now();

        // Return cache if fresh
        if (cache.data && (now - cache.time) < config.CACHE_SECONDS * 1000) {
            return res.json(cache.data);
        }

        // Check login status
        const s = upstox.getSession();
        if (!s.isLoggedIn) {
            return res.status(401).json({
                success: false,
                error: 'Not logged in to Upstox',
                loginUrl: `http://localhost:${config.PORT}/login`,
                tip: 'Open the loginUrl in browser first, then come back',
            });
        }

        // Fetch from Upstox
        const { nifty, vix } = await upstox.getNiftyAndVIX();

        if (!nifty || !vix) {
            throw new Error('Could not fetch Nifty or VIX data');
        }

        // Calculate DTE
        const dte = calculateDTE(req.query.expiry);

        // Calculate ranges
        const annualVol = vix.ltp / 100;
        const timeFactor = Math.sqrt(dte / 365);
        const m1 = nifty.ltp * annualVol * timeFactor;
        const m2 = m1 * 2;
        const m3 = m1 * 3;
        const daily = nifty.ltp * annualVol / Math.sqrt(365);
        const r50 = v => Math.round(v / 50) * 50;

        const result = {
            success: true,
            timestamp: new Date().toISOString(),
            source: 'Upstox API v2',
            market: {
                nifty: nifty.ltp,
                niftyOpen: nifty.open,
                niftyHigh: nifty.high,
                niftyLow: nifty.low,
                change: nifty.change,
                pctChange: nifty.pctChange,
                vix: vix.ltp,
                vixOpen: vix.open,
                vixHigh: vix.high,
                vixLow: vix.low,
                vixChange: vix.pctChange,
            },
            config: { dte },
            ranges: {
                daily: { points: +daily.toFixed(2), lower: +(nifty.ltp - daily).toFixed(2), upper: +(nifty.ltp + daily).toFixed(2) },
                sd1: { points: +m1.toFixed(2), lower: +(nifty.ltp - m1).toFixed(2), upper: +(nifty.ltp + m1).toFixed(2), lowerStrike: r50(nifty.ltp - m1), upperStrike: r50(nifty.ltp + m1), prob: 68.27 },
                sd2: { points: +m2.toFixed(2), lower: +(nifty.ltp - m2).toFixed(2), upper: +(nifty.ltp + m2).toFixed(2), lowerStrike: r50(nifty.ltp - m2), upperStrike: r50(nifty.ltp + m2), prob: 95.45 },
                sd3: { points: +m3.toFixed(2), lower: +(nifty.ltp - m3).toFixed(2), upper: +(nifty.ltp + m3).toFixed(2), lowerStrike: r50(nifty.ltp - m3), upperStrike: r50(nifty.ltp + m3), prob: 99.73 },
            },
        };

        cache = { data: result, time: now };
        res.json(result);

    } catch (err) {
        console.error('❌ API Error:', err.message);

        if (cache.data) {
            return res.json({ ...cache.data, stale: true, note: err.message });
        }

        if (err.message.includes('expired') || err.message.includes('login')) {
            return res.status(401).json({
                success: false,
                error: err.message,
                loginUrl: `http://localhost:${config.PORT}/login`,
            });
        }

        res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════
// ROUTE 5: /api/stream — SSE Live Stream
// ═══════════════════════════════════════
// Frontend connects here for real-time updates
app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    // Send initial data
    const initial = live.buildRangeData();
    res.write(`data: ${JSON.stringify(initial)}\n\n`);

    // Register client for live updates
    live.addSSEClient(res);

    // Cleanup on disconnect
    req.on('close', () => {
        live.removeSSEClient(res);
    });
});

// ═══════════════════════════════════════
// ROUTE: /api/history — Full day tick history
// ═══════════════════════════════════════
app.get('/api/history', (req, res) => {
    const history = live.getTickHistory();
    res.json({ success: true, count: history.length, ticks: history });
});

// ═══════════════════════════════════════
// ROUTE: /api/backfill — Manually trigger backfill
// ═══════════════════════════════════════
app.get('/api/backfill', async (req, res) => {
    try {
        const count = await live.backfillHistory();
        const history = live.getTickHistory();
        res.json({
            success: true,
            backfilled: count,
            totalTicks: history.length,
            firstTick: history[0]?.t || 'none',
            lastTick: history[history.length - 1]?.t || 'none',
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════
// ROUTE: /api/candles — Debug candle API
// ═══════════════════════════════════════
app.get('/api/candles', async (req, res) => {
    try {
        const niftyDebug = await upstox.debugCandleAPI(config.NIFTY_KEY);
        const vixDebug = await upstox.debugCandleAPI(config.VIX_KEY);
        res.json({
            success: true,
            serverTime: new Date().toISOString(),
            niftyKey: config.NIFTY_KEY,
            vixKey: config.VIX_KEY,
            nifty: niftyDebug,
            vix: vixDebug,
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════
// ROUTE 4: /api/status — Check status
// ═══════════════════════════════════════
app.get('/api/status', (req, res) => {
    const s = upstox.getSession();
    res.json({
        loggedIn: s.isLoggedIn,
        tokenExpiry: s.expiresAt,
        cacheAge: cache.time ? Math.round((Date.now() - cache.time) / 1000) + 's' : 'empty',
        loginUrl: `http://localhost:${config.PORT}/login`,
    });
});

// ─── DTE Calculator ───
function calculateDTE(expiryStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (expiryStr) {
        const expiry = new Date(expiryStr);
        return Math.max(1, Math.ceil((expiry - today) / (1000 * 60 * 60 * 24)));
    }

    // Auto: last Thursday of current month
    const year = today.getFullYear();
    let month = today.getMonth();

    function lastThursday(y, m) {
        const d = new Date(y, m + 1, 0);
        while (d.getDay() !== 2) d.setDate(d.getDate() - 1);
        return d;
    }

    let expiry = lastThursday(year, month);
    if (today > expiry) expiry = lastThursday(year, month + 1);

    return Math.max(1, Math.ceil((expiry - today) / (1000 * 60 * 60 * 24)));
}

// ═══════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════
async function start() {
    // Try loading saved token
    const hasToken = upstox.loadToken();

    // Start WebSocket if token available
    if (hasToken) {
        const session = upstox.getSession();
        if (session.accessToken) {
            streamer = live.startStream(session.accessToken);

            // Backfill 9:15 AM onwards candle data
            setTimeout(async () => {
                await live.backfillHistory();
            }, 3000); // Wait 3s for WebSocket to connect
        }
    }

    app.listen(config.PORT, () => {
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║  🚀 NIFTY VIX RANGE CALCULATOR — UPSTOX API              ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  🌐 Website:   http://localhost:${config.PORT}                   ║
║  📡 API:       http://localhost:${config.PORT}/api/range          ║
║  📊 Status:    http://localhost:${config.PORT}/api/status         ║
║                                                           ║
${hasToken
? '║  ✅ Token loaded — Ready to fetch live data!              ║'
: '║  ⚠  Not logged in yet. Follow steps below:               ║'}
║                                                           ║
${!hasToken ? `║  STEP 1: Open in browser:                                 ║
║     http://localhost:${config.PORT}/login                        ║
║                                                           ║
║  STEP 2: Login to Upstox (UCC + Password + DOB)          ║
║                                                           ║
║  STEP 3: After login, browser goes to:                    ║
║     https://127.0.0.1?code=aBcDeF123                     ║
║     ↑ Page won't load — THAT'S OK!                        ║
║     Just COPY the code value from URL                     ║
║                                                           ║
║  STEP 4: Open in browser:                                 ║
║     http://localhost:${config.PORT}/auth?code=PASTE_CODE_HERE    ║
║                                                           ║
║  STEP 5: Done! Website auto-loads with live data          ║
║                                                           ║` : ''}║  🔄 Cache: ${config.CACHE_SECONDS}s | Token: valid ~24hrs (daily login)    ║
╚═══════════════════════════════════════════════════════════╝
        `);
    });
}

start();
