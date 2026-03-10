const express = require('express');
const Binance = require('binance-api-node').default;
const redis = require('redis');

// configurações básicas
const PORT = process.env.CACHE_PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60 * 1000; // 1 minuto
const MAX_CANDLES = 500; // quantas velas manter em cache

// clientes
const binance = Binance();
let redisClient = null;
let useRedis = true;          // indicador se Redis está disponível
const inMemoryStore = new Map(); // fallback se Redis cair

// chaves de tracking em memória para evitar polls duplicados
const trackers = new Map(); // key -> timerId

async function createRedis() {
    try {
        redisClient = redis.createClient({
            url: REDIS_URL,
            socket: { reconnectStrategy: () => false }
        });
        redisClient.on('error', err => {
            if (useRedis) console.error('Redis error', err.code || err.message || err);
            useRedis = false;
        });
        await redisClient.connect();
        useRedis = true;
        console.log(`✅ Redis conectado em ${REDIS_URL}`);
    } catch (err) {
        console.warn(`⚠️ Não foi possível conectar ao Redis (${REDIS_URL}), usando cache em memória:`, err.code || err.message || err);
        useRedis = false;
    }
}

async function pollCandles(symbol, interval) {
    try {
        const candles = await binance.candles({ symbol, interval, limit: MAX_CANDLES });
        const closes = candles.map(c => parseFloat(c.close));
        const key = `candles:${symbol}:${interval}`;
        if (useRedis) {
            try {
                await redisClient.set(key, JSON.stringify(closes));
            } catch (e) {
                console.warn('Erro ao gravar Redis, caindo para memória:', e.message);
                useRedis = false;
                inMemoryStore.set(key, closes);
            }
        } else {
            inMemoryStore.set(key, closes);
        }
        console.log(`🔁 [cache] atualizado ${symbol}@${interval} (${closes.length} valores)`);
    } catch (err) {
        console.warn(`Falha ao buscar candles ${symbol}@${interval}:`, err.message || err);
    }
}

function trackSymbol(symbol, interval) {
    const key = `${symbol}:${interval}`;
    if (trackers.has(key)) return;

    pollCandles(symbol, interval);
    const timer = setInterval(() => pollCandles(symbol, interval), POLL_INTERVAL);
    trackers.set(key, timer);
    console.log(`🛠️  Iniciada monitoração de ${symbol}@${interval}`);
}

const app = express();

app.get('/cache', async (req, res) => {
    const { symbol, interval } = req.query;
    if (!symbol || !interval) return res.status(400).send('symbol e interval são obrigatórios');

    trackSymbol(symbol, interval);
    const key = `candles:${symbol}:${interval}`;

    // trackSymbol já dispara um poll imediato na primeira vez, portanto não
    // precisamos chamar pollCandles() novamente aqui – isso evita duplicados.

    try {
        let data;
        if (useRedis) {
            data = await redisClient.get(key);
            if (!data) data = inMemoryStore.get(key);
        } else {
            data = inMemoryStore.get(key);
        }
        if (!data) return res.status(404).send('cache vazio');
        res.json(JSON.parse(data));
    } catch (err) {
        console.error('erro ao ler cache:', err.message || err);
        res.status(500).send('erro ao ler cache');
    }
});

(async () => {
    await createRedis();
    // for compatibility with IPv4 clients (e.g. curl on Windows), bind to 0.0.0.0
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🔌 cacheServer rodando na porta ${PORT}`);
        console.log(`Usando Redis em ${REDIS_URL}`);
    });
})();
