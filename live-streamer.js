// ==========================================
// UPSTOX LIVE STREAMER — WebSocket V3
// ==========================================
// Real-time Nifty + VIX streaming via Upstox SDK
// Pushes updates to frontend via SSE (Server-Sent Events)

const UpstoxClient = require('upstox-js-sdk');
const config = require('./config');

// ─── Live Data Store ───
let liveData = {
    nifty: { ltp: 0, open: 0, high: 0, low: 0, close: 0, change: 0, pctChange: 0 },
    vix:   { ltp: 0, open: 0, high: 0, low: 0, close: 0, change: 0, pctChange: 0 },
    lastUpdate: null,
    connected: false,
};

// SSE clients (browsers listening for live updates)
let sseClients = [];

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

// ─── SSE: Push to all connected browsers ───
function broadcastToClients() {
    const payload = JSON.stringify(buildRangeData());

    sseClients = sseClients.filter(client => {
        try {
            client.write(`data: ${payload}\n\n`);
            return true;
        } catch {
            return false; // Remove dead connections
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
        return Math.max(1, Math.ceil((expiry - today) / (1000 * 60 * 60 * 24)) + 1);
    }

    const year = today.getFullYear();
    let month = today.getMonth();

    function lastThursday(y, m) {
        const d = new Date(y, m + 1, 0);
        while (d.getDay() !== 4) d.setDate(d.getDate() - 1);
        return d;
    }

    let expiry = lastThursday(year, month);
    if (today > expiry) expiry = lastThursday(year, month + 1);

    return Math.max(1, Math.ceil((expiry - today) / (1000 * 60 * 60 * 24)) + 1);
}

module.exports = {
    startStream,
    getLiveData: () => liveData,
    buildRangeData,
    calculateDTE,
    addSSEClient: (client) => sseClients.push(client),
    removeSSEClient: (client) => { sseClients = sseClients.filter(c => c !== client); },
};
