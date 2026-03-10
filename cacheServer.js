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

// caches extras (preços e stats) para fornecer ao bot
const priceStore = new Map();   // symbol -> lastPrice
const statsStore = new Map();   // symbol -> { lowPrice, highPrice, ... }

// chaves de tracking em memória para evitar polls duplicados
const trackers = new Map(); // key -> timerId

// caches adicionais para preços e 24h stats
// usamos hset/hget no Redis, ou Maps locais se Redis indisponível

// no Redis usaremos as hashes 'prices' e 'stats24h'

// cache de exchangeInfo para evitar várias chamadas
let exchangeInfoCache = null;

// cache de trade fees similares ao bot
let tradeFeeCache = { ts: 0, data: {} };

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
        // também atualiza stats 24h sempre que houver poll de candles
        await update24h(symbol);
    } catch (err) {
        console.warn(`Falha ao buscar candles ${symbol}@${interval}:`, err.message || err);
    }
}

// helpers para manter preço e stats atualizados
function subscribePrice(symbol) {
    if (priceStore.has(symbol)) return;
    priceStore.set(symbol, null);
    binance.ws.ticker(symbol, ticker => {
        const p = parseFloat(ticker.lastPrice || ticker.curDayClosePrice || ticker.close || 0);
        if (useRedis) redisClient.hSet('prices', symbol, String(p)).catch(() => { });
        priceStore.set(symbol, p);
    });
}

async function update24h(symbol) {
    try {
        const stats = await binance.dailyStats({ symbol });
        if (useRedis) await redisClient.hSet('stats24h', symbol, JSON.stringify(stats));
        statsStore.set(symbol, stats);
    } catch (e) {
        console.warn('Falha ao obter stats 24h para', symbol, e.message || e);
    }
}

function trackSymbol(symbol, interval) {
    const key = `${symbol}:${interval}`;
    if (trackers.has(key)) return;

    // garante que preço e stats sejam assinados/atualizados
    subscribePrice(symbol);
    update24h(symbol);

    pollCandles(symbol, interval);
    const timer = setInterval(() => pollCandles(symbol, interval), POLL_INTERVAL);
    trackers.set(key, timer);
    console.log(`🛠️  Iniciada monitoração de ${symbol}@${interval}`);
}

const app = express();

// endpoints adicionais para dados de mercado centralizados
app.get('/price', async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).send('symbol é obrigatório');
    let p;
    try {
        if (useRedis) {
            p = await redisClient.hGet('prices', symbol);
        }
        if (!p) p = priceStore.get(symbol);
        if (p === undefined || p === null) return res.status(404).send('preço não disponível');
        res.json({ price: parseFloat(p) });
    } catch (err) {
        console.error('erro em /price', err.message || err);
        res.status(500).send('erro interno');
    }
});

app.get('/stats24h', async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).send('symbol é obrigatório');
    let data;
    try {
        if (useRedis) {
            const json = await redisClient.hGet('stats24h', symbol);
            if (json) data = JSON.parse(json);
        }
        if (!data) data = statsStore.get(symbol);
        if (!data) return res.status(404).send('stats vazio');
        res.json(data);
    } catch (err) {
        console.error('erro em /stats24h', err.message || err);
        res.status(500).send('erro interno');
    }
});

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

// endpoint para consultar exchangeInfo (cache simples)
app.get('/exchangeInfo', async (req, res) => {
    const { symbol } = req.query;
    try {
        if (!exchangeInfoCache) {
            exchangeInfoCache = await binance.exchangeInfo();
        }
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

// endpoint para taxas de trade
app.get('/tradeFee', async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).send('symbol é obrigatório');
    try {
        const now = Date.now();
        if (tradeFeeCache.data[symbol] && (now - tradeFeeCache.ts < 10 * 60 * 1000)) {
            return res.json(tradeFeeCache.data[symbol]);
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

// não há mais handlers de stats duplicados; endpoints já definidos acima

(async () => {
    await createRedis();
    // for compatibility with IPv4 clients (e.g. curl on Windows), bind to 0.0.0.0
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🔌 cacheServer rodando na porta ${PORT}`);
        console.log(`Usando Redis em ${REDIS_URL}`);
    });
})();
