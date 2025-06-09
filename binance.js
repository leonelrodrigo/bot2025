const Binance = require('binance-api-node').default;
const chalk = require('chalk');
require('dotenv').config();

const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
});

// Variáveis de Configuração

let balanceAmt = null; // Valor em Amount fixo
let balanceQty = 5;

let strategy = 'SHORT';
let tradeSide = 'SELL';

const base = 'USDT';
const moeda = 'NXPC';

let buyAmount = null; // Valor em Amount crescente
let sellAmount = null;  // Valor em Qty crescente

const monitoringInterval = 60000;
const candleInterval = '5m';
const rsiPeriod = 14;

let rsiBuy = 55; // RSI para comprar abaixo do valor
let rsiSell = 60; // RSI para Vender acima do valor

const alvoSell = 0.5; // Variação Positiva
const alvoBuy = 0.5; // Variação Negativa

const secureTrend = 1.0; // Evitar Tendência de Mercado

let secureLow = 1.01; // Preço * porcentegem 
let secureHigh = 1.00; // Preço / porcentagem

const stopLossPercentLong = 0.5;  // 2% abaixo do preço de compra para LONG
const stopLossPercentShort = 0.5; // 2% acima do preço de venda para SHORT

//////////////////////////////////////////////////////

// Variáveis Dinâmicas

let stopLoss = false;

let previousCandleClose = null;
let currentPrice = null;
let dailyLow = null;
let dailyHigh = null;
let buyPrice = null;
let sellPrice = null;
let trend = null;
let rsi = null;

let minQty = null;
let minAmt = null;
let stepSize = null;

const symbol = `${moeda}${base}`;

function roundStepSize(quantity) {
    const precision = Math.ceil(-Math.log10(stepSize));
    return parseFloat((Math.floor(quantity / stepSize) * stepSize).toFixed(precision));
}

async function updateMinOrderQty() {
    try {
        const exchangeInfo = await client.exchangeInfo();
        const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);

        if (!symbolInfo) throw new Error(`Símbolo ${symbol} não encontrado.`);

        const lotSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotional = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

        if (lotSize) {
            minQty = parseFloat(lotSize.minQty);
            stepSize = parseFloat(lotSize.stepSize);
        }

        minAmt = minNotional ? parseFloat(minNotional.minNotional) : 5;

        balanceUpdt();

        // Delete
        console.log(`Valor mínimo de ordem em ${base}: ${minAmt}`);
        console.log(`Quantidade mínima de ${moeda}: ${minQty}`);
        console.log(`Step Size de ${moeda}: ${stepSize}`);

    } catch (error) {
        console.error('Erro ao obter mínimos:', error.message);
    }
}

async function getLastCandle() {
    try {
        const candles = await client.candles({ symbol, interval: candleInterval, limit: 2 });
        return parseFloat(candles[0].close);
    } catch (error) {
        console.error(`Erro ao obter candle de ${candleInterval}:`, error.message);
        return null;
    }
}

async function get24hLow() {
    try {
        const ticker = await client.dailyStats({ symbol });
        return parseFloat(ticker.lowPrice);
    } catch (error) {
        console.error('Erro ao obter low 24h:', error.message);
        return null;
    }
}

async function get24hHigh() {
    try {
        const ticker = await client.dailyStats({ symbol });
        return parseFloat(ticker.highPrice);
    } catch (error) {
        console.error('Erro ao obter high 24h:', error.message);
        return null;
    }
}

// Função para verificar stop loss para LONG
async function checkStopLossLong() {
    if (tradeSide === 'SELL' && buyPrice) {
        const stopLossPrice = buyPrice * (1 - stopLossPercentLong / 100);
        if (currentPrice <= stopLossPrice) {
            //stopLoss = true;

            console.log(chalk.red(`[${new Date().toLocaleTimeString()}] STOP LOSS LONG acionado! Preço atual: ${currentPrice}, Stop Loss: ${stopLossPrice.toFixed(6)}`));

            // Vender tudo que tem para limitar prejuízo
            let minAmtQty = minAmt / buyPrice;

            let quantity = Math.max(buyAmount / buyPrice, minAmtQty);

            console.log('StopLossLong: ' + quantity);

            const order = await createOrder('SELL', quantity);

            if (order) {
                tradeSide = 'BUY'; // muda para modo compra
                buyPrice = null;
                //buyAmount = null;
                console.log(chalk.red(`✅ Stop Loss LONG executado, posição fechada.`));
                console.log('-----------------------------------');
            }
        }
    }
}

// Função para verificar stop loss para SHORT
async function checkStopLossShort() {
    if (tradeSide === 'BUY' && sellPrice) {
        const stopLossPrice = sellPrice * (1 + stopLossPercentShort / 100);
        if (currentPrice >= stopLossPrice) {
            //stopLoss = true;

            console.log(chalk.red(`[${new Date().toLocaleTimeString()}] STOP LOSS SHORT acionado! Preço atual: ${currentPrice}, Stop Loss: ${stopLossPrice.toFixed(6)}`));

            // Comprar para fechar posição short e limitar prejuízo
            await balanceUpdt(); // Garante que balanceAmt está atualizado
            let amountBuy = balanceAmt / currentPrice;
            let quantity = Math.max(amountBuy, minQty);

            console.log('StopLossShort: ' + quantity);

            const order = await createOrder('BUY', quantity);

            if (order) {
                tradeSide = 'SELL'; // muda para modo venda
                sellPrice = null;
                //sellAmount = null;
                console.log(chalk.red(`✅ Stop Loss SHORT executado, posição fechada.`));
                console.log('-----------------------------------');
            }
        }
    }
}

function logOrderDetails(order) {
    if (!order || !order.orderId) {
        console.warn('⚠️ Ordem vazia ou sem resultado.');
        return;
    }

    const {
        orderId,
        symbol,
        side,
        type,
        executedQty,
        cummulativeQuoteQty,
        status,
        transactTime,
    } = order;

    const timestamp = new Date(transactTime).toLocaleString();
    const avgPrice = parseFloat(cummulativeQuoteQty) / parseFloat(executedQty || 1);

    const baseLog = `
📄 Ordem ID       : ${orderId}
📊 Símbolo        : ${symbol}
💰 Preço Médio    : ${avgPrice.toFixed(6)}
📦 Quantidade     : ${executedQty}
⏱️ Data/Hora      : ${timestamp}
📌 Status         : ${status}\n`;

    if (side.toUpperCase() === 'SELL') {
        console.log('\n🔻 [VENDA EXECUTADA]', baseLog);
    } else if (side.toUpperCase() === 'BUY') {
        console.log('\n🟢 [COMPRA EXECUTADA]', baseLog);
    } else {
        console.log('\n🔷 [ORDEM EXECUTADA]', JSON.stringify(order, null, 2));
    }
}

async function balanceUpdt() {
    // Obtém saldo da conta
    const accountInfo = await client.accountInfo();
    const balances = accountInfo.balances;

    const saldoBase = parseFloat(balances.find(b => b.asset === base)?.free || '0');
    const saldoMoeda = parseFloat(balances.find(b => b.asset === moeda)?.free || '0');

    balanceAmt = saldoBase;
    balanceQty = saldoMoeda;

    console.log(`Saldo disponível de ${base}: ${saldoBase}`);
    console.log(`Saldo disponível de ${moeda}: ${saldoMoeda}`);
    console.log('-----------------------------------');
}

async function createOrder(side, quantity) {
    try {

        const roundedQty = roundStepSize(quantity);

        const order = await client.order({
            symbol,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: roundedQty,
        });

        logOrderDetails(order);

        if (side.toUpperCase() === 'SELL' && strategy === 'SHORT' && stopLoss === false) {
            sellPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
            sellAmount = parseFloat(order.executedQty);
        } else if (side.toUpperCase() === 'BUY' && strategy === 'LONG' && stopLoss === false) {
            buyPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
            buyAmount = parseFloat(order.cummulativeQuoteQty);
        }

        return order;
    } catch (error) {
        console.error('❌ Erro ao criar ordem:', error.message);
        return null;
    }
}

async function executeSellStrategy() {
    let changePercentage = null;
    const aboveDailyLow = currentPrice > (dailyLow * secureLow);

    trend = changePercentage <= secureTrend;

    if (strategy === 'SHORT') {
        changePercentage = ((currentPrice - previousCandleClose) / previousCandleClose) * 100;
    } else {
        changePercentage = ((currentPrice - buyPrice) / buyPrice) * 100;
    }

    if (tradeSide === 'SELL' && rsi >= rsiSell || rsiSell === 0) {

        if (changePercentage >= alvoSell && trend && aboveDailyLow) {

            await balanceUpdt();

            console.log(`[${new Date().toLocaleTimeString()}] Variação: ${changePercentage.toFixed(2)}% | Ordem de Venda acionada`);

            let quantity;

            if (strategy === 'SHORT') {
                quantity = Math.max(balanceQty, minQty);

            } else {
                const amountBuy = balanceAmt / currentPrice; // Modificado para farm de Token na strategy Long
                quantity = Math.max(amountBuy, minQty);
            }

            const order = await createOrder('SELL', quantity);

            if (order) {
                tradeSide = 'BUY';
                buyPrice = null;
                buyAmount = null;
                console.log(`✅ Venda executada: ${quantity} ${moeda}`);
                console.log('-----------------------------------');
            }
        }
    }
}

async function executeBuyStrategy() {
    let changePercentage = null;
    const belowDailyHigh = currentPrice < (dailyHigh / secureHigh);

    trend = changePercentage >= -secureTrend

    if (strategy === 'SHORT') {
        changePercentage = ((currentPrice - sellPrice) / sellPrice) * 100;
    } else {
        changePercentage = ((currentPrice - previousCandleClose) / previousCandleClose) * 100;
    }

    if (tradeSide === 'BUY' && rsi <= rsiBuy || rsiBuy === 0) {

        if (changePercentage <= -alvoBuy && trend && belowDailyHigh) {

            await balanceUpdt();

            console.log(`[${new Date().toLocaleTimeString()}] Ordem de Compra acionada`);

            let quantity;

            let minAmtQty = minAmt / currentPrice;

            if (strategy === 'SHORT') {
                const amountSell = balanceQty * sellPrice;
                quantity = Math.max(amountSell / currentPrice, minAmtQty);
            } else {
                // quantity = Math.max(buyAmount / currentPrice, minQty);
                let amtQty = balanceAmt / currentPrice;
                quantity = Math.max(amtQty, minAmtQty); // para sempre comprar qty balanceAmt
            }

            const order = await createOrder('BUY', quantity);

            if (order) {
                tradeSide = 'SELL';
                sellPrice = null;
                sellAmount = null;
                console.log(`✅ Compra executada: ${quantity} ${moeda}`);
                console.log('-----------------------------------');
            }
        }
    }
}

async function monitor() {
    try {

        const ticker = await client.prices({ symbol });
        currentPrice = parseFloat(ticker[symbol]);
        if (isNaN(currentPrice)) throw new Error('Preço atual inválido');

        dailyLow = await get24hLow();
        dailyHigh = await get24hHigh();

        const newCandleClose = await getLastCandle();
        if (newCandleClose) previousCandleClose = newCandleClose;

        let changePercentRaw = null;
        if (strategy === 'SHORT' && tradeSide === 'SELL' || strategy === 'LONG' && tradeSide === 'BUY') {
            changePercentRaw = previousCandleClose
                ? ((currentPrice - previousCandleClose) / previousCandleClose * 100)
                : null;

        } else if (strategy === 'SHORT' && tradeSide === 'BUY') {
            changePercentRaw = sellPrice
                ? ((currentPrice - sellPrice) / sellPrice * 100)
                : null;

        } else if (strategy === 'LONG' && tradeSide === 'SELL') {
            changePercentRaw = buyPrice
                ? ((currentPrice - buyPrice) / buyPrice * 100)
                : null;
        }

        let changePercentLog = changePercentRaw !== null
            ? `${changePercentRaw.toFixed(2)}%`
            : 'N/A';

        let updtRsi = require('./rsi.js');
        rsi = await updtRsi.getValue(symbol, candleInterval, rsiPeriod);
        rsi = Math.round(rsi);

        // Checar StopLoss, antes de executar a estratégia normal:
        if (strategy === 'LONG') {
            await checkStopLossLong();
        } else if (strategy === 'SHORT') {
            await checkStopLossShort();
        }

        const changeColor = changePercentRaw > 0 ? chalk.green : chalk.red;

        const priceNow = chalk.white.bold(`${currentPrice}`);
        const intervalVar = chalk.white.bold(`${candleInterval}`);
        const lastSell = sellPrice ? chalk.blackBright(`${sellPrice.toFixed(6)}`) : chalk.gray('N/A');
        const lastBuy = buyPrice ? chalk.blackBright(`${buyPrice.toFixed(6)}`) : chalk.gray('N/A');
        const tradeSideColor = tradeSide === 'SELL'
            ? chalk.white.bgRed.bold(' ' + tradeSide + ' ') + chalk.black.bgBlack('.')
            : chalk.white.bgGreen.bold(' ' + tradeSide + ' ') + chalk.black.bgBlack('.');

        const aboveDailyLow = currentPrice > (dailyLow * secureLow);
        const belowDailyHigh = currentPrice < (dailyHigh / secureHigh);
        const secureLowStatus = aboveDailyLow ? chalk.white.bold('true') : chalk.magenta.bold('false');
        const secureHighStatus = belowDailyHigh ? chalk.white.bold('true') : chalk.magenta.bold('false');
        const tredStatus = trend ? chalk.white.bold('true') : chalk.magenta.bold('false');

        if (strategy === 'SHORT') {
            console.log(`[${new Date().toLocaleTimeString()}] Preço Atual: ${priceNow}`);
            console.log(`Última venda: ${lastSell}`);
            console.log(`Variação (${intervalVar}): ${changeColor(changePercentLog)}`);
            console.log(`Modo: ${tradeSideColor}`);
            if (tradeSide === 'SELL') {
                console.log(`SecureLow: ${secureLowStatus}`);
            } else { console.log(`SecureHigh: ${secureHighStatus}`); }
            console.log(`SecureTrend: ${tredStatus}`, 'RSI:', String(rsi));
            console.log('-----------------------------------');
        } else {
            console.log(`[${new Date().toLocaleTimeString()}] Preço Atual: ${priceNow}`);
            console.log(`Última compra: ${lastBuy}`);
            console.log(`Variação (${intervalVar}): ${changeColor(changePercentLog)}`);
            console.log(`Side: ${tradeSideColor}`);
            if (tradeSide === 'BUY') {
                console.log(`SecureHigh: ${secureHighStatus}`);
            } else { `SecureLow: ${secureLowStatus}` }
            console.log(`SecureTrend: ${tredStatus}`, 'RSI:', String(rsi));
            console.log('-----------------------------------');
        }

        if (tradeSide === 'SELL') {
            await executeSellStrategy();
        } else {
            await executeBuyStrategy();
        }

    } catch (error) {
        console.error('Erro no monitoramento:', error.message);
    }
}

(async () => {
    console.log(`Iniciando estratégia para ${symbol} (análise em ${candleInterval})...`);
    await updateMinOrderQty();
    await monitor();
    setInterval(monitor, monitoringInterval);
})();
