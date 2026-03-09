// ==========================================
// UPSTOX API — Integration Module
// ==========================================
// Handles: OAuth Login, Token Management, Market Data

const axios = require('axios');
const config = require('./config');
const fs = require('fs');
const path = require('path');

// Token storage file (persists across restarts)
const TOKEN_FILE = path.join(__dirname, '.upstox_token.json');

// ─── Session State ───
let session = {
    accessToken: null,
    expiresAt: null,
    isLoggedIn: false,
};

// ─── Load saved token ───
function loadToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
            // Token valid till next trading day (~24hrs)
            if (data.accessToken && data.expiresAt && new Date(data.expiresAt) > new Date()) {
                session.accessToken = data.accessToken;
                session.expiresAt = data.expiresAt;
                session.isLoggedIn = true;
                console.log('✅ Loaded saved Upstox token (still valid)');
                return true;
            }
        }
    } catch (err) {
        console.log('No saved token found');
    }
    return false;
}

// ─── Save token to file ───
function saveToken() {
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({
            accessToken: session.accessToken,
            expiresAt: session.expiresAt,
        }));
    } catch (err) {
        console.log('Could not save token:', err.message);
    }
}

// ─── Generate Login URL (User opens in browser) ───
function getLoginURL() {
    const url = `${config.AUTH_URL}?response_type=code&client_id=${config.API_KEY}&redirect_uri=${encodeURIComponent(config.REDIRECT_URI)}`;
    return url;
}

// ─── Exchange Auth Code for Access Token ───
async function exchangeCode(authCode) {
    try {
        const response = await axios.post(config.TOKEN_URL, 
            new URLSearchParams({
                code: authCode,
                client_id: config.API_KEY,
                client_secret: config.API_SECRET,
                redirect_uri: config.REDIRECT_URI,
                grant_type: 'authorization_code',
            }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                timeout: 15000,
            }
        );

        const data = response.data;

        if (data.access_token) {
            session.accessToken = data.access_token;
            // Upstox tokens valid till next trading day (set 20hrs expiry)
            session.expiresAt = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
            session.isLoggedIn = true;

            saveToken();

            console.log('✅ Upstox Login Successful!');
            console.log(`   User: ${data.user_name || 'N/A'}`);
            console.log(`   Email: ${data.email || 'N/A'}`);
            console.log(`   Token valid till: ~next trading day`);
            return true;
        } else {
            console.error('❌ Token exchange failed:', data);
            return false;
        }
    } catch (err) {
        console.error('❌ Token exchange error:', err.response?.data?.message || err.message);
        return false;
    }
}

// ─── Get Headers ───
function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${session.accessToken}`,
    };
}

// ─── Fetch Market Quote (Full) ───
async function getQuote(instrumentKeys) {
    if (!session.isLoggedIn || !session.accessToken) {
        throw new Error('Not logged in. Please login first via /login');
    }

    // Check token expiry
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
        session.isLoggedIn = false;
        throw new Error('Token expired. Please login again via /login');
    }

    try {
        // Upstox accepts comma-separated instrument keys
        const keys = Array.isArray(instrumentKeys) ? instrumentKeys.join(',') : instrumentKeys;

        const response = await axios.get(config.QUOTE_URL, {
            params: { instrument_key: keys },
            headers: getHeaders(),
            timeout: 10000,
        });

        if (response.data.status === 'success') {
            return response.data.data;
        }

        throw new Error(response.data.message || 'Quote fetch failed');
    } catch (err) {
        if (err.response?.status === 401) {
            session.isLoggedIn = false;
            throw new Error('Token expired. Please login again via /login');
        }
        throw err;
    }
}

// ─── Get Nifty + VIX Data ───
async function getNiftyAndVIX() {
    const quotes = await getQuote([config.NIFTY_KEY, config.VIX_KEY]);

    let nifty = null;
    let vix = null;

    // Upstox returns data keyed by instrument_key
    const niftyData = quotes[config.NIFTY_KEY];
    const vixData = quotes[config.VIX_KEY];

    if (niftyData) {
        const ohlc = niftyData.ohlc || {};
        nifty = {
            ltp: niftyData.last_price,
            open: ohlc.open || 0,
            high: ohlc.high || 0,
            low: ohlc.low || 0,
            close: ohlc.close || 0,
            change: niftyData.net_change || 0,
            pctChange: +(niftyData.net_change / (ohlc.close || 1) * 100).toFixed(2),
        };
    }

    if (vixData) {
        const ohlc = vixData.ohlc || {};
        vix = {
            ltp: vixData.last_price,
            open: ohlc.open || 0,
            high: ohlc.high || 0,
            low: ohlc.low || 0,
            close: ohlc.close || 0,
            change: vixData.net_change || 0,
            pctChange: +(vixData.net_change / (ohlc.close || 1) * 100).toFixed(2),
        };
    }

    return { nifty, vix };
}

// ─── Fetch Intraday 1-min candles (for backfill) ───
async function getIntradayCandles(instrumentKey, interval = '1minute') {
    if (!session.isLoggedIn || !session.accessToken) {
        throw new Error('Not logged in');
    }

    try {
        const encodedKey = encodeURIComponent(instrumentKey);
        const url = `https://api.upstox.com/v2/historical-candle/intraday/${encodedKey}/${interval}`;

        const response = await axios.get(url, {
            headers: getHeaders(),
            timeout: 15000,
        });

        if (response.data.status === 'success') {
            return response.data.data.candles || [];
        }
        throw new Error(response.data.message || 'Candle fetch failed');
    } catch (err) {
        console.error(`❌ Intraday candle error (${instrumentKey}):`, err.response?.data?.message || err.message);
        return [];
    }
}

module.exports = {
    loadToken,
    getLoginURL,
    exchangeCode,
    getQuote,
    getNiftyAndVIX,
    getIntradayCandles,
    getSession: () => session,
};
