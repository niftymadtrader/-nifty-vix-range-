// ==========================================
// UPSTOX API CONFIGURATION
// ==========================================
// Local: Fill values below directly
// Render/Cloud: Set these as Environment Variables

module.exports = {
    API_KEY:        process.env.UPSTOX_API_KEY      || 'YOUR_API_KEY_HERE',
    API_SECRET:     process.env.UPSTOX_API_SECRET   || 'YOUR_API_SECRET_HERE',
    REDIRECT_URI:   process.env.UPSTOX_REDIRECT_URI || 'https://127.0.0.1',

    // Upstox API Endpoints
    AUTH_URL:       'https://api.upstox.com/v2/login/authorization/dialog',
    TOKEN_URL:      'https://api.upstox.com/v2/login/authorization/token',
    QUOTE_URL:      'https://api.upstox.com/v2/market-quote/quotes',
    LTP_URL:        'https://api.upstox.com/v2/market-quote/ltp',

    // Instrument Keys
    NIFTY_KEY:      'NSE_INDEX|Nifty 50',
    VIX_KEY:        'NSE_INDEX|India VIX',
    BANKNIFTY_KEY:  'NSE_INDEX|Nifty Bank',

    // Server
    PORT: process.env.PORT || 3000,
    CACHE_SECONDS: 60,
};
