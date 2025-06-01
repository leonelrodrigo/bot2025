
const Binance = require('binance-api-node').default;
const { RSI } = require('technicalindicators');

// Inicializa cliente da Binance (modo público)
const client = Binance();


let getValue = async function (symbol, interval, rsiPeriod) {

    let rsi = null;

    try {

        // Busca candles do par
        const candles = await client.candles({
            symbol,
            interval,
            limit: rsiPeriod + 100, // Pega candles suficientes para suavizar o RSI
        });

        const closes = candles.map(c => parseFloat(c.close));

        const getRsi = RSI.calculate({ values: closes, period: rsiPeriod });

        const latestRSI = getRsi.at(-1);
        if (latestRSI !== undefined) {
            rsi = latestRSI.toFixed(2);
        } else {
            console.warn('Não foi possível calcular o RSI.');
        }
    } catch (error) {
        console.error('Erro ao buscar candles ou calcular RSI:', error.message || error);
    }

    return rsi
}

module.exports = {
    getValue: getValue
}