// cacheServer.js — versão final (miniTicker, on-demand, sem polling REST)

require('dotenv').config({ override: true });
const express = require('express');
const Binance = require('binance-api-node').default;
const redis = require('redis');

// ---------- Config ----------
const PORT = process.env.CACHE_PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60 * 1000; // 1 minuto
const MAX_CANDLES = 500; // quantas velas manter em cache
// ---------- Clients ----------
const binance = Binance({
    apiKey: process.env.BINANCE_API_KEY || undefined,
    apiSecret: process.env.BINANCE_API_SECRET || undefined,
});

let redisClient = null;
let useRedis = true;
const inMemoryStore = new Map();

let redisReconnectTimer = null;
let redisReconnectDelay = 5000;
const REDIS_RECONNECT_MAX = 60000;

// ---------- Stores ----------
const priceStore = new Map();
const statsStore = new Map();
const trackers = new Map();
const lastInvalidLogTs = new Map();
const INVALID_LOG_THROTTLE_MS = 60 * 1000;

// ---------- Utils ----------
function nowTs() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}-${d.getFullYear()}]`;
}

// ---------- Redis ----------
async function createRedis() {
    try {
        redisClient = redis.createClient({
            url: REDIS_URL,
            socket: { reconnectStrategy: retries => Math.min(retries * 100, 10000) },
        });
        redisClient.removeAllListeners('error');
        redisClient.removeAllListeners('end');
        redisClient.on('error', err => {
            if (useRedis) console.error('Redis error', err.code || err.message || err);
            useRedis = false;
            scheduleRedisReconnect();
        });
        redisClient.on('end', () => { console.warn('Redis connection closed'); useRedis = false; scheduleRedisReconnect(); });
        await redisClient.connect();
        if (!useRedis) console.log(`✅ Redis conectado em ${REDIS_URL}`);
        useRedis = true;
    } catch (err) {
        console.warn(`⚠️ Não foi possível conectar ao Redis (${REDIS_URL}), usando cache em memória:`, err.code || err.message || err);
        useRedis = false;
        scheduleRedisReconnect();
    }
}
function scheduleRedisReconnect() {
    if (redisReconnectTimer) return;
    redisReconnectDelay = Math.min(redisReconnectDelay * 1.5, REDIS_RECONNECT_MAX);
    redisReconnectTimer = setTimeout(async () => {
        redisReconnectTimer = null;
        if (!useRedis) {
            console.log(`🔄 Tentando reconectar ao Redis (delay=${redisReconnectDelay}ms)`);
            try { await createRedis(); } catch (e) {
                console.warn('Reconexão falhou:', e.message || e);
                scheduleRedisReconnect();
            }
        }
    }, redisReconnectDelay);
}

// ---------- Price Subscription ----------
function subscribePrice(symbol) {
    if (priceStore.has(symbol)) return;
    priceStore.set(symbol, null);
    try {
        binance.ws.miniTicker(symbol, ticker => {
            const ts = nowTs();
            const p = parseFloat(
                ticker.c ??
                ticker.curDayClose ??
                ticker.close ??
                ticker.price ??
                ticker.lastPrice ??
                0
            );
            if (isNaN(p) || p <= 0) {
                const now = Date.now();
                const prev = lastInvalidLogTs.get(symbol) || 0;
                if (now - prev > INVALID_LOG_THROTTLE_MS) {
                    console.log(`${ts} miniTicker WS para ${symbol} veio com preço inválido (${p}), payload: ${JSON.stringify(ticker)}`);
                    lastInvalidLogTs.set(symbol, now);
                }
                return;

            }
            console.log(`${ts} miniTicker WS ${symbol} preço: ${p}`);
            if (useRedis) redisClient.hSet('prices', symbol, String(p)).catch(() => { });
            priceStore.set(symbol, p);
        });
    } catch (e) {
        console.error(`[subscribePrice] Erro ao criar miniTicker para ${symbol}:`, e.message || e);
    }
}

// ---------- Candle Polling ----------
async function pollCandles(symbol, interval) {
    try {
        const candles = await binance.candles({ symbol, interval, limit: MAX_CANDLES });
        const closes = candles.map(c => parseFloat(c.close));
        const key = `candles:${symbol}:${interval}`;
        if (useRedis) {
            try { await redisClient.set(key, JSON.stringify(closes)); }
            catch (e) {
                console.warn('Erro ao gravar Redis, caindo para memória:', e.message);
                useRedis = false;
                inMemoryStore.set(key, closes);
            }
        } else {
            inMemoryStore.set(key, closes);
        }
        console.log(`🔁 [cache] atualizado ${symbol}@${interval} (${closes.length} valores)`);
        await update24h(symbol);
    } catch (err) {
        console.warn(`Falha ao buscar candles ${symbol}@${interval}:`, err.message || err);
    }
}

// ---------- 24h Stats ----------
async function update24h(symbol) {
    try {
        const stats = await binance.dailyStats({ symbol });
        if (useRedis) await redisClient.hSet('stats24h', symbol, JSON.stringify(stats));
        statsStore.set(symbol, stats);
    } catch (e) {
        console.warn('Falha ao obter stats 24h para', symbol, e.message || e);
    }
}

// ---------- Tracker ----------
async function trackSymbol(symbol, interval) {
    const key = `${symbol}:${interval}`;
    if (trackers.has(key)) return;

    const ts = nowTs();
    console.log(`${ts} trackSymbol chamado para ${symbol}@${interval}`);

    // Preço e stats via WS
    subscribePrice(symbol);
    await update24h(symbol);

    // Candles
    pollCandles(symbol, interval);
    const timer = setInterval(() => pollCandles(symbol, interval), POLL_INTERVAL);
    trackers.set(key, timer);
    console.log(`🛠️  Iniciada monitoração de ${symbol}@${interval}`);
}

// ---------- Express ----------
const app = express();

app.get('/price', async (req, res) => {
    const ts = nowTs();
    const { symbol } = req.query;
    if (!symbol) return res.status(400).send('symbol é obrigatório');
    try {
        let p;
        if (useRedis) p = await redisClient.hGet('prices', symbol);
        if (!p) p = priceStore.get(symbol);
        if (p === undefined || p === null) {
            console.log(`[${ts}] /price ainda não disponível para ${symbol}`);
            return res.status(404).send('preço não disponível');
        }
        const num = parseFloat(p);
        if (isNaN(num) || num <= 0) {
            console.log(`${ts} /price retornou valor inválido (${p}) para ${symbol}`);
            return res.status(404).send('preço inválido');
        }
        res.json({ price: num });
    } catch (err) {
        console.error('erro em /price', err.message || err);
        res.status(500).send('erro interno');
    }
});

app.get('/stats24h', async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).send('symbol é obrigatório');
    try {
        let data;
        if (useRedis) {
            const json = await redisClient.hGet('stats24h', symbol);
            if (json) data = JSON.parse(json);
        }
        if (!data) data = statsStore.get(symbol);
        if (!data) return res.status(404).send('stats vazio');
        res.json(data);
    } catch (e) {
        console.error('erro em /stats24h', e.message || e);
        res.status(500).send('erro interno');
    }
});

app.get('/cache', async (req, res) => {
    const { symbol, interval } = req.query;
    if (!symbol || !interval) return res.status(400).send('symbol e interval são obrigatórios');

    try {
        const key = `candles:${symbol}:${interval}`;
        // assegura que o rastreamento está ativo
        if (!trackers.has(key)) await trackSymbol(symbol, interval);

        let data;
        if (useRedis) {
            try { data = await redisClient.get(key); } catch (e) { console.warn('Redis get falhou:', e.message); useRedis = false; data = null; }
            if (!data) data = inMemoryStore.get(key);
        } else {
            data = inMemoryStore.get(key);
        }
        if (!data) return res.status(404).send('cache vazio');
        try { res.json(JSON.parse(data)); }
        catch (e) {
            console.warn('JSON inválido lido do cache:', e.message);
            try { if (useRedis) redisClient.del(key).catch(() => { }); } catch (_) { }
            inMemoryStore.delete(key);
            return res.status(404).send('cache vazio');
        }
    } catch (err) {
        console.error('erro ao ler cache:', err.message || err);
        res.status(500).send('erro ao ler cache');
    }
});

app.get('/exchangeInfo', async (req, res) => {
    const { symbol } = req.query;
    try {
        if (!exchangeInfoCache) exchangeInfoCache = await binance.exchangeInfo();
        if (symbol) {
            const info = exchangeInfoCache.symbols.find(s => s.symbol === symbol);
            if (!info) return res.status(404).send('symbol não encontrado');
            return res.json(info);
        }
        res.json(exchangeInfoCache);
    } catch (e) {
        console.error('erro /exchangeInfo:', e.message || e);
        res.status(500).send('erro interno');
    }
});

let exchangeInfoCache = null;
let tradeFeeCache = { ts: 0, data: {} };

app.get('/tradeFee', async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).send('symbol é obrigatório');
    try {
        const now = Date.now();
        if (tradeFeeCache.data[symbol] && (now - tradeFeeCache.ts < 10 * 60 * 1000)) {
            return res.json(tradeFeeCache.data[symbol]);
        }
        if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
            console.warn('tradeFee pedido mas sem credencial no servidor');
            return res.status(204).end();
        }
        const fees = await binance.tradeFee({ symbol });
        tradeFeeCache.data[symbol] = fees;
        tradeFeeCache.ts = now;
        res.json(fees);
    } catch (e) {
        console.error('erro /tradeFee:', e.message || e);
        res.status(500).send('erro interno');
    }
});

// ---------- Bootstrap ----------
(async () => {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
        console.warn('⚠️ cacheServer iniciado SEM credenciais Binance (BINANCE_API_KEY/SECRET). `tradeFee` retornará 204.');
    } else {
        const mask = s => s ? `${s.slice(0, 4)}...${s.slice(-4)}` : 'n/a';
        console.log(`🔑 credenciais Binance detectadas: key=${mask(process.env.BINANCE_API_KEY)} secret=${mask(process.env.BINANCE_API_SECRET)}`);
    }

    await createRedis();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🔌 cacheServer rodando na porta ${PORT}`);
        console.log(`Usando Redis em ${REDIS_URL}`);
        // auto-rastreamento removido; cada bot solicita seus símbolos via /cache
    });

    if (!useRedis) scheduleRedisReconnect();
})();