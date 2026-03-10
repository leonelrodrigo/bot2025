const Binance = require('binance-api-node').default;
const fetch = global.fetch || require('node-fetch'); // usa fetch nativo se disponível, ou pacoteconst DCAStrategy = require('./dcaStrategy.js');
const chalk = require('chalk');
const updtRsi = require('./rsi.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// URL do cache server centralizado (onde RSI, preços e stats estarão)
const CACHE_URL = process.env.CACHE_URL || `http://localhost:${process.env.CACHE_PORT || 4000}`;

// ─────────────────────────────────────────────
// Carrega configurações externas (config.json)
// ─────────────────────────────────────────────

// Identificador opcional para instâncias paralelas. Pode vir de env var ou argumento CLI `--id=...`.
const BOT_ID = (() => {
    // prioridade: argumento CLI --id=foo
    const arg = process.argv.find(a => a.startsWith('--id='));
    if (arg) return arg.split('=')[1];
    if (process.env.BOT_ID) return process.env.BOT_ID;
    return '';
})();

const CONFIG_FILENAME = BOT_ID ? `${BOT_ID}_config.json` : 'config.json';
const STATS_FILENAME = BOT_ID ? `${BOT_ID}_stats.json` : 'stats.json';

// armazenar configs e estatísticas em subpasta para preservar raiz limpa
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const CONFIG_PATH = path.join(DATA_DIR, CONFIG_FILENAME);
const STATS_PATH = path.join(DATA_DIR, STATS_FILENAME);

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.error(`❌ Erro ao carregar ${CONFIG_PATH}:`, e.message);
        process.exit(1);
    }
}

function loadStats() {
    try {
        const raw = fs.readFileSync(STATS_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return defaultStats();
    }
}

function defaultStats() {
    return {
        sessao: { inicio: null, modo: null, symbol: null },
        trades: { total: 0, lucrativos: 0, prejuizo: 0, stopLossAcionados: 0 },
        financeiro: {
            lucroLiquidoTotal: 0,
            taxasTotais: 0,
            maiorLucroTrade: 0,
            maiorPrejuizoTrade: 0,
            saldoInicialBase: null,
            saldoAtualBase: null,
            // campos extras para acompanhar balanço em moeda (úteis em SHORT)
            saldoInicialMoeda: null,
            saldoAtualMoeda: null,
        },
        historico: [],
    };
}

function archiveStats(statsObj) {
    try {
        const archiveDirName = BOT_ID ? `stats_archives_${BOT_ID}` : 'stats_archives';
        const archiveDir = path.join(DATA_DIR, archiveDirName);
        if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = path.join(archiveDir, `stats_${ts}.json`);
        fs.writeFileSync(archivePath, JSON.stringify(statsObj, null, 2), 'utf8');
        console.log(chalk.blue(`📦 Arquivo de stats arquivado em ${archivePath}`));
    } catch (err) {
        console.error('Erro ao arquivar stats:', err.message || err);
    }
}

function saveStats(stats) {
    try {
        fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
    } catch (e) {
        console.error(`⚠️ Erro ao salvar ${STATS_FILENAME}:`, e.message);
    }
}

// ─────────────────────────────────────────────
// Inicializa configuração
// ─────────────────────────────────────────────

let cfg = loadConfig();

// if new reinvest settings absent, provide defaults
cfg.operacao = cfg.operacao || {};
cfg.operacao.reinvestProfits = cfg.operacao.reinvestProfits ?? false;
cfg.operacao.reinvestMode = cfg.operacao.reinvestMode || 'base'; // 'base' or 'moeda'

// log identifier if present
if (BOT_ID) {
    console.log(chalk.yellow(`🔖 Bot ID: ${BOT_ID} (usando arquivos ${CONFIG_FILENAME} / ${STATS_FILENAME})`));
}

let DEMO = cfg.modo.demo;
let base = cfg.modo.base;
let moeda = cfg.modo.moeda;
let symbol = `${moeda}${base}`;

let strategy = cfg.modo.strategy;
let tradeSide = cfg.modo.tradeSide;

let TAX_MARKET = cfg.taxas.market;   // ex: 0.001 = 0.1%
let TAX_LIMIT = cfg.taxas.limit;    // ex: 0.0005 = 0.05%

let monitoringInterval = cfg.timing.monitoringInterval;
let candleInterval = cfg.timing.candleInterval;
let rsiPeriod = cfg.timing.rsiPeriod;

let rsiBuy = cfg.rsi.rsiBuy;
let rsiSell = cfg.rsi.rsiSell;

let alvoSell = cfg.alvos.alvoSell;
let alvoBuy = cfg.alvos.alvoBuy;

let secureTrend = cfg.seguranca.secureTrend;
let secureLow = cfg.seguranca.secureLow;
let secureHigh = cfg.seguranca.secureHigh;
let stopLossPercentLong = cfg.seguranca.stopLossPercentLong;
let stopLossPercentShort = cfg.seguranca.stopLossPercentShort;
// Percentual do saldo a usar em ordens de compra e venda (0.0 - 1.0)
let pctCompra = (cfg.seguranca && cfg.seguranca.pctCompra !== undefined) ? parseFloat(cfg.seguranca.pctCompra) : 0.99;
let pctVenda = (cfg.seguranca && cfg.seguranca.pctVenda !== undefined) ? parseFloat(cfg.seguranca.pctVenda) : 0.99;
// Percentual específico: quanto do saldo em `base` usar para BUY em estratégia LONG
let pctBaseLong = (cfg.seguranca && cfg.seguranca.pctBaseLong !== undefined) ? parseFloat(cfg.seguranca.pctBaseLong) : pctCompra;
// Percentual específico: quanto da `moeda` disponibilizar para SELL em estratégia SHORT
let pctMoedaShort = (cfg.seguranca && cfg.seguranca.pctMoedaShort !== undefined) ? parseFloat(cfg.seguranca.pctMoedaShort) : pctVenda;

// Configurações da estratégia DCA (adicionar após carregar o cfg)
let dcaEnabled = cfg.dca?.enabled || false;
let dcaMaxOrders = cfg.dca?.maxOrders || 3;
let dcaTargetPercent = cfg.dca?.targetPercent || 0.5;

// Variável para estratégia DCA
let dcaStrategy = null;

// Margem de segurança para evitar falhas por arredondamento
const SAFETY_MARGIN = 0.999;

// lucro acumulado em `base` que ainda não foi reinvestido
let profitBankBase = 0;

// helpers para balances que consideram reinvestimento
function getEffectiveBalanceQty(currentPrice) {
    let qty = balanceQty;
    if (cfg.operacao.reinvestProfits && cfg.operacao.reinvestMode === 'moeda' && profitBankBase > 0 && currentPrice) {
        const extra = profitBankBase / currentPrice;
        qty += extra;
        if (DEMO) {
            // simulamos a conversão imediata no saldo DEMO
            demoBalance.moeda += extra;
            demoBalance.base = Math.max(0, demoBalance.base - profitBankBase);
        }
        profitBankBase = 0;
    }
    return qty;
}

function getEffectiveBalanceAmt(currentPrice) {
    let amt = balanceAmt;
    if (cfg.operacao.reinvestProfits && cfg.operacao.reinvestMode === 'base' && profitBankBase > 0) {
        if (!DEMO) {
            amt += profitBankBase;
        }
        // em DEMO o saldo já inclui o lucro, apenas limpamos o banco
        profitBankBase = 0;
    }
    return amt;
}

// função chamada após um trade fechado para acumular lucro no banco
function accumulateProfit(lucroBase) {
    if (lucroBase > 0 && cfg.operacao.reinvestProfits) {
        profitBankBase += lucroBase;
        console.log(chalk.magenta(`[REINVEST] lucro de ${lucroBase.toFixed(8)} ${base} adicionado ao banco`));
    }
}

// ─────────────────────────────────────────────
// Cliente Binance
// ─────────────────────────────────────────────

const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
});

// Cache de taxas por símbolo (consultado via API em modo REAL)
let tradeFeeCache = { ts: 0, data: null };
let tradeFeePerSymbol = {}; // mapping symbol -> taker fee (decimal)
const DEFAULT_FEE_CACHE_TTL = 10 * 60 * 1000;

async function fetchTradeFees(symbol) {
    // cache por 10 minutos
    const now = Date.now();
    if (tradeFeeCache.data && (now - tradeFeeCache.ts) < 10 * 60 * 1000) return tradeFeeCache.data;
    try {
        // endpoint /sapi/v1/asset/tradeFee?symbol=SYMBOL
        const fees = await withRetry(() => client.tradeFee({ symbol }), [], 2, 500);
        tradeFeeCache = { ts: now, data: fees };
        // fees geralmente retorna array; encontrar entry para symbol
        if (fees && Array.isArray(fees)) {
            for (const f of fees) {
                if (f.symbol && f.symbol === symbol) {
                    tradeFeePerSymbol[symbol] = parseFloat(f.taker ?? f.fee ?? TAX_MARKET);
                    break;
                }
            }
        }
        return fees;
    } catch (err) {
        console.warn('Não foi possível obter trade fees da API, usando configuração local. Erro:', err.message || err);
        return null;
    }
}

/**
 * Calcula a taxa paga numa ordem (em termos do ativo `base`) usando os fills retornados pela API.
 * Se fills não estiverem disponíveis (modo DEMO ou resposta parcial), cai no cálculo estimado por config.
 */
async function calcOrderFeeInBase(order) {
    try {
        if (!order) return 0;
        // Preferir fills[] comissão detalhada
        if (order.fills && order.fills.length > 0) {
            let totalFeeInBase = 0;
            for (const f of order.fills) {
                const comm = parseFloat(f.commission || 0);
                const commAsset = f.commissionAsset || base; // pode ser BNB ou outro
                if (comm === 0) continue;

                if (commAsset === base) {
                    totalFeeInBase += comm;
                    console.log(`[FEES] Fill commission: ${comm} ${commAsset} (already in ${base})`);
                } else {
                    // converte commAsset para base via preço atual, possivelmente via intermediários
                    try {
                        const conv = await convertAssetToBase(commAsset, base);
                        if (conv) {
                            const added = comm * conv;
                            totalFeeInBase += added;
                            console.log(`[FEES] Fill commission: ${comm} ${commAsset} -> ${added.toFixed(8)} ${base} (rate ${conv})`);
                        } else {
                            console.warn(`[FEES] Não foi possível converter comissão de ${commAsset} para ${base}; ignorando ${comm} ${commAsset}`);
                        }
                    } catch (e) {
                        console.warn('Erro ao converter commissionAsset:', e.message || e);
                    }
                }
            }
            return totalFeeInBase;
        }

        // Se não houver fills, estimativa usando TAX_MARKET aplicada sobre execQuote
        const execQuote = parseFloat(order.cummulativeQuoteQty || 0);
        const symFee = tradeFeePerSymbol[symbol] ?? TAX_MARKET;
        console.log(`[FEES] Usando estimativa de taxa para ${symbol}: ${symFee} (execQuote ${execQuote})`);
        return execQuote * symFee;
    } catch (err) {
        console.error('Erro em calcOrderFeeInBase:', err.message || err);
        return 0;
    }
}

// Converte um ativo (asset) para o valor em `base` retornando multiplicador (1 asset = x base)
async function convertAssetToBase(asset, baseAsset) {
    if (asset === baseAsset) return 1;

    const tryPairPrice = async (pair) => {
        // primeiro tenta obter via cache server (já mantém tickers em memória)
        try {
            const resp = await fetch(`${CACHE_URL}/price?symbol=${pair}`);
            if (resp.ok) {
                const json = await resp.json();
                const p = parseFloat(json.price);
                if (!isNaN(p) && p > 0) return p;
            }
        } catch (e) {
            // continuar para fallback
        }

        // fallback: consulta direta ao cliente Binance local
        try {
            const res = await withRetry(() => client.prices({ symbol: pair }), [], 2, 300);
            if (res && res[pair]) return parseFloat(res[pair]);
        } catch (e) {
            return null;
        }
        return null;
    };

    // 1) direct pair asset+base
    let price = await tryPairPrice(`${asset}${baseAsset}`);
    if (price && !Number.isNaN(price) && price > 0) return price;

    // 2) inverse pair base+asset
    price = await tryPairPrice(`${baseAsset}${asset}`);
    if (price && !Number.isNaN(price) && price > 0) return 1 / price;

    // 3) try single-hop intermediates in a deterministic order
    const intermediates = ['BTC', 'USDT', 'ETH', 'BNB'];
    for (const mid of intermediates) {
        if (mid === asset || mid === baseAsset) continue;

        // asset -> mid
        let aToMid = await tryPairPrice(`${asset}${mid}`);
        if (!aToMid) {
            const midToA = await tryPairPrice(`${mid}${asset}`);
            if (midToA && midToA > 0) aToMid = 1 / midToA;
        }
        if (!aToMid || Number.isNaN(aToMid) || aToMid <= 0) continue;

        // mid -> base
        let midToBase = await tryPairPrice(`${mid}${baseAsset}`);
        if (!midToBase) {
            const baseToMid = await tryPairPrice(`${baseAsset}${mid}`);
            if (baseToMid && baseToMid > 0) midToBase = 1 / baseToMid;
        }
        if (!midToBase || Number.isNaN(midToBase) || midToBase <= 0) continue;

        // composed rate: (asset -> mid) * (mid -> base)
        return aToMid * midToBase;
    }

    // fallback: none found
    return null;
}

// ─────────────────────────────────────────────
// Variáveis Dinâmicas
// ─────────────────────────────────────────────

let stopLoss = false;

let previousCandleClose = null;
let currentPrice = null;
let dailyLow = null;
let dailyHigh = null;
let buyPrice = null;
let sellPrice = null;
let trend = null;
let rsi = null;

// Evita concorrência de ordens: marca quando uma ordem está em processo
let isOrderPending = false;

let minQty = null;
let minAmt = null;
let stepSize = null;

let balanceAmt = null;
let balanceQty = null;
let buyAmount = null;
let sellAmount = null;

// qty of last executed orders, used when reinvestMode === 'equal'
let lastBuyQty = null;
let lastSellQty = null;

// accumulators for equal mode: sum of consecutive orders on each side
let accumBuyQty = 0;
let accumSellQty = 0;

// helper returns accumulated quantity for given side and clears it
function getEqualQty(side) {
    let qty = 0;
    if (side === 'SELL') {
        qty = accumSellQty;
        accumSellQty = 0;
    } else {
        qty = accumBuyQty;
        accumBuyQty = 0;
    }
    return qty;
}

// ─────────────────────────────────────────────
// Estado Demo
// ─────────────────────────────────────────────

let demoBalance = {
    base: cfg.demo_saldo_inicial.USDT,
    moeda: cfg.demo_saldo_inicial.moeda,
};

// ─────────────────────────────────────────────
// Stats de Performance
// ─────────────────────────────────────────────

let stats = loadStats();

/**
 * Registra um trade fechado nas estatísticas.
 * As taxas são calculadas sobre o valor total das DUAS pernas do trade (entrada + saída).
 *
 * @param {'BUY'|'SELL'} side       - Lado que FECHOU o ciclo
 * @param {number}        entryPrice - Preço de entrada do ciclo
 * @param {number}        exitPrice  - Preço de saída do ciclo
 * @param {number}        qty        - Quantidade negociada
 * @param {boolean}       isStopLoss - Se foi acionado por stop loss
 */
async function registrarTrade(side, entryPrice, exitPrice, qty, isStopLoss = false, feePaidBase = null) {
    // feePaidBase (opcional): valor real de taxas já pagas em `base` (ex.: USDT).
    // se não fornecido ou inválido, fazemos estimativa com TAX_MARKET
    let taxaTotal = 0;
    let usedEstimate = false;
    if (feePaidBase !== null && !Number.isNaN(Number(feePaidBase))) {
        taxaTotal = Number(feePaidBase);
    } else {
        usedEstimate = true;
        const taxaEntrada = entryPrice * qty * TAX_MARKET;
        const taxaSaida = exitPrice * qty * TAX_MARKET;
        taxaTotal = taxaEntrada + taxaSaida;
    }

    let lucroLiquido;
    if (strategy === 'SHORT') {
        // SHORT: abriu vendendo em entryPrice, fechou comprando em exitPrice
        lucroLiquido = (entryPrice - exitPrice) * qty - taxaTotal;
    } else {
        // LONG: abriu comprando em entryPrice, fechou vendendo em exitPrice
        lucroLiquido = (exitPrice - entryPrice) * qty - taxaTotal;
    }

    const lucroPct = ((lucroLiquido / (entryPrice * qty)) * 100).toFixed(3);

    // Atualiza estatísticas
    stats.trades.total++;
    stats.financeiro.taxasTotais = +(stats.financeiro.taxasTotais + taxaTotal).toFixed(8);
    stats.financeiro.lucroLiquidoTotal = +(stats.financeiro.lucroLiquidoTotal + lucroLiquido).toFixed(8);
    stats.financeiro.saldoAtualBase = DEMO ? +demoBalance.base.toFixed(8) : balanceAmt;
    stats.financeiro.saldoAtualMoeda = DEMO ? +demoBalance.moeda.toFixed(8) : balanceQty;
    if (isStopLoss) stats.trades.stopLossAcionados++;

    if (lucroLiquido >= 0) {
        stats.trades.lucrativos++;
        if (lucroLiquido > stats.financeiro.maiorLucroTrade)
            stats.financeiro.maiorLucroTrade = +lucroLiquido.toFixed(8);
    } else {
        stats.trades.prejuizo++;
        if (lucroLiquido < stats.financeiro.maiorPrejuizoTrade)
            stats.financeiro.maiorPrejuizoTrade = +lucroLiquido.toFixed(8);
    }

    // Histórico individual
    stats.historico.push({
        timestamp: new Date().toISOString(),
        strategy,
        side,
        entryPrice,
        exitPrice,
        qty: +qty.toFixed(8),
        taxaTotal: +taxaTotal.toFixed(8),
        feePaidBase: feePaidBase !== null ? +feePaidBase.toFixed(8) : null,
        feeEstimated: usedEstimate,
        lucroLiquido: +lucroLiquido.toFixed(8),
        lucroPct: `${lucroPct}%`,
        stopLoss: isStopLoss,
        modo: DEMO ? 'DEMO' : 'REAL',
    });

    saveStats(stats);

    // se houver lucro e reinvestimento habilitado, acumula para o banco
    accumulateProfit(lucroLiquido);
}

// exibe desempenho acumulado em qualquer ponto
function logStats() {
    const fin = stats.financeiro;
    const tr = stats.trades;

    const lucroColor = fin.lucroLiquidoTotal >= 0 ? chalk.green.bold : chalk.red.bold;
    // se a estratégia for SHORT, convertemos o lucro para a moeda (aprox.)
    let lucroStr;
    if (strategy === 'SHORT' && currentPrice) {
        const valorMoeda = fin.lucroLiquidoTotal / currentPrice;
        lucroStr = `${fin.lucroLiquidoTotal >= 0 ? '+' : ''}${valorMoeda.toFixed(4)} ${moeda}`;
    } else {
        lucroStr = `${fin.lucroLiquidoTotal >= 0 ? '+' : ''}${fin.lucroLiquidoTotal.toFixed(4)} ${base}`;
    }

    console.log(chalk.cyan('──────── 📊 DESEMPENHO ACUMULADO ────────'));
    console.log(`Trades  : ${tr.total} total | ✅ ${tr.lucrativos} lucro | ❌ ${tr.prejuizo} prejuízo | 🛑 ${tr.stopLossAcionados} stop`);
    console.log(`Lucro   : ${lucroColor(lucroStr)}`);
    console.log(`Taxas   : ~${chalk.yellow(fin.taxasTotais.toFixed(4))} ${base}`);
    console.log(`Melhor  : ${chalk.green(`+${fin.maiorLucroTrade.toFixed(4)}`)} | Pior: ${chalk.red(`${fin.maiorPrejuizoTrade.toFixed(4)}`)}`);

    if (fin.saldoInicialBase !== null && fin.saldoAtualBase !== null) {
        if (strategy === 'SHORT') {
            // usar os saldos reais em moeda salvos nos stats
            const initMoeda = fin.saldoInicialMoeda;
            const currMoeda = fin.saldoAtualMoeda;
            if (typeof initMoeda === 'number' && typeof currMoeda === 'number') {
                const variacao = currMoeda - initMoeda;
                const varStr = `${variacao >= 0 ? '+' : ''}${variacao.toFixed(4)}`;
                const varColor = variacao >= 0 ? chalk.green : chalk.red;
                // exibe também variação absoluta ao lado do saldo atual
                const sinal = variacao >= 0 ? '+' : '';
                console.log(`Saldo ${moeda}: ${initMoeda.toFixed(4)} → ${varColor(currMoeda.toFixed(4))} (${sinal}${variacao.toFixed(4)})`);
            } else {
                // caso algum valor ainda não esteja definido, exibimos o saldo atual
                const avail = DEMO ? demoBalance.moeda : balanceQty;
                console.log(chalk.yellow(`Saldo ${moeda}: ${avail.toFixed(8)} (saldo atual)`));
            }
        } else {
            const variacao = (fin.saldoAtualBase - fin.saldoInicialBase);
            const varStr = `${variacao >= 0 ? '+' : ''}${variacao.toFixed(4)}`;
            const varColor = variacao >= 0 ? chalk.green : chalk.red;
            const sinal2 = variacao >= 0 ? '+' : '';
            console.log(`Saldo ${base}: ${fin.saldoInicialBase.toFixed(2)} → ${varColor(parseFloat(fin.saldoAtualBase).toFixed(2))} (${sinal2}${variacao.toFixed(4)})`);
        }
    }
    console.log(chalk.cyan('─────────────────────────────────────────'));
}

// ─────────────────────────────────────────────
// Utilitários
// ─────────────────────────────────────────────

function roundStepSize(quantity) {
    const precision = Math.ceil(-Math.log10(stepSize));
    return parseFloat((Math.floor(quantity / stepSize) * stepSize).toFixed(precision));
}

// Ajusta quantidade para respeitar LOT_SIZE (stepSize), minQty e minNotional (minAmt).
function adjustQtyToFilters(requestQty, side) {
    // se stepSize indefinido, tenta um fallback simples
    if (!stepSize || !currentPrice || !minAmt || !minQty) {
        try {
            return parseFloat(requestQty.toFixed(8));
        } catch (e) {
            return null;
        }
    }

    const precision = Math.max(0, Math.ceil(-Math.log10(stepSize)));
    // alinha para baixo ao stepSize
    let q = Math.floor(requestQty / stepSize) * stepSize;
    q = parseFloat(q.toFixed(precision));

    // garante minQty
    if (q < minQty) q = minQty;

    // aumenta até atingir minNotional
    let guard = 0;
    while ((q * currentPrice) < minAmt && guard < 100000) {
        q = parseFloat((q + stepSize).toFixed(precision));
        guard++;
    }
    if ((q * currentPrice) < minAmt) return null;

    // para BUY: garante que o custo total (com taxa) caiba no saldo
    if (side && side.toUpperCase() === 'BUY') {
        const avail = DEMO ? demoBalance.base : balanceAmt;
        const totalCost = q * currentPrice * (1 + TAX_MARKET) * SAFETY_MARGIN;
        if (totalCost > avail) {
            // tenta reduzir para o máximo possível que caiba
            let maxQ = Math.floor(((avail / (1 + TAX_MARKET)) / currentPrice) / stepSize) * stepSize;
            maxQ = parseFloat(maxQ.toFixed(precision));
            if (maxQ < minQty) return null;
            if ((maxQ * currentPrice) < minAmt) return null;
            return maxQ;
        }
    }

    // para SELL: garante que quantidade não exceda saldo do ativo
    if (side && side.toUpperCase() === 'SELL') {
        const avail = DEMO ? demoBalance.moeda : balanceQty;
        if (q > avail) {
            let maxQ = Math.floor(avail / stepSize) * stepSize;
            maxQ = parseFloat(maxQ.toFixed(precision));
            if (maxQ < minQty) return null;
            if ((maxQ * currentPrice) < minAmt) return null;
            return maxQ;
        }
    }

    return q;
}

// Helper simples de retry para chamadas à API
async function withRetry(fn, args = [], retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn(...args);
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`Tentativa ${i + 1} falhou: ${err.message || err}. Retentando em ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ─────────────────────────────────────────────
// Inicialização: Limites mínimos do símbolo
// ─────────────────────────────────────────────

async function updateMinOrderQty() {
    try {
        const exchangeInfo = await withRetry(() => client.exchangeInfo(), [], 3, 1000);
        const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);

        if (!symbolInfo) throw new Error(`Símbolo ${symbol} não encontrado.`);

        const lotSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotionalFilter =
            symbolInfo.filters.find(f => f.filterType === 'NOTIONAL') ||
            symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

        if (lotSize) {
            minQty = parseFloat(lotSize.minQty);
            stepSize = parseFloat(lotSize.stepSize);
        }

        minAmt = minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : 5;

        await balanceUpdt();

        console.log(`Valor mínimo de ordem em ${base}: ${minAmt}`);
        console.log(`Quantidade mínima de ${moeda}: ${minQty}`);
        console.log(`Step Size de ${moeda}: ${stepSize}`);

    } catch (error) {
        console.error('Erro ao obter mínimos:', error.message);
    }
}

// Aplica valores mutáveis de cfg carregada em runtime
function applyConfig(newCfg) {
    try {
        cfg = newCfg;
        // campos simples
        pctCompra = Math.min(Math.max(parseFloat(cfg.seguranca.pctCompra ?? pctCompra), 0), 1);
        pctVenda = Math.min(Math.max(parseFloat(cfg.seguranca.pctVenda ?? pctVenda), 0), 1);
        pctBaseLong = Math.min(Math.max(parseFloat(cfg.seguranca.pctBaseLong ?? pctBaseLong), 0), 1);
        pctMoedaShort = Math.min(Math.max(parseFloat(cfg.seguranca.pctMoedaShort ?? pctMoedaShort), 0), 1);

        rsiBuy = cfg.rsi.rsiBuy ?? rsiBuy;
        rsiSell = cfg.rsi.rsiSell ?? rsiSell;
        alvoBuy = cfg.alvos.alvoBuy ?? alvoBuy;
        alvoSell = cfg.alvos.alvoSell ?? alvoSell;

        secureTrend = cfg.seguranca.secureTrend ?? secureTrend;
        secureLow = cfg.seguranca.secureLow ?? secureLow;
        secureHigh = cfg.seguranca.secureHigh ?? secureHigh;
        stopLossPercentLong = cfg.seguranca.stopLossPercentLong ?? stopLossPercentLong;
        stopLossPercentShort = cfg.seguranca.stopLossPercentShort ?? stopLossPercentShort;

        // operacoes (reinvestimento) – revalida defaults
        cfg.operacao = cfg.operacao || {};
        cfg.operacao.reinvestProfits = cfg.operacao.reinvestProfits ?? false;
        cfg.operacao.reinvestMode = cfg.operacao.reinvestMode || 'base';

        // monitoringInterval and other timing changes require restart to take full effect
        console.log(chalk.green('[CONFIG] Novas configurações aplicadas: pctCompra=' + pctCompra + ' pctVenda=' + pctVenda + ' pctBaseLong=' + pctBaseLong + ' pctMoedaShort=' + pctMoedaShort));
    } catch (err) {
        console.error('Erro ao aplicar nova config:', err.message || err);
    }
}

// Observa mudanças no config.json e aplica campos mutáveis sem reiniciar
fs.watchFile(CONFIG_PATH, { interval: 1500 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    try {
        const newCfg = loadConfig();
        applyConfig(newCfg);
    } catch (err) {
        console.error(`Erro ao recarregar ${CONFIG_PATH}:`, err.message || err);
    }
});

// ─────────────────────────────────────────────
// Dados de Mercado
// ─────────────────────────────────────────────

// agora obtém candle através do cache server (mesmo endpoint usado para RSI)
async function getLastCandle() {
    try {
        const resp = await fetch(`${CACHE_URL}/cache?symbol=${symbol}&interval=${candleInterval}`);
        if (!resp.ok) {
            console.warn('[getLastCandle] resposta não ok', resp.status);
            return null;
        }
        const arr = await resp.json();
        if (Array.isArray(arr) && arr.length > 0) {
            return parseFloat(arr[arr.length - 1]);
        }
    } catch (error) {
        console.error(`Erro ao obter candle de ${candleInterval}:`, error.message);
    }
    return null;
}

async function update24hStats() {
    try {
        const resp = await fetch(`${CACHE_URL}/stats24h?symbol=${symbol}`);
        if (!resp.ok) {
            console.warn('[update24hStats] resposta não ok', resp.status);
            return;
        }
        const ticker = await resp.json();
        dailyLow = parseFloat(ticker.lowPrice);
        dailyHigh = parseFloat(ticker.highPrice);
    } catch (error) {
        console.error('Erro ao obter stats 24h:', error.message);
    }
}

// ─────────────────────────────────────────────
// Saldo da Conta (Real ou Demo)
// ─────────────────────────────────────────────

async function balanceUpdt() {
    try {
        if (DEMO) {
            balanceAmt = demoBalance.base;
            balanceQty = demoBalance.moeda;
        } else {
            const accountInfo = await withRetry(() => client.accountInfo(), [], 3, 1000);
            const balances = accountInfo.balances;
            balanceAmt = parseFloat(balances.find(b => b.asset === base)?.free ?? '0');
            balanceQty = parseFloat(balances.find(b => b.asset === moeda)?.free ?? '0');
        }

        const tag = DEMO ? chalk.yellow('[DEMO] ') : '';
        console.log(`${tag}Saldo ${base}: ${balanceAmt.toFixed(4)} | ${moeda}: ${balanceQty}`);
        console.log('-----------------------------------');
    } catch (error) {
        console.error('Erro ao atualizar saldo:', error.message);
    }
}

// Aplicar trade fees do símbolo na inicialização (não bloqueante)
async function applySymbolFeesOnInit() {
    if (!DEMO) {
        try {
            const fees = await fetchTradeFees(symbol);
            if (tradeFeePerSymbol[symbol]) {
                console.log(chalk.green(`[FEES] Taxa taker para ${symbol} obtida: ${tradeFeePerSymbol[symbol]}`));
            }
        } catch (e) {
            console.warn('Aviso: não foi possível obter trade fees na inicialização:', e.message || e);
        }
    }
}

// ─────────────────────────────────────────────
// Ordens
// ─────────────────────────────────────────────

function logOrderDetails(order) {
    if (!order || !order.orderId) {
        console.warn('⚠️ Ordem vazia ou sem resultado.');
        return;
    }

    const { orderId, symbol, side, executedQty, cummulativeQuoteQty, status, transactTime } = order;
    const timestamp = new Date(transactTime).toLocaleString();
    const avgPrice = parseFloat(cummulativeQuoteQty) / parseFloat(executedQty || 1);
    const taxaEst = parseFloat(cummulativeQuoteQty) * TAX_MARKET;

    const baseLog = `
📄 Ordem ID       : ${orderId}
📊 Símbolo        : ${symbol}
💰 Preço Médio    : ${avgPrice.toFixed(6)}
📦 Quantidade     : ${executedQty}
💸 Taxa est.      : ~${taxaEst.toFixed(6)} ${base}
⏱️ Data/Hora      : ${timestamp}
📌 Status         : ${status}\n`;

    if (side.toUpperCase() === 'SELL') {
        console.log('\n🔻 [VENDA EXECUTADA]', baseLog);
    } else {
        console.log('\n🟢 [COMPRA EXECUTADA]', baseLog);
    }
}

/**
 * Simula uma ordem de mercado no modo DEMO.
 * Aplica a taxa de market sobre o valor da operação e atualiza os saldos virtuais.
 */
function createDemoOrder(side, roundedQty) {
    if (roundedQty < minQty) {
        console.warn(`⚠️ [DEMO] Quantidade ${roundedQty} abaixo do mínimo (${minQty}). Ordem cancelada.`);
        return null;
    }

    const tradeValue = roundedQty * currentPrice;
    const taxa = tradeValue * TAX_MARKET;

    if (side === 'SELL') {
        if (demoBalance.moeda < roundedQty) {
            console.warn(`⚠️ [DEMO] Saldo insuficiente de ${moeda} para vender.`);
            return null;
        }
        demoBalance.moeda -= roundedQty;
        demoBalance.base += tradeValue - taxa;
    } else {
        const totalCost = tradeValue + taxa;
        if (demoBalance.base < totalCost) {
            console.warn(`⚠️ [DEMO] Saldo insuficiente de ${base} para comprar.`);
            return null;
        }
        demoBalance.base -= totalCost;
        demoBalance.moeda += roundedQty;
    }

    const now = Date.now();
    const tag = chalk.yellow('[DEMO] ');
    const label = side === 'SELL' ? '🔻 [VENDA SIMULADA]' : '🟢 [COMPRA SIMULADA]';
    console.log(`\n${tag}${label}`);
    console.log(`${tag}Qtd: ${roundedQty} ${moeda} | Preço: ${currentPrice} | Valor: ${tradeValue.toFixed(4)} ${base} | Taxa: ~${taxa.toFixed(6)} ${base}`);
    console.log(`${tag}Saldo pós-ordem → ${base}: ${demoBalance.base.toFixed(4)} | ${moeda}: ${demoBalance.moeda}`);

    return {
        orderId: `DEMO-${now}`,
        symbol,
        side: side.toUpperCase(),
        type: 'MARKET',
        executedQty: String(roundedQty),
        cummulativeQuoteQty: String(tradeValue),
        status: 'FILLED',
        transactTime: now,
    };
}

async function createOrder(side, quantity, isStopLoss = false, isDCAOrder = false) {
    try {
        if (isOrderPending) {
            console.warn('Outra ordem está pendente — ignorando nova ordem para evitar duplicatas.');
            return null;
        }
        isOrderPending = true;

        // Ajusta quantidade para respeitar filtros
        let roundedQty = adjustQtyToFilters(quantity, side);
        if (!roundedQty || Number.isNaN(roundedQty) || roundedQty <= 0) {
            console.warn('Quantidade ajustada inválida ou insuficiente para respeitar filtros/minNotional. Ordem cancelada.');
            return null;
        }

        let order;

        if (DEMO) {
            order = createDemoOrder(side, roundedQty);
        } else {
            if (roundedQty < minQty) {
                console.warn(`⚠️ Quantidade ${roundedQty} abaixo do mínimo (${minQty}). Ordem cancelada.`);
                return null;
            }
            order = await client.order({
                symbol,
                side: side.toUpperCase(),
                type: 'MARKET',
                quantity: roundedQty,
                newOrderRespType: 'FULL',
            });
            logOrderDetails(order);
        }

        if (!order) return null;

        const execQty = parseFloat(order.executedQty);
        const execQuote = parseFloat(order.cummulativeQuoteQty);
        const avgPrice = execQuote / execQty;
        // track for equal-mode reinvest
        if (side.toUpperCase() === 'SELL') {
            lastSellQty = execQty;
            accumSellQty += execQty;
            accumBuyQty = 0;
        } else {
            lastBuyQty = execQty;
            accumBuyQty += execQty;
            accumSellQty = 0;
        }

        // Atualiza saldo
        if (!DEMO) {
            try {
                await balanceUpdt();
            } catch (e) {
                console.warn('Aviso: falha ao atualizar saldo antes de registrar trade:', e.message || e);
            }
        }

        // ─────────────────────────────────────────────
        // Integração com Estratégia DCA
        // ─────────────────────────────────────────────
        if (dcaEnabled) {
            // Inicializa estratégia DCA se não existir
            if (!dcaStrategy) {
                dcaStrategy = new DCAStrategy({
                    maxExtraOrders: dcaMaxOrders,
                    targetPercent: dcaTargetPercent,
                    symbol,
                    base,
                    moeda,
                    strategy
                });
            }

            // Lógica DCA baseada no side e strategy
            if (strategy === 'LONG') {
                if (side.toUpperCase() === 'BUY') {
                    // Compra inicial ou ordem extra
                    if (!dcaStrategy.isActive) {
                        // Primeira compra - inicia estratégia
                        dcaStrategy.startPosition(avgPrice, execQty, execQuote);
                    } else if (!isDCAOrder && dcaStrategy.isActive) {
                        // Pode ser uma ordem extra automática via DCA
                        // Vamos verificar se é movimento contrário
                        const shouldAdd = dcaStrategy.checkContraryMove(avgPrice);
                        if (shouldAdd && !isStopLoss) {
                            dcaStrategy.addPosition(avgPrice, execQty, execQuote);
                        }
                    }

                    buyPrice = avgPrice;
                    // acumula valor de compra para reutilização posterior
                    buyAmount = (buyAmount || 0) + execQuote;

                } else if (side.toUpperCase() === 'SELL' && dcaStrategy.isActive) {
                    // Venda - pode ser fechamento de posição
                    if (dcaStrategy.checkTarget(avgPrice)) {
                        // Atingiu o alvo - fecha posição com lucro
                        const dcaAvgEntry = dcaStrategy.averageEntryPrice; // salva antes do reset
                        const result = dcaStrategy.closePosition(avgPrice, execQty, execQuote);
                        // log detalhado de fechamento de DCA
                        if (result) {
                            console.log(chalk.magenta(`📦 DCA fechado: lucro ${result.profit.toFixed(8)} ${base} ` +
                                `(esperado ${result.expectedProfit.toFixed(8)} ${base})`));
                        }
                        // Registra trade normalmente
                        let feePaid = null;
                        try { feePaid = await calcOrderFeeInBase(order); } catch (e) { feePaid = null; }
                        await registrarTrade('SELL', dcaAvgEntry, avgPrice, execQty, isStopLoss, feePaid);
                        buyPrice = null;
                        buyAmount = null;
                    } else {
                        // Venda normal (não DCA) - registra trade normalmente
                        let feePaid = null;
                        try { feePaid = await calcOrderFeeInBase(order); } catch (e) { feePaid = null; }
                        await registrarTrade('SELL', buyPrice, avgPrice, execQty, isStopLoss, feePaid);
                        buyPrice = null;
                        buyAmount = null;
                        dcaStrategy.cancel('Venda manual');
                    }
                }

            } else if (strategy === 'SHORT') {
                if (side.toUpperCase() === 'SELL') {
                    // Venda inicial (abertura de SHORT)
                    if (!dcaStrategy.isActive) {
                        dcaStrategy.startPosition(avgPrice, execQty, execQuote);
                    } else if (!isDCAOrder && dcaStrategy.isActive) {
                        const shouldAdd = dcaStrategy.checkContraryMove(avgPrice);
                        if (shouldAdd && !isStopLoss) {
                            dcaStrategy.addPosition(avgPrice, execQty, execQuote);
                        }
                    }

                    sellPrice = avgPrice;
                    // acumula valor de venda incluindo extras
                    sellAmount = (sellAmount || 0) + execQuote;

                } else if (side.toUpperCase() === 'BUY' && dcaStrategy.isActive) {
                    // Compra - fechamento de SHORT
                    if (dcaStrategy.checkTarget(avgPrice)) {
                        const dcaAvgEntry = dcaStrategy.averageEntryPrice; // salva antes do reset
                        const result = dcaStrategy.closePosition(avgPrice, execQty, execQuote);
                        // log detalhado de fechamento de DCA
                        if (result) {
                            console.log(chalk.magenta(`📦 DCA fechado: lucro ${result.profit.toFixed(8)} ${base} ` +
                                `(esperado ${result.expectedProfit.toFixed(8)} ${base})`));
                        }
                        let feePaid = null;
                        try { feePaid = await calcOrderFeeInBase(order); } catch (e) { feePaid = null; }
                        await registrarTrade('BUY', dcaAvgEntry, avgPrice, execQty, isStopLoss, feePaid);
                        sellPrice = null;
                        sellAmount = null;
                    } else {
                        let feePaid = null;
                        try { feePaid = await calcOrderFeeInBase(order); } catch (e) { feePaid = null; }
                        await registrarTrade('BUY', sellPrice, avgPrice, execQty, isStopLoss, feePaid);
                        sellPrice = null;
                        sellAmount = null;
                        dcaStrategy.cancel('Compra manual');
                    }
                }
            }
        } else {
            // Lógica original sem DCA
            if (side.toUpperCase() === 'SELL' && strategy === 'SHORT') {
                sellPrice = avgPrice;
                sellAmount = (sellAmount || 0) + execQuote;
            } else if (side.toUpperCase() === 'BUY' && strategy === 'SHORT' && sellPrice) {
                let feePaid = null;
                try { feePaid = await calcOrderFeeInBase(order); } catch (e) { feePaid = null; }
                await registrarTrade('BUY', sellPrice, avgPrice, execQty, isStopLoss, feePaid);
            } else if (side.toUpperCase() === 'BUY' && strategy === 'LONG') {
                buyPrice = avgPrice;
                buyAmount = (buyAmount || 0) + execQuote;
            } else if (side.toUpperCase() === 'SELL' && strategy === 'LONG' && buyPrice) {
                let feePaid = null;
                try { feePaid = await calcOrderFeeInBase(order); } catch (e) { feePaid = null; }
                await registrarTrade('SELL', buyPrice, avgPrice, execQty, isStopLoss, feePaid);
            }
        }

        return order;

    } catch (error) {
        console.error('❌ Erro ao criar ordem:', error.message);
        return null;
    } finally {
        isOrderPending = false;
    }
}

// ─────────────────────────────────────────────
// Stop Loss
// ─────────────────────────────────────────────

async function checkStopLossLong() {
    if (stopLossPercentLong <= 0) return;

    if (tradeSide === 'SELL' && (buyPrice || (dcaStrategy && dcaStrategy.isActive))) {
        // Usa o preço de entrada apropriado (DCA ou normal)
        const entryPrice = (dcaEnabled && dcaStrategy && dcaStrategy.isActive)
            ? dcaStrategy.averageEntryPrice
            : buyPrice;

        if (!entryPrice) return;

        // Calcula stop loss adaptativo se DCA ativo
        const stopPercent = calculateAdaptiveStopLoss();
        const stopLossPrice = entryPrice * (1 - stopPercent / 100);

        if (currentPrice <= stopLossPrice) {
            console.log(chalk.red(`[${new Date().toLocaleTimeString()}] 🛑 STOP LOSS LONG | Atual: ${currentPrice} | Stop: ${stopLossPrice.toFixed(6)} (${stopPercent}%)`));

            if (dcaEnabled && dcaStrategy && dcaStrategy.isActive) {
                dcaStrategy.cancel('Stop Loss');
            }

            let quantity;
            if (dcaEnabled && dcaStrategy && dcaStrategy.isActive) {
                // Fecha toda a posição DCA
                quantity = dcaStrategy.totalQuantity;
            } else {
                quantity = Math.max((buyAmount / buyPrice) * pctVenda, minAmt / buyPrice);
            }

            const order = await createOrder('SELL', quantity, true);

            if (order) {
                tradeSide = 'BUY';
                buyPrice = null;
                buyAmount = null;
                console.log(chalk.red('✅ Stop Loss LONG executado.'));
                console.log('-----------------------------------');
            }
        }
    }
}

async function checkStopLossShort() {
    if (stopLossPercentShort <= 0) return;

    if (tradeSide === 'BUY' && (sellPrice || (dcaStrategy && dcaStrategy.isActive))) {
        const entryPrice = (dcaEnabled && dcaStrategy && dcaStrategy.isActive)
            ? dcaStrategy.averageEntryPrice
            : sellPrice;

        if (!entryPrice) return;

        const stopPercent = calculateAdaptiveStopLoss();
        const stopLossPrice = entryPrice * (1 + stopPercent / 100);

        if (currentPrice >= stopLossPrice) {
            console.log(chalk.red(`[${new Date().toLocaleTimeString()}] 🛑 STOP LOSS SHORT | Atual: ${currentPrice} | Stop: ${stopLossPrice.toFixed(6)} (${stopPercent}%)`));

            if (dcaEnabled && dcaStrategy && dcaStrategy.isActive) {
                dcaStrategy.cancel('Stop Loss');
            }

            await balanceUpdt();

            let quantity;
            if (dcaEnabled && dcaStrategy && dcaStrategy.isActive) {
                quantity = dcaStrategy.totalQuantity;
            } else {
                const baseForBuy = sellAmount || getEffectiveBalanceAmt(currentPrice);
                quantity = Math.max((baseForBuy * pctCompra) / (currentPrice * (1 + TAX_MARKET)), minQty);
            }

            const order = await createOrder('BUY', quantity, true);

            if (order) {
                tradeSide = 'SELL';
                sellPrice = null;
                sellAmount = null;
                console.log(chalk.red('✅ Stop Loss SHORT executado.'));
                console.log('-----------------------------------');
            }
        }
    }
}

// ---------------------------------------------------------
// Função para calcular stop loss adaptativo baseado no DCA
// ---------------------------------------------------------

function calculateAdaptiveStopLoss() {
    if (!dcaEnabled || !dcaStrategy || !dcaStrategy.isActive) {
        // Se DCA não está ativo, usa stop loss normal
        return strategy === 'LONG' ? stopLossPercentLong : stopLossPercentShort;
    }

    const posInfo = dcaStrategy.getPositionInfo();
    const ordersUsed = posInfo.ordersCount;
    const averagePrice = posInfo.averageEntryPrice;

    // Calcula o drawdown máximo que ainda permite as próximas ordens
    // Se temos maxOrders = 3 e já usamos 1 ordem, ainda temos 2 ordens pela frente
    const remainingOrders = dcaMaxOrders - ordersUsed;

    // Cada ordem precisa de targetPercent% de espaço
    // Mas também precisamos de um buffer de segurança
    const requiredSpaceForExtraOrders = remainingOrders * dcaTargetPercent * 1.2; // 20% de buffer

    // O stop loss não pode ser mais apertado que o espaço necessário para as próximas ordens
    let adaptiveStopPercent;

    if (strategy === 'LONG') {
        // Para LONG, o stop loss deve ser abaixo do preço da próxima ordem extra
        const nextOrderPrice = averagePrice * (1 - (dcaTargetPercent / 100) * (ordersUsed + 1));
        const stopFromAvg = ((averagePrice - nextOrderPrice) / averagePrice) * 100;

        // Stop loss adaptativo = máximo entre:
        // 1. O necessário para as próximas ordens (com folga)
        // 2. O stop loss original (nunca mais apertado que o original)
        adaptiveStopPercent = Math.max(
            stopFromAvg * 1.5, // 50% de folga além do preço da próxima ordem
            stopLossPercentLong
        );

        console.log(chalk.cyan(`📊 Stop Loss Adaptativo: ${adaptiveStopPercent.toFixed(2)}% (original: ${stopLossPercentLong}%)`));
        console.log(chalk.cyan(`   Próxima ordem extra em: $${nextOrderPrice.toFixed(2)} (-${stopFromAvg.toFixed(2)}%)`));

    } else { // SHORT
        const nextOrderPrice = averagePrice * (1 + (dcaTargetPercent / 100) * (ordersUsed + 1));
        const stopFromAvg = ((nextOrderPrice - averagePrice) / averagePrice) * 100;

        adaptiveStopPercent = Math.max(
            stopFromAvg * 1.5,
            stopLossPercentShort
        );

        console.log(chalk.cyan(`📊 Stop Loss Adaptativo: ${adaptiveStopPercent.toFixed(2)}% (original: ${stopLossPercentShort}%)`));
        console.log(chalk.cyan(`   Próxima ordem extra em: $${nextOrderPrice.toFixed(2)} (+${stopFromAvg.toFixed(2)}%)`));
    }

    return Math.min(adaptiveStopPercent, 5); // Cap de 5% para segurança
}

// ─────────────────────────────────────────────
// Estratégias
// ─────────────────────────────────────────────

async function executeSellStrategy() {
    // antes da estratégia normal, veja se DCA ativo deve disparar ordem extra
    if (dcaEnabled && dcaStrategy && dcaStrategy.isActive && strategy === 'SHORT') {
        if (dcaStrategy.checkContraryMove(currentPrice)) {
            await balanceUpdt();
            const availableBalance = getEffectiveBalanceQty(currentPrice);
            const quantity = dcaStrategy.calculateNextOrderQuantity(
                currentPrice,
                availableBalance,
                minQty
            );
            if (quantity && quantity > 0) {
                console.log(chalk.cyan(`📊 DCA extra SHORT: quantidade calculada ${quantity.toFixed(8)}`));
                const order = await createOrder('SELL', quantity, false, false); // isDCAOrder=false para adicionar posição
                if (order) {
                    // atualiza estado DCA independentemente de checkContraryMove interno
                    try {
                        const execQty = parseFloat(order.executedQty);
                        const execQuote = parseFloat(order.cummulativeQuoteQty);
                        const avgPrice = execQuote / execQty;
                        dcaStrategy.addPosition(avgPrice, execQty, execQuote, true);
                    } catch (e) {
                        console.warn('Erro ao atualizar DCA após ordem extra:', e.message || e);
                    }
                    console.log(chalk.green(`✅ DCA extra vendido: ${quantity} ${moeda}`));
                }
            }
            return; // não executar lógica principal
        }
    }

    if (rsi === null && (rsiSell !== 0 || rsiBuy !== 0)) {
        console.log(chalk.yellow('[STRATEGY] RSI indisponível — pulando sell strategy neste ciclo.'));
        return;
    }
    const aboveDailyLow = dailyLow ? currentPrice > (dailyLow * secureLow) : true;

    // variação usada para decidir alvo (entry baseado em candle anterior para SHORT ou preço de compra para LONG)
    let changePercentage;
    if (strategy === 'SHORT') {
        if (!previousCandleClose) {
            console.log(chalk.gray('[SELL] Aguardando previousCandleClose...'));
            return;
        }
        changePercentage = ((currentPrice - previousCandleClose) / previousCandleClose) * 100;
    } else {
        if (!buyPrice) {
            console.log(chalk.gray('[SELL] Aguardando buyPrice para calcular variação (LONG)...'));
            return;
        }
        changePercentage = ((currentPrice - buyPrice) / buyPrice) * 100;
    }

    // tendência sempre comparada com a vela anterior, não com o preço de entrada
    const trendPct = previousCandleClose
        ? ((currentPrice - previousCandleClose) / previousCandleClose) * 100
        : null;
    trend = secureTrend === 0 ? true : (trendPct !== null && trendPct <= secureTrend);

    if (tradeSide === 'SELL' && (rsi >= rsiSell || rsiSell === 0)) {
        if (changePercentage >= alvoSell && trend && aboveDailyLow) {

            await balanceUpdt();
            console.log(`[${new Date().toLocaleTimeString()}] Variação: ${changePercentage.toFixed(2)}% | Ordem de Venda acionada`);

            let quantity;
            if (cfg.operacao.reinvestMode === 'equal') {
                // reopen with same volume as last opposite trade when available
                quantity = getEqualQty('SELL') || Math.max(getEffectiveBalanceQty(currentPrice) * (strategy === 'SHORT' ? pctMoedaShort : pctVenda), minQty);
                console.log(chalk.magenta(`[REINVEST] equal mode: using qty ${quantity}`));
            } else if (strategy === 'SHORT') {
                const effectiveQty = getEffectiveBalanceQty(currentPrice);
                quantity = Math.max(effectiveQty * pctMoedaShort, minQty);
            } else {
                const effectiveQty = getEffectiveBalanceQty(currentPrice);
                quantity = Math.max(effectiveQty * pctVenda, minQty);
            }

            const order = await createOrder('SELL', quantity, false, true);

            if (order) {
                // independente de DCA, após vender a lógica principal deve alternar o lado
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
    // DCA extra para LONG
    if (dcaEnabled && dcaStrategy && dcaStrategy.isActive && strategy === 'LONG') {
        if (dcaStrategy.checkContraryMove(currentPrice)) {
            await balanceUpdt();
            // use effective base balance when reinvestindo em base
            const availableBalance = getEffectiveBalanceAmt(currentPrice);
            const minAmtQty = minAmt / currentPrice;
            const quantity = dcaStrategy.calculateNextOrderQuantity(
                currentPrice,
                availableBalance,
                minAmtQty
            );
            if (quantity && quantity > 0) {
                console.log(chalk.cyan(`📊 DCA extra LONG: quantidade calculada ${quantity.toFixed(8)}`));
                const order = await createOrder('BUY', quantity, false, false);
                if (order) {
                    try {
                        const execQty = parseFloat(order.executedQty);
                        const execQuote = parseFloat(order.cummulativeQuoteQty);
                        const avgPrice = execQuote / execQty;
                        dcaStrategy.addPosition(avgPrice, execQty, execQuote, true);
                    } catch (e) {
                        console.warn('Erro ao atualizar DCA após ordem extra:', e.message || e);
                    }
                    console.log(chalk.green(`✅ DCA extra comprado: ${quantity} ${moeda}`));
                }
            }
            return;
        }
    }

    if (rsi === null && (rsiBuy !== 0 || rsiSell !== 0)) {
        console.log(chalk.yellow('[STRATEGY] RSI indisponível — pulando buy strategy neste ciclo.'));
        return;
    }
    const belowDailyHigh = dailyHigh ? currentPrice < (dailyHigh / secureHigh) : true;

    // variação usada para calcular se atingiu alvo (entry) — SHORT usa sellPrice, LONG usa vela anterior
    let changePercentage;
    if (strategy === 'SHORT') {
        if (!sellPrice) {
            console.log(chalk.gray('[BUY] Aguardando sellPrice para calcular variação (SHORT)...'));
            return;
        }
        changePercentage = ((currentPrice - sellPrice) / sellPrice) * 100;
    } else {
        if (!previousCandleClose) {
            console.log(chalk.gray('[BUY] Aguardando previousCandleClose...'));
            return;
        }
        changePercentage = ((currentPrice - previousCandleClose) / previousCandleClose) * 100;
    }

    // tendência calculada sempre em relação à vela anterior
    const trendPct = previousCandleClose
        ? ((currentPrice - previousCandleClose) / previousCandleClose) * 100
        : null;
    trend = secureTrend === 0 ? true : (trendPct !== null && trendPct >= -secureTrend);

    if (tradeSide === 'BUY' && (rsi <= rsiBuy || rsiBuy === 0)) {
        const okVariacao = changePercentage <= -alvoBuy;
        const okTrend = trend;
        const okHighFilter = belowDailyHigh;

        if (!okVariacao || !okTrend || !okHighFilter) {
            console.log(chalk.gray(
                `[BUY] Aguardando condições → ` +
                `Variação: ${changePercentage.toFixed(3)}% (alvo ≤ -${alvoBuy}%) ${okVariacao ? '✅' : '❌'} | ` +
                `Trend: ${okTrend ? '✅' : `❌ (${changePercentage.toFixed(3)}% < -${secureTrend}%)`} | ` +
                `SecureHigh: ${okHighFilter ? '✅' : '❌'}`
            ));
        }

        if (changePercentage <= -alvoBuy && trend && belowDailyHigh) {

            await balanceUpdt();
            console.log(`[${new Date().toLocaleTimeString()}] Ordem de Compra acionada`);

            let quantity;
            const minAmtQty = minAmt / currentPrice;

            if (cfg.operacao.reinvestMode === 'equal') {
                // use accumulated opposite-side quantity
                quantity = getEqualQty('BUY');
                if (!(quantity > 0)) {
                    if (strategy === 'SHORT') {
                        const amountSell = sellAmount || getEffectiveBalanceQty(currentPrice) * sellPrice;
                        quantity = Math.max((amountSell * pctCompra) / (currentPrice * (1 + TAX_MARKET)), minAmtQty);
                    } else {
                        const effectiveAmt = getEffectiveBalanceAmt(currentPrice);
                        quantity = Math.max((effectiveAmt * pctBaseLong) / (currentPrice * (1 + TAX_MARKET)), minAmtQty);
                    }
                }
                console.log(chalk.magenta(`[REINVEST] equal mode: using qty ${quantity}`));
            } else if (strategy === 'SHORT') {
                const amountSell = sellAmount || getEffectiveBalanceQty(currentPrice) * sellPrice;
                quantity = Math.max((amountSell * pctCompra) / (currentPrice * (1 + TAX_MARKET)), minAmtQty);
            } else {
                const effectiveAmt = getEffectiveBalanceAmt(currentPrice);
                quantity = Math.max((effectiveAmt * pctBaseLong) / (currentPrice * (1 + TAX_MARKET)), minAmtQty);
            }

            const order = await createOrder('BUY', quantity, false, true); // marca como fechamento ou ordem "normal"

            if (order) {
                // após qualquer compra "normal" trocamos o lado para SELL
                tradeSide = 'SELL';
                sellPrice = null;
                sellAmount = null;
                console.log(`✅ Compra executada: ${quantity} ${moeda}`);
                console.log('-----------------------------------');
            }
        }
    }
}

// ─────────────────────────────────────────────
// Loop Principal de Monitoramento
// ─────────────────────────────────────────────

async function monitor() {
    try {
        // buscar preço atual no cache server
        const resp = await fetch(`${CACHE_URL}/price?symbol=${symbol}`);
        if (resp.ok) {
            const json = await resp.json();
            currentPrice = parseFloat(json.price);
        } else {
            console.warn('[monitor] falha ao obter preço', resp.status);
        }
        await update24hStats();

        if (currentPrice === undefined || currentPrice === null || isNaN(currentPrice)) {
            throw new Error('Preço atual inválido');
        }

        const newCandleClose = await getLastCandle();
        if (newCandleClose) previousCandleClose = newCandleClose;

        const rsiRaw = await updtRsi.getValue(symbol, candleInterval, rsiPeriod);
        if (rsiRaw === null || rsiRaw === undefined || Number.isNaN(Number(rsiRaw))) {
            console.warn('Aviso: RSI indisponível neste ciclo — execuções dependentes de RSI serão ignoradas.');
            rsi = null;
        } else {
            rsi = Math.round(Number(rsiRaw));
        }

        // Variação para exibição no log
        let changePercentRaw = null;
        if ((strategy === 'SHORT' && tradeSide === 'SELL') || (strategy === 'LONG' && tradeSide === 'BUY')) {
            changePercentRaw = previousCandleClose
                ? ((currentPrice - previousCandleClose) / previousCandleClose * 100)
                : null;
        } else if (strategy === 'SHORT' && tradeSide === 'BUY') {
            changePercentRaw = sellPrice ? ((currentPrice - sellPrice) / sellPrice * 100) : null;
        } else if (strategy === 'LONG' && tradeSide === 'SELL') {
            changePercentRaw = buyPrice ? ((currentPrice - buyPrice) / buyPrice * 100) : null;
        }

        const changePercentLog = changePercentRaw !== null ? `${changePercentRaw.toFixed(2)}%` : 'N/A';

        // Stop Loss
        if (strategy === 'LONG') await checkStopLossLong();
        else if (strategy === 'SHORT') await checkStopLossShort();

        // ── Log de Status ────────────────────────────
        const changeColor = changePercentRaw > 0 ? chalk.green : chalk.red;
        const priceNow = chalk.white.bold(`${currentPrice}`);
        const intervalVar = chalk.white.bold(`${candleInterval}`);
        const lastSell = sellPrice ? chalk.blackBright(`${sellPrice.toFixed(6)}`) : chalk.gray('N/A');
        const lastBuy = buyPrice ? chalk.blackBright(`${buyPrice.toFixed(6)}`) : chalk.gray('N/A');
        const tradeSideColor = tradeSide === 'SELL'
            ? chalk.white.bgRed.bold(` ${tradeSide} `) + chalk.black.bgBlack('.')
            : chalk.white.bgGreen.bold(` ${tradeSide} `) + chalk.black.bgBlack('.');

        const aboveDailyLow = dailyLow ? currentPrice > (dailyLow * secureLow) : null;
        const belowDailyHigh = dailyHigh ? currentPrice < (dailyHigh / secureHigh) : null;
        const secureLowStatus = aboveDailyLow ? chalk.white.bold('true') : chalk.magenta.bold('false');
        const secureHighStatus = belowDailyHigh ? chalk.white.bold('true') : chalk.magenta.bold('false');
        const trendStatus = trend ? chalk.white.bold('true') : chalk.magenta.bold('false');

        const lucroAcum = stats.financeiro.lucroLiquidoTotal;
        const lucroColor = lucroAcum >= 0 ? chalk.green.bold : chalk.red.bold;
        const lucroStr = `${lucroAcum >= 0 ? '+' : ''}${lucroAcum.toFixed(4)} ${base}`;
        const demoTag = DEMO ? chalk.yellow.bold('[DEMO] ') : '';

        if (strategy === 'SHORT') {
            console.log(`${demoTag}[${new Date().toLocaleTimeString()}] Preço: ${priceNow} | Lucro: ${lucroColor(lucroStr)}`);
            console.log(`Última venda: ${lastSell}`);
            console.log(`Variação (${intervalVar}): ${changeColor(changePercentLog)}`);
            console.log(`Modo: ${tradeSideColor}`);
            if (tradeSide === 'SELL') console.log(`SecureLow: ${secureLowStatus}`);
            else console.log(`SecureHigh: ${secureHighStatus}`);
            console.log(`SecureTrend: ${trendStatus} | RSI: ${rsi}`);
        } else {
            console.log(`${demoTag}[${new Date().toLocaleTimeString()}] Preço: ${priceNow} | Lucro: ${lucroColor(lucroStr)}`);
            console.log(`Última compra: ${lastBuy}`);
            console.log(`Variação (${intervalVar}): ${changeColor(changePercentLog)}`);
            console.log(`Side: ${tradeSideColor}`);
            if (tradeSide === 'BUY') console.log(`SecureHigh: ${secureHighStatus}`);
            else console.log(`SecureLow: ${secureLowStatus}`);
            console.log(`SecureTrend: ${trendStatus} | RSI: ${rsi}`);
        }

        // Painel de desempenho acumulado
        logStats();

        if (rsi === null && (rsiBuy !== 0 || rsiSell !== 0)) {
            console.log(chalk.yellow('RSI ausente e não-zero nas configurações. Pulando estratégias que dependem de RSI.'));
        } else {
            if (dcaEnabled && dcaStrategy && dcaStrategy.isActive) {
                // com DCA ativo, precisamos verificar ambos os lados: extras e possíveis fechamentos
                await executeSellStrategy();
                await executeBuyStrategy();
            } else {
                if (tradeSide === 'SELL') await executeSellStrategy();
                else await executeBuyStrategy();
            }
        }

        // Dentro da função monitor(), após o log existente, adicione:
        if (dcaEnabled && dcaStrategy && dcaStrategy.isActive) {
            const posInfo = dcaStrategy.getPositionInfo();
            const profitNow = dcaStrategy.calculateGuaranteedProfit(currentPrice);
            const profitPercentNow = dcaStrategy.calculateProfitPercent(currentPrice);

            console.log(chalk.magentaBright(`📊 DCA Ativo: #${posInfo.ordersCount}/${posInfo.maxOrders} ordens | Preço médio: ${posInfo.averageEntryPrice.toFixed(6)}`));
            console.log(chalk.magentaBright(`   Alvo: ${posInfo.currentTargetPrice.toFixed(6)} | Lucro atual: ${profitNow.toFixed(4)} ${base} (${profitPercentNow.toFixed(2)}%)`));
            console.log(chalk.magentaBright('-----------------------------------'));
        }

    } catch (error) {
        console.error('Erro no monitoramento:', error.message);
    }
}

// ─────────────────────────────────────────────
// Inicialização
// ─────────────────────────────────────────────

(async () => {
    const modeLabel = DEMO
        ? chalk.yellow.bold('⚠️  MODO DEMO ATIVADO — Nenhuma ordem real será enviada')
        : chalk.green.bold('🟢 MODO REAL');

    console.log(modeLabel);
    console.log(`Estratégia: ${strategy} | Par: ${symbol} | Intervalo: ${candleInterval}`);
    console.log(`Taxas configuradas → Market: ${(TAX_MARKET * 100).toFixed(2)}% | Limit: ${(TAX_LIMIT * 100).toFixed(3)}%`);
    console.log('-----------------------------------');

    await updateMinOrderQty();
    await applySymbolFeesOnInit();

    // Inicializa sessão nas stats (apenas na primeira execução)
    // Se a sessão anterior for de outro modo (DEMO vs REAL) ou par diferente, reinicializa sessão
    const currentModeLabel = DEMO ? 'DEMO' : 'REAL';
    if (!stats.sessao.inicio || stats.sessao.modo !== currentModeLabel || stats.sessao.symbol !== symbol) {
        // Se já existia uma sessão anterior, arquiva o arquivo de stats atual para histórico
        if (stats && stats.sessao && stats.sessao.inicio) {
            archiveStats(stats);
            stats = defaultStats();
        }

        stats.sessao.inicio = new Date().toISOString();
        stats.sessao.modo = currentModeLabel;
        stats.sessao.symbol = symbol;
        // Atualiza saldos iniciais para refletir o modo/par atual
        stats.financeiro.saldoInicialBase = DEMO ? demoBalance.base : balanceAmt;
        stats.financeiro.saldoAtualBase = stats.financeiro.saldoInicialBase;
        stats.financeiro.saldoInicialMoeda = DEMO ? demoBalance.moeda : balanceQty;
        stats.financeiro.saldoAtualMoeda = stats.financeiro.saldoInicialMoeda;
    } else if (stats.financeiro.saldoInicialBase === null) {
        stats.financeiro.saldoInicialBase = DEMO ? demoBalance.base : balanceAmt;
        stats.financeiro.saldoAtualBase = stats.financeiro.saldoInicialBase;
        stats.financeiro.saldoInicialMoeda = DEMO ? demoBalance.moeda : balanceQty;
        stats.financeiro.saldoAtualMoeda = stats.financeiro.saldoInicialMoeda;
    }
    saveStats(stats);

    await monitor();
    setInterval(monitor, monitoringInterval);
})();