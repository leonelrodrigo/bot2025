
const Binance = require('binance-api-node').default;
const { RSI } = require('technicalindicators');
const redis = require('redis');

// vamos precisar de um cliente Redis para ler o cache
// configure Redis client with no reconnect attempts to avoid repeated ECONNREFUSED spamming
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: {
        reconnectStrategy: () => false // never try to reconnect automatically
    }
});
let useRedis = true;
redisClient.on('error', err => {
    // only log once, then disable
    if (useRedis) {
        console.error('Redis error', err.code || err.message || err);
    }
    useRedis = false;
});
(async () => {
    try {
        await redisClient.connect();
        console.log('✅ Conectado ao Redis para RSI');
    } catch (e) {
        console.warn('Falha ao conectar Redis (RSI) – usando fallback:', e.code || e.message || e);
        useRedis = false;
    }
})();

// O binance client só permanece para compatibilidade caso precise de fallback
const client = Binance();

let getValue = async function (symbol, interval, rsiPeriod) {
    let rsi = null;

    try {
        // primeiro tentamos ler do cache Redis
        const key = `candles:${symbol}:${interval}`;
        let closes = [];
        if (useRedis) {
            try {
                const cached = await redisClient.get(key);
                if (cached) {
                    closes = JSON.parse(cached);
                }
            } catch (re) {
                console.warn('Erro ao ler Redis, caindo para REST:', re.message || re);
                useRedis = false;
            }
        }

        // se não tinha dados ou eram insuficientes, tentamos primeiro acionar o cache server
        if (closes.length < rsiPeriod) {
            try {
                // padrão atualizado para 4000 (usa mesma porta do cacheServer)
                const port = process.env.CACHE_PORT || 4000;
                await fetch(`http://localhost:${port}/cache?symbol=${symbol}&interval=${interval}`);
                // depois de acionar, lemos de novo do Redis (se ainda estiver habilitado)
                if (useRedis) {
                    const cached2 = await redisClient.get(key);
                    if (cached2) {
                        closes = JSON.parse(cached2);
                    }
                }
            } catch (e) {
                // falha no HTTP não impede o fallback, mas loga para depuração
                console.error('Falha no fetch do cache server:', e.message || e);
            }
        }
        // se ainda não temos candles suficientes, cai para REST (única vez)
        if (closes.length < rsiPeriod) {
            const candles = await client.candles({
                symbol,
                interval,
                limit: rsiPeriod + 100,
            });
            closes = candles.map(c => parseFloat(c.close));
        }

        if (closes.length >= rsiPeriod) {
            const getRsi = RSI.calculate({ values: closes, period: rsiPeriod });
            const latestRSI = getRsi.at(-1);
            if (latestRSI !== undefined) {
                rsi = parseFloat(latestRSI.toFixed(2));
            } else {
                console.warn('Não foi possível calcular o RSI.');
            }
        } else {
            console.warn(`Dados insuficientes para RSI (${closes.length} < ${rsiPeriod})`);
        }
    } catch (error) {
        console.error('Erro ao calcular RSI:', error.message || error);
    }

    return rsi;
};

module.exports = {
    getValue: getValue
}