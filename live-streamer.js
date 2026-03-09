// ==========================================
// UPSTOX LIVE STREAMER — WebSocket V3
// ==========================================
// Real-time Nifty + VIX streaming via Upstox SDK
// Pushes updates to frontend via SSE (Server-Sent Events)

const UpstoxClient = require('upstox-js-sdk');
const config = require('./config');
const upstox = require('./upstox-api');

// ─── Live Data Store ───
let liveData = {
    nifty: { ltp: 0, open: 0, high: 0, low: 0, close: 0, change: 0, pctChange: 0 },
    vix:   { ltp: 0, open: 0, high: 0, low: 0, close: 0, change: 0, pctChange: 0 },
    lastUpdate: null,
    connected: false,
};

// SSE clients (browsers listening for live updates)
let sseClients = [];

// ─── Tick History (saved to file — persists across restarts) ───
const fs = require('fs');
const path = require('path');
const HISTORY_DIR = path.join(__dirname, 'data');
let tickHistory = [];
let lastHistoryDate = null;
let saveTimer = null;

// Ensure data directory exists
if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    console.log('📁 Created data/ directory');
}

function getTodayFileName() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return path.join(HISTORY_DIR, `ticks-${yyyy}-${mm}-${dd}.json`);
}

function loadTodayHistory() {
    const file = getTodayFileName();
    try {
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            tickHistory = JSON.parse(raw);
            lastHistoryDate = new Date().toDateString();
            console.log(`📊 Loaded ${tickHistory.length} ticks from ${path.basename(file)}`);
        } else {
            tickHistory = [];
            lastHistoryDate = new Date().toDateString();
            console.log('📊 No history file for today, starting fresh');
        }
    } catch (err) {
        console.error('❌ Error loading history:', err.message);
        tickHistory = [];
        lastHistoryDate = new Date().toDateString();
    }
}

function saveHistoryToFile() {
    const file = getTodayFileName();
    try {
        fs.writeFileSync(file, JSON.stringify(tickHistory));
    } catch (err) {
        console.error('❌ Error saving history:', err.message);
    }
}

// Debounced save — saves every 5 seconds (not every tick, to avoid I/O overload)
function scheduleSave() {
    if (!saveTimer) {
        saveTimer = setTimeout(() => {
            saveHistoryToFile();
            saveTimer = null;
        }, 5000);
    }
}

// Clean old files (keep only last 7 days)
function cleanOldFiles() {
    try {
        const files = fs.readdirSync(HISTORY_DIR).filter(f => f.startsWith('ticks-') && f.endsWith('.json'));
        const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
        files.forEach(f => {
            const dateStr = f.replace('ticks-', '').replace('.json', '');
            const fileDate = new Date(dateStr).getTime();
            if (fileDate < cutoff) {
                fs.unlinkSync(path.join(HISTORY_DIR, f));
                console.log(`🗑️ Deleted old history: ${f}`);
            }
        });
    } catch (err) { /* ignore */ }
}

function resetHistoryIfNewDay() {
    const today = new Date().toDateString();
    if (lastHistoryDate !== today) {
        // Save yesterday's final data
        if (tickHistory.length > 0) {
            saveHistoryToFile();
        }
        tickHistory = [];
        lastHistoryDate = today;
        cleanOldFiles();
        console.log('📊 Tick history reset for new day:', today);
    }
}

function addToHistory(rangeData) {
    resetHistoryIfNewDay();
    tickHistory.push({
        t: new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false }),
        ts: Date.now(),
        spot: rangeData.market.nifty,
        vix: rangeData.market.vix,
        chg: rangeData.market.change,
        pct: rangeData.market.pctChange,
        dte: rangeData.config.dte,
        sd1U: rangeData.ranges.sd1.upper,
        sd1L: rangeData.ranges.sd1.lower,
        sd2U: rangeData.ranges.sd2.upper,
        sd2L: rangeData.ranges.sd2.lower,
        sd3U: rangeData.ranges.sd3.upper,
        sd3L: rangeData.ranges.sd3.lower,
    });
    scheduleSave();
}

// Load today's history on startup
loadTodayHistory();

// ─── Start WebSocket Stream ───
function startStream(accessToken) {
    try {
        let defaultClient = UpstoxClient.ApiClient.instance;
        let OAUTH2 = defaultClient.authentications['OAUTH2'];
        OAUTH2.accessToken = accessToken;

        // Create V3 streamer with Nifty 50 + India VIX
        const streamer = new UpstoxClient.MarketDataStreamerV3(
            [config.NIFTY_KEY, config.VIX_KEY],
            'full'
        );

        // Auto-reconnect: enabled, 5sec interval, 50 retries
        streamer.autoReconnect(true, 5, 50);

        streamer.on('open', () => {
            console.log('🟢 WebSocket CONNECTED — Live streaming started!');
            liveData.connected = true;
        });

        streamer.on('message', (rawData) => {
            try {
                const data = JSON.parse(rawData.toString('utf-8'));

                if (data.feeds) {
                    processFeed(data.feeds);
                }
            } catch (err) {
                // Binary/protobuf data — skip silently
            }
        });

        streamer.on('error', (err) => {
            console.error('🔴 WebSocket error:', err.message || err);
            liveData.connected = false;
        });

        streamer.on('close', () => {
            console.log('🟡 WebSocket disconnected');
            liveData.connected = false;
        });

        streamer.on('autoReconnectStopped', () => {
            console.log('🔴 Auto-reconnect stopped. Manual restart needed.');
            liveData.connected = false;
        });

        streamer.connect();
        console.log('🔄 Connecting to Upstox WebSocket...');

        return streamer;

    } catch (err) {
        console.error('❌ Stream start error:', err.message);
        return null;
    }
}

// ─── Process incoming feed data ───
function processFeed(feeds) {
    let updated = false;

    // Nifty 50
    const niftyFeed = feeds[config.NIFTY_KEY];
    if (niftyFeed) {
        const ff = niftyFeed.ff || niftyFeed.fullFeed || {};
        const idx = ff.indexFF || ff.ltpc || ff;
        const ltpc = niftyFeed.ltpc || idx.ltpc || {};
        const ohlc = idx.ohlc || ff.ohlc || {};

        const ltp = ltpc.ltp || idx.ltp || niftyFeed.ltp || 0;
        const close = ltpc.cp || ohlc.close || liveData.nifty.close || 0;

        if (ltp > 0) {
            liveData.nifty = {
                ltp: ltp,
                open: ohlc.open || liveData.nifty.open,
                high: ohlc.high || liveData.nifty.high,
                low: ohlc.low || liveData.nifty.low,
                close: close || liveData.nifty.close,
                change: +(ltp - close).toFixed(2),
                pctChange: close > 0 ? +((ltp - close) / close * 100).toFixed(2) : 0,
            };
            updated = true;
        }
    }

    // India VIX
    const vixFeed = feeds[config.VIX_KEY];
    if (vixFeed) {
        const ff = vixFeed.ff || vixFeed.fullFeed || {};
        const idx = ff.indexFF || ff.ltpc || ff;
        const ltpc = vixFeed.ltpc || idx.ltpc || {};
        const ohlc = idx.ohlc || ff.ohlc || {};

        const ltp = ltpc.ltp || idx.ltp || vixFeed.ltp || 0;
        const close = ltpc.cp || ohlc.close || liveData.vix.close || 0;

        if (ltp > 0) {
            liveData.vix = {
                ltp: ltp,
                open: ohlc.open || liveData.vix.open,
                high: ohlc.high || liveData.vix.high,
                low: ohlc.low || liveData.vix.low,
                close: close || liveData.vix.close,
                change: +(ltp - close).toFixed(2),
                pctChange: close > 0 ? +((ltp - close) / close * 100).toFixed(2) : 0,
            };
            updated = true;
        }
    }

    if (updated) {
        liveData.lastUpdate = new Date().toISOString();
        broadcastToClients();
    }
}

// ─── SSE: Push to all connected browsers (every 1 second) ───
let lastBroadcastTime = 0;
let broadcastTimer = null;
const BROADCAST_INTERVAL = 1000; // 1 second

function broadcastToClients() {
    const now = Date.now();

    if (now - lastBroadcastTime >= BROADCAST_INTERVAL) {
        doActualBroadcast();
    } else if (!broadcastTimer) {
        const remaining = BROADCAST_INTERVAL - (now - lastBroadcastTime);
        broadcastTimer = setTimeout(() => {
            broadcastTimer = null;
            doActualBroadcast();
        }, remaining);
    }
}

function doActualBroadcast() {
    lastBroadcastTime = Date.now();
    const rangeData = buildRangeData();
    const payload = JSON.stringify(rangeData);

    // Store tick in history
    if (rangeData.success) {
        addToHistory(rangeData);
    }

    sseClients = sseClients.filter(client => {
        try {
            client.write(`data: ${payload}\n\n`);
            return true;
        } catch {
            return false;
        }
    });
}

// ─── Build range data from live prices ───
function buildRangeData(customDTE) {
    const n = liveData.nifty;
    const v = liveData.vix;

    if (!n.ltp || !v.ltp) {
        return { success: false, error: 'Waiting for data...' };
    }

    const dte = customDTE || calculateDTE();
    const annualVol = v.ltp / 100;
    const timeFactor = Math.sqrt(dte / 365);

    const m1 = n.ltp * annualVol * timeFactor;
    const m2 = m1 * 2;
    const m3 = m1 * 3;
    const daily = n.ltp * annualVol / Math.sqrt(365);
    const r50 = val => Math.round(val / 50) * 50;

    return {
        success: true,
        timestamp: liveData.lastUpdate,
        source: 'Upstox WebSocket V3 (LIVE)',
        connected: liveData.connected,
        market: {
            nifty: n.ltp,
            niftyOpen: n.open, niftyHigh: n.high, niftyLow: n.low,
            change: n.change, pctChange: n.pctChange,
            vix: v.ltp,
            vixOpen: v.open, vixHigh: v.high, vixLow: v.low,
            vixChange: v.pctChange,
        },
        config: { dte },
        ranges: {
            daily: { points: +daily.toFixed(2), lower: +(n.ltp - daily).toFixed(2), upper: +(n.ltp + daily).toFixed(2) },
            sd1: { points: +m1.toFixed(2), lower: +(n.ltp - m1).toFixed(2), upper: +(n.ltp + m1).toFixed(2), lowerStrike: r50(n.ltp - m1), upperStrike: r50(n.ltp + m1), prob: 68.27 },
            sd2: { points: +m2.toFixed(2), lower: +(n.ltp - m2).toFixed(2), upper: +(n.ltp + m2).toFixed(2), lowerStrike: r50(n.ltp - m2), upperStrike: r50(n.ltp + m2), prob: 95.45 },
            sd3: { points: +m3.toFixed(2), lower: +(n.ltp - m3).toFixed(2), upper: +(n.ltp + m3).toFixed(2), lowerStrike: r50(n.ltp - m3), upperStrike: r50(n.ltp + m3), prob: 99.73 },
        },
    };
}

function calculateDTE(expiryStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (expiryStr) {
        const expiry = new Date(expiryStr);
        return Math.max(1, Math.ceil((expiry - today) / (1000 * 60 * 60 * 24)));
    }

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

// ─── Backfill from Upstox Historical Candles ───
async function backfillHistory() {
    try {
        console.log('🔄 Backfilling today\'s data from Upstox candle API...');

        const [niftyCandles, vixCandles] = await Promise.all([
            upstox.getIntradayCandles(config.NIFTY_KEY, '1minute'),
            upstox.getIntradayCandles(config.VIX_KEY, '1minute'),
        ]);

        console.log(`📊 Nifty candles: ${niftyCandles.length} | VIX candles: ${vixCandles.length}`);

        if (!niftyCandles.length) {
            console.log('⚠ No Nifty candles (market may be closed or holiday)');
            return 0;
        }

        // Upstox candles: [timestamp, open, high, low, close, volume, oi]
        // They come REVERSE order (latest first) — sort by time ascending

        function parseCandle(c) {
            const d = new Date(c[0]);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            return {
                timeKey: `${hh}:${mm}`,           // HH:MM for matching
                timeLabel: `${hh}:${mm}:${ss}`,   // HH:MM:SS for display
                ts: d.getTime(),
                open: c[1], high: c[2], low: c[3], close: c[4],
            };
        }

        // Parse and sort ascending
        const niftyParsed = niftyCandles.map(parseCandle).sort((a, b) => a.ts - b.ts);
        const vixParsed = vixCandles.map(parseCandle).sort((a, b) => a.ts - b.ts);

        console.log(`   Nifty: ${niftyParsed[0]?.timeLabel} → ${niftyParsed[niftyParsed.length-1]?.timeLabel}`);
        console.log(`   VIX:   ${vixParsed[0]?.timeLabel} → ${vixParsed[vixParsed.length-1]?.timeLabel}`);

        // Build VIX lookup by HH:MM
        const vixByMin = {};
        vixParsed.forEach(v => { vixByMin[v.timeKey] = v; });

        // Prev close = first candle open price
        const prevClose = niftyParsed[0] ? niftyParsed[0].open : 0;

        // Get existing time keys to skip duplicates
        const existingKeys = new Set(tickHistory.map(t => t.t.substring(0, 5))); // HH:MM

        const dte = calculateDTE();
        let added = 0;
        let lastVix = vixParsed[0] ? vixParsed[0].close : 15; // fallback VIX

        niftyParsed.forEach(n => {
            // Skip if already have this minute
            if (existingKeys.has(n.timeKey)) return;

            const spot = n.close;

            // Find VIX for this minute, or use last known VIX
            const v = vixByMin[n.timeKey];
            const vix = v ? v.close : lastVix;
            if (v) lastVix = v.close;

            const chg = prevClose > 0 ? +(spot - prevClose).toFixed(2) : 0;
            const pct = prevClose > 0 ? +((spot - prevClose) / prevClose * 100).toFixed(2) : 0;

            // Calculate σ ranges
            const av = vix / 100;
            const tf = Math.sqrt(dte / 365);
            const m1 = spot * av * tf;
            const m2 = m1 * 2;
            const m3 = m1 * 3;

            tickHistory.push({
                t: n.timeLabel,
                ts: n.ts,
                spot,
                vix,
                chg,
                pct,
                dte,
                sd1U: +(spot + m1).toFixed(2),
                sd1L: +(spot - m1).toFixed(2),
                sd2U: +(spot + m2).toFixed(2),
                sd2L: +(spot - m2).toFixed(2),
                sd3U: +(spot + m3).toFixed(2),
                sd3L: +(spot - m3).toFixed(2),
            });
            added++;
        });

        // Sort all ticks by timestamp
        tickHistory.sort((a, b) => {
            if (a.ts && b.ts) return a.ts - b.ts;
            return a.t.localeCompare(b.t);
        });

        // Save
        if (added > 0) {
            saveHistoryToFile();
            console.log(`✅ Backfilled ${added} candles | Total history: ${tickHistory.length} ticks`);
        } else {
            console.log('📊 All candles already in history');
        }

        return added;
    } catch (err) {
        console.error('❌ Backfill error:', err.message);
        return 0;
    }
}

module.exports = {
    startStream,
    getLiveData: () => liveData,
    buildRangeData,
    calculateDTE,
    addSSEClient: (client) => sseClients.push(client),
    removeSSEClient: (client) => { sseClients = sseClients.filter(c => c !== client); },
    getTickHistory: () => tickHistory,
    backfillHistory,
};
