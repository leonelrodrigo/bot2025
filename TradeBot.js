/* eslint-disable no-unused-vars */
// ─────────────────────────────────────────────────────────────────────────────
// TradeBot.js — Versão 2.0
// Estratégias LONG e SHORT | Modo DEMO e REAL | DCA integrado
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config({ override: true });

const Binance = require('binance-api-node').default;
const DCAStrategy = require('./dcaStrategy.js');
const chalk = require('chalk');
const updtRsi = require('./rsi.js');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES GLOBAIS
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_URL = process.env.CACHE_URL || `http://localhost:${process.env.CACHE_PORT || 4000}`;
const DATA_DIR = path.join(__dirname, 'data');
const SAFETY_MARGIN = 0.999; // margem para arredondamentos de saldo

// ─────────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS DE SISTEMA DE ARQUIVOS
// ─────────────────────────────────────────────────────────────────────────────

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
ensureDataDir();

function readJson(filePath, fallback = null) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.warn(`⚠️  Falha ao ler ${filePath}: ${e.message}`);
    }
    return fallback;
}

function writeJson(filePath, data) {
    try {
        ensureDataDir();
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error(`⚠️  Falha ao gravar ${filePath}: ${e.message}`);
    }
}

function copyDir(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name), d = path.join(dest, ent.name);
        ent.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
    }
}

function nowStr() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ARGUMENTOS CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseCLI() {
    const args = process.argv.slice(2);
    const get = prefix => (args.find(a => a.startsWith(prefix)) || '').split('=')[1] || '';

    if (args.includes('--list-bots')) {
        ensureDataDir();
        const ids = new Set();
        fs.readdirSync(DATA_DIR).forEach(f => {
            const m = f.match(/^(.*?)_(config|stats|state)\.json$/);
            if (m) ids.add(m[1]);
        });
        if (fs.existsSync(path.join(DATA_DIR, 'config.json'))) ids.add('(default)');
        console.log('Bots encontrados:');
        ids.forEach(id => console.log(` • ${id}`));
        process.exit(0);
    }

    const removeId = get('--remove-id=');
    if (removeId !== undefined && args.some(a => a.startsWith('--remove-id='))) {
        const prefix = removeId ? `${removeId}_` : '';
        ['config', 'stats', 'state'].forEach(t => {
            const f = path.join(DATA_DIR, `${prefix}${t}.json`);
            if (fs.existsSync(f)) fs.unlinkSync(f);
        });
        const arch = path.join(DATA_DIR, removeId ? `stats_archives_${removeId}` : 'stats_archives');
        if (fs.existsSync(arch)) fs.rmSync(arch, { recursive: true, force: true });
        console.log(`🗑️  Dados do bot '${removeId || 'default'}' removidos.`);
        process.exit(0);
    }

    const backupId = get('--backup-id=');
    if (args.some(a => a.startsWith('--backup-id='))) {
        ensureDataDir();
        const dest = path.join(DATA_DIR, `backup_${backupId || 'default'}_${Date.now()}`);
        fs.mkdirSync(dest, { recursive: true });
        const prefix = backupId ? `${backupId}_` : '';
        ['config', 'stats', 'state'].forEach(t => {
            const f = path.join(DATA_DIR, `${prefix}${t}.json`);
            if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dest, path.basename(f)));
        });
        const arch = path.join(DATA_DIR, backupId ? `stats_archives_${backupId}` : 'stats_archives');
        if (fs.existsSync(arch)) copyDir(arch, path.join(dest, path.basename(arch)));
        console.log(`🗃️  Backup salvo em ${dest}`);
        process.exit(0);
    }

    const resetId = get('--reset-id=');
    if (args.some(a => a.startsWith('--reset-id='))) {
        const prefix = resetId ? `${resetId}_` : '';
        const sf = path.join(DATA_DIR, `${prefix}stats.json`);
        const stf = path.join(DATA_DIR, `${prefix}state.json`);
        if (fs.existsSync(sf)) writeJson(sf, defaultStats());
        if (fs.existsSync(stf)) fs.unlinkSync(stf);
        console.log(`🔄 Bot '${resetId || 'default'}' resetado.`);
        process.exit(0);
    }

    const id = get('--id=') || process.env.BOT_ID || '';
    return id;
}

const BOT_ID = parseCLI();
const PREFIX = BOT_ID ? `${BOT_ID}_` : '';

const CONFIG_PATH = path.join(DATA_DIR, `${PREFIX}config.json`);
const STATS_PATH = path.join(DATA_DIR, `${PREFIX}stats.json`);
const STATE_PATH = path.join(DATA_DIR, `${PREFIX}state.json`);
const STEP_CACHE = path.join(DATA_DIR, 'step_cache.json');

// ─────────────────────────────────────────────────────────────────────────────
// ESQUEMAS PADRÃO
// ─────────────────────────────────────────────────────────────────────────────

function defaultConfig() {
    return {
        modo: { demo: true, base: 'USDT', moeda: 'ETH', strategy: 'LONG', tradeSide: 'BUY' },
        taxas: { market: 0.001, limit: 0.0005 },
        timing: { monitoringInterval: 30000, candleInterval: '15m', rsiPeriod: 14 },
        rsi: { rsiBuy: 30, rsiSell: 70 },
        alvos: { alvoBuy: 0, alvoSell: 0 },
        seguranca: {
            secureTrend: 0, secureLow: 0, secureHigh: 0,
            stopLossPercentLong: 0, stopLossPercentShort: 0,
            pctBaseLong: 0.25, pctMoedaShort: 0.25,
        },
        operacao: { reinvestProfits: false, reinvestMode: 'equal' },
        dca: {
            enabled: false, maxOrders: 3, targetPercent: 0.25,
            adaptiveStopLoss: true, stopLossBuffer: 1.5,
            profitConfig: {
                baseProfit: 0.25, extraOrderMultiplier: 1.2,
                minTotalProfit: 0.25, maxTotalProfit: 1.0,
            },
        },
        demo_saldo_inicial: { USDT: 1000, moeda: 0 },
    };
}

function defaultStats() {
    return {
        sessao: { inicio: null, modo: null, symbol: null },
        trades: { total: 0, lucrativos: 0, prejuizo: 0, stopLossAcionados: 0 },
        financeiro: {
            lucroLiquidoTotal: 0, taxasTotais: 0,
            maiorLucroTrade: 0, maiorPrejuizoTrade: 0,
            saldoInicialBase: null, saldoAtualBase: null,
            saldoInicialMoeda: null, saldoAtualMoeda: null,
        },
        historico: [],
    };
}

function defaultState() {
    return {
        tradeSide: null,
        buyPrice: null,
        sellPrice: null,
        buyAmount: null,
        sellAmount: null,
        // campos adicionados na v2 — ausentes em states antigos são migrados por normalizeState()
        cycleStartBalanceBase: null,
        cycleStartBalanceMoeda: null,
        profitBankBase: 0,
        dca: {
            isActive: false,
            ordersCount: 0,
            maxOrders: 4,
            averageEntryPrice: 0,
            totalQuantity: 0,
            totalCost: 0,
            currentTargetPrice: 0,
            expectedProfit: 0,
            expectedProfitPercent: 0,
            positions: [],
            lastActionPrice: null,
        },
    };
}

// Migração suave: aceita states antigos (sem campos v2) e states novos.
// Nunca lança exceção — em pior caso retorna o default.
function normalizeState(raw) {
    const def = defaultState();
    if (!raw || typeof raw !== 'object') return def;
    return {
        tradeSide: raw.tradeSide ?? def.tradeSide,
        buyPrice: raw.buyPrice ?? def.buyPrice,
        sellPrice: raw.sellPrice ?? def.sellPrice,
        buyAmount: raw.buyAmount ?? def.buyAmount,
        sellAmount: raw.sellAmount ?? def.sellAmount,
        // campos v2: se ausentes no state antigo, inicializa com default (migração automática)
        cycleStartBalanceBase: raw.cycleStartBalanceBase ?? def.cycleStartBalanceBase,
        cycleStartBalanceMoeda: raw.cycleStartBalanceMoeda ?? def.cycleStartBalanceMoeda,
        profitBankBase: typeof raw.profitBankBase === 'number' ? raw.profitBankBase : def.profitBankBase,
        // dca: merge profundo para preservar campos do state antigo
        dca: raw.dca != null ? { ...def.dca, ...raw.dca } : def.dca,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP DE CONFIG
// ─────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(CONFIG_PATH)) {
    const base = path.join(DATA_DIR, 'config.json');
    writeJson(CONFIG_PATH, fs.existsSync(base) ? readJson(base) : defaultConfig());
    writeJson(STATS_PATH, defaultStats());
    writeJson(STATE_PATH, defaultState());
    if (BOT_ID) console.log(chalk.yellow(`🔖 Bot ID: ${BOT_ID}`));
    console.log(chalk.yellow(`🛠️  Config criada em ${CONFIG_PATH}. Edite e execute novamente.`));
    process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// CARREGA CONFIG
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
    const raw = readJson(CONFIG_PATH);
    if (!raw) { console.error(`❌ Erro ao carregar ${CONFIG_PATH}`); process.exit(1); }
    // garante sub-objetos obrigatórios com defaults
    raw.operacao = raw.operacao || {};
    raw.operacao.reinvestProfits = raw.operacao.reinvestProfits ?? false;
    raw.operacao.reinvestMode = raw.operacao.reinvestMode ?? 'equal';
    raw.dca = raw.dca || {};
    raw.dca.profitConfig = raw.dca.profitConfig || {};
    return raw;
}

let cfg = loadConfig();

if (BOT_ID) console.log(chalk.yellow(`🔖 Bot ID: ${BOT_ID}`));

// ─────────────────────────────────────────────────────────────────────────────
// VARIÁVEIS DE CONFIG (mutáveis via hot-reload)
// ─────────────────────────────────────────────────────────────────────────────

let DEMO = cfg.modo.demo;
let base = cfg.modo.base;
let moeda = cfg.modo.moeda;
let symbol = `${moeda}${base}`;
let strategy = cfg.modo.strategy;   // 'LONG' | 'SHORT'

let TAX_MARKET = cfg.taxas.market;
let TAX_LIMIT = cfg.taxas.limit;

let monitoringInterval = cfg.timing.monitoringInterval;
let candleInterval = cfg.timing.candleInterval;
let rsiPeriod = cfg.timing.rsiPeriod;

let rsiBuy = cfg.rsi.rsiBuy;
let rsiSell = cfg.rsi.rsiSell;
let alvoBuy = cfg.alvos.alvoBuy;
let alvoSell = cfg.alvos.alvoSell;

let secureTrend = cfg.seguranca.secureTrend;
let secureLow = cfg.seguranca.secureLow;
let secureHigh = cfg.seguranca.secureHigh;
let stopLossPercentLong = cfg.seguranca.stopLossPercentLong;
let stopLossPercentShort = cfg.seguranca.stopLossPercentShort;
let pctBaseLong = parseFloat(cfg.seguranca.pctBaseLong ?? 0.25);
let pctMoedaShort = parseFloat(cfg.seguranca.pctMoedaShort ?? 0.25);

let dcaEnabled = cfg.dca?.enabled || false;
let dcaMaxOrders = cfg.dca?.maxOrders || 3;
let dcaTargetPercent = cfg.dca?.targetPercent || 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO DE RUNTIME
// ─────────────────────────────────────────────────────────────────────────────

let currentPrice = null;
let rsi = null;
let trend = null;
let dailyLow = null;
let dailyHigh = null;
let previousCandleClose = null;
let candleInitialized = false;
let isOrderPending = false;

// saldos reais (REAL) ou espelhados do demo
let balanceAmt = null;   // base  (ex: USDT)
let balanceQty = null;   // moeda (ex: ETH)

// filtros de ordem
let minQty = null;
let minAmt = null;
let stepSize = null;

// posição atual
let tradeSide = cfg.modo.tradeSide;
let buyPrice = null;
let sellPrice = null;
let buyAmount = null;
let sellAmount = null;

// rastreamento de ciclo (capturado na primeira ordem de cada ciclo)
let cycleStartBalanceBase = null;
let cycleStartBalanceMoeda = null;

// banco de lucros acumulados aguardando tamanho mínimo para operar
let profitBankBase = 0;

// DCA
let dcaStrategy = null;

// taxas por símbolo
let tradeFeePerSymbol = {};
let tradeFeeCache = { ts: 0, data: null };

// ─────────────────────────────────────────────────────────────────────────────
// SALDO DEMO
// ─────────────────────────────────────────────────────────────────────────────

const demoBalance = {
    base: cfg.demo_saldo_inicial?.[base] ?? cfg.demo_saldo_inicial?.base ?? 1000,
    moeda: cfg.demo_saldo_inicial?.moeda ?? 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTE BINANCE
// ─────────────────────────────────────────────────────────────────────────────

const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
});

// ─────────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────────

function normalizeStats(raw) {
    const base_ = defaultStats();
    if (!raw || typeof raw !== 'object') return base_;
    return {
        ...base_, ...raw,
        sessao: { ...base_.sessao, ...(raw.sessao || {}) },
        trades: { ...base_.trades, ...(raw.trades || {}) },
        financeiro: { ...base_.financeiro, ...(raw.financeiro || {}) },
        historico: Array.isArray(raw.historico) ? raw.historico : [],
    };
}

let stats = normalizeStats(readJson(STATS_PATH));

function saveStats() {
    writeJson(STATS_PATH, stats);
}

function archiveStats() {
    const dir = path.join(DATA_DIR, BOT_ID ? `stats_archives_${BOT_ID}` : 'stats_archives');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    writeJson(path.join(dir, `stats_${ts}.json`), stats);
    console.log(chalk.blue(`📦 Stats arquivados`));
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO PERSISTIDO
// ─────────────────────────────────────────────────────────────────────────────

function loadPersistedState() {
    // normalizeState garante compatibilidade com states antigos (sem campos v2)
    const s = normalizeState(readJson(STATE_PATH));

    if (s.tradeSide) tradeSide = s.tradeSide;
    if (s.buyPrice != null) buyPrice = s.buyPrice;
    if (s.sellPrice != null) sellPrice = s.sellPrice;
    if (s.buyAmount != null) buyAmount = s.buyAmount;
    if (s.sellAmount != null) sellAmount = s.sellAmount;

    // campos v2 (ausentes em states antigos chegam como null/0 após normalizeState)
    if (s.cycleStartBalanceBase != null) cycleStartBalanceBase = s.cycleStartBalanceBase;
    if (s.cycleStartBalanceMoeda != null) cycleStartBalanceMoeda = s.cycleStartBalanceMoeda;
    if (s.profitBankBase > 0) profitBankBase = s.profitBankBase;

    if (dcaEnabled && s.dca?.isActive) {
        dcaStrategy = restoreDcaState(s.dca);
        if (dcaStrategy?.isActive) {
            console.log(chalk.green(`✅ DCA restaurado (${dcaStrategy.ordersCount}/${1 + dcaStrategy.maxExtraOrders} ordens)`));
        }
    } else if (s.dca && !s.dca.isActive) {
        // state.json com dca.isActive=false é normal — não restaura DCA, sem log de erro
        console.log(chalk.gray(`[STATE] DCA inativo no state salvo — ok.`));
    }
}

function restoreDcaState(saved) {
    if (!saved?.isActive) return null;
    const dca = new DCAStrategy({
        maxOrders: dcaMaxOrders, targetPercent: dcaTargetPercent,
        symbol, base, moeda, strategy,
        profitConfig: cfg.dca?.profitConfig || {},
    });
    const keys = [
        'positions', 'currentTargetPrice', 'initialPositionPrice', 'totalQuantity',
        'totalCost', 'totalValue', 'averageEntryPrice', 'ordersCount', 'isActive',
        'lastActionPrice', 'expectedProfit', 'expectedProfitPercent',
        'profitPerOrder', 'weightedTargetPrice',
    ];
    keys.forEach(k => { if (saved[k] !== undefined) dca[k] = saved[k]; });
    return dca;
}

function getCurrentState() {
    // Sempre grava o objeto dca completo para manter o schema estável no state.json.
    // Campos booleanos/numéricos têm defaults seguros quando DCA está inativo.
    const def = defaultState();
    let dcaSnapshot = { ...def.dca };

    if (dcaEnabled && dcaStrategy) {
        const info = dcaStrategy.getPositionInfo();
        dcaSnapshot = {
            isActive: info.isActive,
            ordersCount: info.ordersCount,
            maxOrders: info.maxOrders,
            averageEntryPrice: info.averageEntryPrice || 0,
            totalQuantity: info.totalQuantity || 0,
            totalCost: info.totalCost || 0,
            currentTargetPrice: info.currentTargetPrice || 0,
            expectedProfit: info.expectedProfit || 0,
            expectedProfitPercent: info.expectedProfitPercent || 0,
            positions: info.positions || [],
            lastActionPrice: dcaStrategy.lastActionPrice ?? null,
        };
    }

    return {
        tradeSide,
        buyPrice,
        sellPrice,
        buyAmount,
        sellAmount,
        cycleStartBalanceBase,
        cycleStartBalanceMoeda,
        profitBankBase,
        dca: dcaSnapshot,
    };
}

function saveState() {
    writeJson(STATE_PATH, getCurrentState());
}

function validateState() {
    const eps = 1e-8;
    const hasQty = balanceQty != null && balanceQty > eps;
    const hasBase = balanceAmt != null && balanceAmt > eps;
    let bad = false;

    if (strategy === 'LONG' && tradeSide === 'SELL' && !hasQty) bad = true;
    if (strategy === 'SHORT' && tradeSide === 'BUY' && !hasBase) bad = true;
    if (dcaStrategy?.isActive && (!dcaStrategy.isActive || dcaStrategy.totalQuantity <= 0)) bad = true;

    if (bad) {
        console.warn(chalk.yellow('⚠️  Estado persistido inconsistente — resetando.'));
        tradeSide = cfg.modo.tradeSide;
        buyPrice = sellPrice = buyAmount = sellAmount = null;
        cycleStartBalanceBase = cycleStartBalanceMoeda = null;
        profitBankBase = 0;
        dcaStrategy?.cancel('Estado inconsistente');
        dcaStrategy = null;
        writeJson(STATE_PATH, defaultState());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOT-RELOAD DE CONFIG
// ─────────────────────────────────────────────────────────────────────────────

function applyConfig(newCfg) {
    cfg = newCfg;
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
    cfg.operacao = cfg.operacao || {};
    cfg.operacao.reinvestProfits = cfg.operacao.reinvestProfits ?? false;
    cfg.operacao.reinvestMode = cfg.operacao.reinvestMode ?? 'equal';
    console.log(chalk.green('[CONFIG] Recarregado.'));
}

fs.watchFile(CONFIG_PATH, { interval: 1500 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    try { applyConfig(loadConfig()); } catch (e) { console.error('[CONFIG] Falha ao recarregar:', e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CACHE SERVER — FETCH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function cacheGet(endpoint, params = {}) {
    const url = new URL(`${CACHE_URL}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.append(k, v); });
    const res = await fetch(url.href);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Cache ${res.status} ${res.statusText}`);
    return res.json();
}

async function getPrice() {
    let attempts = 0;
    while (attempts++ < 3) {
        try {
            // acorda o rastreamento do símbolo
            await fetch(`${CACHE_URL}/cache?symbol=${symbol}&interval=${candleInterval}`).catch(() => { });
            const data = await cacheGet('price', { symbol });
            const p = parseFloat(data?.price);
            if (p > 0) { currentPrice = p; return; }
        } catch (_) { }
        await sleep(100);
    }
    throw new Error('Preço indisponível após 3 tentativas');
}

async function update24hStats() {
    try {
        const d = await cacheGet('stats24h', { symbol });
        if (d) { dailyLow = parseFloat(d.lowPrice); dailyHigh = parseFloat(d.highPrice); }
    } catch (e) { console.warn('[24h]', e.message); }
}

async function getLastCandleClose() {
    try {
        const arr = await cacheGet(`cache`, { symbol, interval: candleInterval });
        if (!Array.isArray(arr) || arr.length < 2) return null;
        return parseFloat(arr[arr.length - 2]);
    } catch (e) { console.warn('[candle]', e.message); return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SALDO
// ─────────────────────────────────────────────────────────────────────────────

async function balanceUpdt() {
    try {
        if (DEMO) {
            balanceAmt = demoBalance.base;
            balanceQty = demoBalance.moeda;
        } else {
            const info = await withRetry(() => client.accountInfo(), 3, 1000);
            balanceAmt = parseFloat(info.balances.find(b => b.asset === base)?.free ?? 0);
            balanceQty = parseFloat(info.balances.find(b => b.asset === moeda)?.free ?? 0);
        }
        const tag = DEMO ? chalk.yellow('[DEMO] ') : '';
        console.log(`${tag}Saldo ${base}: ${balanceAmt?.toFixed(4)} | ${moeda}: ${balanceQty}`);
        console.log(chalk.gray('───────────────────────────────────'));
    } catch (e) { console.error('Erro ao atualizar saldo:', e.message); }
}

function getAvailableBase() { return DEMO ? demoBalance.base : balanceAmt; }
function getAvailableMoeda() { return DEMO ? demoBalance.moeda : balanceQty; }

// ─────────────────────────────────────────────────────────────────────────────
// FILTROS DE ORDEM (LOT_SIZE / MIN_NOTIONAL)
// ─────────────────────────────────────────────────────────────────────────────

async function updateMinOrderQty() {
    try {
        let info = null;
        try { info = await cacheGet('exchangeInfo', { symbol }); } catch (e) { /* fallback */ }

        if (!info?.symbol) {
            const cached = readJson(STEP_CACHE, {})[symbol];
            if (cached) {
                ({ stepSize, minQty, minAmt } = cached);
                console.log(chalk.yellow(`[FILTERS] Usando cache local: step=${stepSize} minQty=${minQty} minAmt=${minAmt}`));
                await balanceUpdt();
                return;
            }
            throw new Error('ExchangeInfo indisponível e sem cache local.');
        }

        const lotSize = info.filters.find(f => f.filterType === 'LOT_SIZE');
        const notional = info.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');

        if (lotSize) {
            minQty = parseFloat(lotSize.minQty);
            stepSize = parseFloat(lotSize.stepSize);
        }
        minAmt = notional ? parseFloat(notional.minNotional) : 5;

        const cache = readJson(STEP_CACHE, {});
        cache[symbol] = { stepSize, minQty, minAmt };
        writeJson(STEP_CACHE, cache);

        console.log(`Filtros ${symbol}: minAmt=${minAmt} minQty=${minQty} stepSize=${stepSize}`);
        await balanceUpdt();
    } catch (e) {
        console.error('Erro ao obter filtros:', e.message);
    }
}

async function adjustQty(requestQty, side) {
    if (!stepSize || !currentPrice || !minAmt || !minQty) await updateMinOrderQty();
    if (!stepSize || !currentPrice || !minAmt || !minQty) return parseFloat(requestQty.toFixed(8));

    const prec = Math.max(0, Math.ceil(-Math.log10(stepSize)));
    const minQtyAligned = Math.ceil(minQty / stepSize) * stepSize;

    let q = Math.floor(requestQty / stepSize) * stepSize;
    q = parseFloat(q.toFixed(prec));
    if (q < minQtyAligned) q = minQtyAligned;

    // garante minNotional
    let guard = 0;
    while (q * currentPrice < minAmt && guard++ < 100000) q = parseFloat((q + stepSize).toFixed(prec));
    if (q * currentPrice < minAmt) { console.warn('[ADJUST] Não atingiu minNotional.'); return null; }

    // limites de saldo
    if (side === 'BUY') {
        const avail = getAvailableBase();
        if (q * currentPrice * (1 + TAX_MARKET) * SAFETY_MARGIN > avail) {
            let maxQ = Math.floor(avail / (1 + TAX_MARKET) / currentPrice / stepSize) * stepSize;
            maxQ = parseFloat(maxQ.toFixed(prec));
            if (maxQ < minQtyAligned || maxQ * currentPrice < minAmt) return null;
            return maxQ;
        }
    }
    if (side === 'SELL') {
        const avail = getAvailableMoeda();
        if (q > avail) {
            let maxQ = Math.floor(avail / stepSize) * stepSize;
            maxQ = parseFloat(maxQ.toFixed(prec));
            if (maxQ < minQtyAligned || maxQ * currentPrice < minAmt) return null;
            return maxQ;
        }
    }
    return q;
}

// ─────────────────────────────────────────────────────────────────────────────
// TAXAS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchTradeFees() {
    if (DEMO) return;
    const now = Date.now();
    if (tradeFeeCache.data && now - tradeFeeCache.ts < 10 * 60 * 1000) return;
    try {
        const fees = await cacheGet('tradeFee', { symbol });
        if (fees) {
            tradeFeeCache = { ts: now, data: fees };
            if (Array.isArray(fees)) {
                const f = fees.find(f => f.symbol === symbol);
                if (f) tradeFeePerSymbol[symbol] = parseFloat(f.taker ?? f.fee ?? TAX_MARKET);
            }
        }
    } catch (e) { console.warn('[FEES]', e.message); }
}

async function calcFeeInBase(order) {
    if (!order) return 0;
    if (order.fills?.length) {
        let total = 0;
        for (const f of order.fills) {
            const comm = parseFloat(f.commission || 0);
            if (!comm) continue;
            if (f.commissionAsset === base) { total += comm; continue; }
            const rate = await convertToBase(f.commissionAsset);
            if (rate) total += comm * rate;
        }
        return total;
    }
    const execQuote = parseFloat(order.cummulativeQuoteQty || 0);
    return execQuote * (tradeFeePerSymbol[symbol] ?? TAX_MARKET);
}

async function convertToBase(asset) {
    if (asset === base) return 1;
    const tryPrice = async (pair) => {
        try {
            const r = await fetch(`${CACHE_URL}/price?symbol=${pair}`);
            if (r.ok) { const j = await r.json(); const p = parseFloat(j.price); if (p > 0) return p; }
        } catch (_) { }
        return null;
    };
    let p = await tryPrice(`${asset}${base}`);
    if (p) return p;
    p = await tryPrice(`${base}${asset}`);
    if (p) return 1 / p;
    for (const mid of ['BTC', 'USDT', 'ETH', 'BNB']) {
        if (mid === asset || mid === base) continue;
        let aToMid = await tryPrice(`${asset}${mid}`) ?? (1 / await tryPrice(`${mid}${asset}`) || null);
        let midToBase = await tryPrice(`${mid}${base}`) ?? (1 / await tryPrice(`${base}${mid}`) || null);
        if (aToMid && midToBase) return aToMid * midToBase;
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// REINVESTIMENTO — LÓGICA CENTRAL
// ─────────────────────────────────────────────────────────────────────────────
//
//  reinvestMode:
//    "base"  — mantém lucro em base (USDT). Saldo base cresce, posições iguais.
//    "moeda" — converte lucro para moeda (BTC/ETH). Usa reinvestProfits=true.
//    "equal" — normaliza tamanho da próxima ordem para igualar à média das ordens do ciclo anterior.
//
// ─────────────────────────────────────────────────────────────────────────────

async function accumulateProfit(lucroBase) {
    if (lucroBase <= 0) return;

    const reinvest = cfg.operacao.reinvestProfits;
    const mode = cfg.operacao.reinvestMode ?? 'equal';

    console.log(chalk.magenta(
        `[REINVEST] strategy=${strategy} mode=${mode} reinvest=${reinvest} lucro=${lucroBase.toFixed(8)} ${base}`
    ));

    // ── LONG ────────────────────────────────────────────────────────────────
    if (strategy === 'LONG') {
        if (mode === 'base' || !reinvest) {
            // "base": lucro fica em USDT. cycleStartBalanceBase define o nível de restauração.
            // Se abaixo do nível inicial do ciclo, restaura até lá; excedente vai para banco.
            const target = cycleStartBalanceBase || 0;
            const current = getAvailableBase();
            if (current < target) {
                const deficit = target - current;
                const uso = Math.min(deficit, lucroBase);
                if (DEMO) demoBalance.base += uso; else balanceAmt = (balanceAmt || 0) + uso;
                profitBankBase += Math.max(0, lucroBase - uso);
                console.log(chalk.magenta(`[REINVEST] LONG/base: restaurou ${uso.toFixed(8)} ${base} | banco: ${profitBankBase.toFixed(8)}`));
            } else {
                profitBankBase += lucroBase;
                console.log(chalk.magenta(`[REINVEST] LONG/base: base restaurada, +${lucroBase.toFixed(8)} no banco`));
            }
        } else if (mode === 'moeda') {
            // "moeda" + reinvest=true: converte lucro em base para mais moeda (compra imediata)
            if (!currentPrice || currentPrice <= 0) { profitBankBase += lucroBase; return; }
            if (lucroBase < (minAmt || 5)) { profitBankBase += lucroBase; return; }
            if (DEMO) {
                const qty = lucroBase / currentPrice;
                demoBalance.moeda += qty;
                demoBalance.base = Math.max(0, demoBalance.base - lucroBase);
                console.log(chalk.magenta(`[REINVEST] DEMO LONG/moeda: +${qty.toFixed(8)} ${moeda}`));
            } else {
                try {
                    await client.order({
                        symbol, side: 'BUY', type: 'MARKET',
                        quoteOrderQty: lucroBase.toFixed(8), newOrderRespType: 'FULL'
                    });
                    await balanceUpdt();
                    console.log(chalk.magenta(`[REINVEST] REAL LONG/moeda: comprou ${moeda} com ${lucroBase.toFixed(8)} ${base}`));
                } catch (e) {
                    if (/min_notional|notional/i.test(e.message)) profitBankBase += lucroBase;
                    else { balanceQty = (balanceQty || 0) + lucroBase / currentPrice; }
                    console.warn('[REINVEST] LONG/moeda falhou:', e.message);
                }
            }
        } else if (mode === 'equal') {
            // "equal": normaliza tamanho para igualar quantidade média das ordens do ciclo.
            // O lucro fica em base para que a PRÓXIMA ordem baseie-se no mesmo capital.
            profitBankBase += lucroBase;
            console.log(chalk.magenta(`[REINVEST] LONG/equal: +${lucroBase.toFixed(8)} no banco (ciclo normalizado)`));
        }

        // ── SHORT ───────────────────────────────────────────────────────────────
    } else if (strategy === 'SHORT') {
        if (mode === 'base' || !reinvest) {
            // "base": acumula base, restaura nível inicial de moeda se necessário
            const target = cycleStartBalanceMoeda || 0;
            const current = getAvailableMoeda();
            if (current < target && currentPrice > 0) {
                const deficit = target - current;
                const necessary = deficit * currentPrice;
                const uso = Math.min(necessary, lucroBase);
                const qty = uso / currentPrice;
                if (DEMO) { demoBalance.moeda += qty; demoBalance.base = Math.max(0, demoBalance.base - uso); }
                else { balanceQty = (balanceQty || 0) + qty; balanceAmt = Math.max(0, (balanceAmt || 0) - uso); }
                profitBankBase += Math.max(0, lucroBase - uso);
                console.log(chalk.magenta(`[REINVEST] SHORT/base: restaurou ${qty.toFixed(8)} ${moeda}`));
            } else {
                profitBankBase += lucroBase;
                console.log(chalk.magenta(`[REINVEST] SHORT/base: moeda restaurada, +${lucroBase.toFixed(8)} no banco`));
            }
        } else if (mode === 'moeda' && reinvest) {
            // "moeda" + reinvest=true: converte lucro em base para mais moeda
            if (!currentPrice || currentPrice <= 0) { profitBankBase += lucroBase; return; }
            if (lucroBase < (minAmt || 5)) { profitBankBase += lucroBase; return; }
            if (DEMO) {
                const qty = lucroBase / currentPrice;
                demoBalance.moeda += qty;
                demoBalance.base = Math.max(0, demoBalance.base - lucroBase);
                console.log(chalk.magenta(`[REINVEST] DEMO SHORT/moeda: +${qty.toFixed(8)} ${moeda}`));
            } else {
                try {
                    await client.order({
                        symbol, side: 'BUY', type: 'MARKET',
                        quoteOrderQty: lucroBase.toFixed(8), newOrderRespType: 'FULL'
                    });
                    await balanceUpdt();
                    console.log(chalk.magenta(`[REINVEST] REAL SHORT/moeda: comprou ${moeda} com ${lucroBase.toFixed(8)} ${base}`));
                } catch (e) {
                    if (/min_notional|notional/i.test(e.message)) profitBankBase += lucroBase;
                    else { balanceQty = (balanceQty || 0) + lucroBase / currentPrice; }
                    console.warn('[REINVEST] SHORT/moeda falhou:', e.message);
                }
            }
        } else if (mode === 'equal') {
            // "equal": normaliza quantidade de moeda para o próximo ciclo
            profitBankBase += lucroBase;
            console.log(chalk.magenta(`[REINVEST] SHORT/equal: +${lucroBase.toFixed(8)} no banco (ciclo normalizado)`));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRO DE TRADE
// ─────────────────────────────────────────────────────────────────────────────

async function registrarTrade(side, entryPrice, exitPrice, qty, isStopLoss = false, feePaidBase = null) {
    let taxaTotal = 0;
    let feeEstimated = true;
    if (feePaidBase != null && !isNaN(Number(feePaidBase))) {
        taxaTotal = Number(feePaidBase);
        feeEstimated = false;
    } else {
        taxaTotal = (entryPrice + exitPrice) * qty * TAX_MARKET;
    }

    const lucroLiquido = strategy === 'SHORT'
        ? (entryPrice - exitPrice) * qty - taxaTotal
        : (exitPrice - entryPrice) * qty - taxaTotal;

    const lucroPct = ((lucroLiquido / (entryPrice * qty)) * 100).toFixed(3);

    // estatísticas
    stats.trades.total++;
    stats.financeiro.taxasTotais = +(stats.financeiro.taxasTotais + taxaTotal).toFixed(8);
    stats.financeiro.lucroLiquidoTotal = +(stats.financeiro.lucroLiquidoTotal + lucroLiquido).toFixed(8);
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

    stats.historico.push({
        timestamp: new Date().toISOString(), strategy, side,
        entryPrice, exitPrice, qty: +qty.toFixed(8),
        taxaTotal: +taxaTotal.toFixed(8), feeEstimated,
        lucroLiquido: +lucroLiquido.toFixed(8), lucroPct: `${lucroPct}%`,
        stopLoss: isStopLoss, modo: DEMO ? 'DEMO' : 'REAL',
        reinvestMode: cfg.operacao.reinvestMode,
    });

    // reinvestimento
    await accumulateProfit(lucroLiquido);

    // atualiza saldo atual nos stats
    stats.financeiro.saldoAtualBase = DEMO ? +demoBalance.base.toFixed(8) : balanceAmt;
    stats.financeiro.saldoAtualMoeda = DEMO ? +demoBalance.moeda.toFixed(8) : balanceQty;

    saveStats();

    // reset de ciclo — próximo ciclo capturará novos saldos iniciais
    cycleStartBalanceBase = null;
    cycleStartBalanceMoeda = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDENS
// ─────────────────────────────────────────────────────────────────────────────

function logOrder(order) {
    if (!order?.orderId) return;
    const { orderId, side, executedQty, cummulativeQuoteQty, status, transactTime } = order;
    const avg = parseFloat(cummulativeQuoteQty) / parseFloat(executedQty || 1);
    const taxa = parseFloat(cummulativeQuoteQty) * TAX_MARKET;
    const label = side === 'SELL' ? '🔻 [VENDA]' : '🟢 [COMPRA]';
    console.log(`\n${label} ID: ${orderId} | Preço: ${avg.toFixed(6)} | Qty: ${executedQty} | Taxa ~${taxa.toFixed(6)} ${base} | ${status}`);
}

function createDemoOrder(side, qty) {
    if (qty < (minQty || 0)) { console.warn(`⚠️ [DEMO] qty ${qty} < minQty ${minQty}`); return null; }
    const value = qty * currentPrice;
    const taxa = value * TAX_MARKET;

    if (side === 'SELL') {
        if (demoBalance.moeda < qty) { console.warn(`⚠️ [DEMO] saldo ${moeda} insuficiente`); return null; }
        demoBalance.moeda -= qty;
        demoBalance.base += value - taxa;
    } else {
        const cost = value + taxa;
        if (demoBalance.base < cost) { console.warn(`⚠️ [DEMO] saldo ${base} insuficiente`); return null; }
        demoBalance.base -= cost;
        demoBalance.moeda += qty;
    }

    const tag = chalk.yellow('[DEMO] ');
    const label = side === 'SELL' ? '🔻 [VENDA SIMULADA]' : '🟢 [COMPRA SIMULADA]';
    console.log(`\n${tag}${label}`);
    console.log(`${tag}Qty: ${qty} ${moeda} | Preço: ${currentPrice} | Valor: ${value.toFixed(4)} ${base} | Taxa: ~${taxa.toFixed(6)} ${base}`);
    console.log(`${tag}Saldo → ${base}: ${demoBalance.base.toFixed(4)} | ${moeda}: ${demoBalance.moeda}`);

    const now = Date.now();
    return {
        orderId: `DEMO-${now}`, symbol, side: side.toUpperCase(), type: 'MARKET',
        executedQty: String(qty), cummulativeQuoteQty: String(value),
        status: 'FILLED', transactTime: now,
    };
}

/**
 * Cria e executa uma ordem MARKET.
 * @param {string}  side        'BUY' | 'SELL'
 * @param {number}  quantity    quantidade bruta desejada
 * @param {boolean} isStopLoss  indica se é ordem de stop
 * @returns {object|null}       resultado da ordem ou null em caso de falha
 */
async function createOrder(side, quantity, isStopLoss = false) {
    if (isOrderPending) { console.warn('Ordem pendente — ignorando.'); return null; }
    isOrderPending = true;

    try {
        const roundedQty = await adjustQty(quantity, side);
        if (!roundedQty || isNaN(roundedQty) || roundedQty <= 0) {
            console.warn('Quantidade inválida após ajuste. Ordem cancelada.');
            return null;
        }

        let order;
        if (DEMO) {
            order = createDemoOrder(side, roundedQty);
        } else {
            if (roundedQty < (minQty || 0)) { console.warn(`qty ${roundedQty} < minQty ${minQty}`); return null; }
            order = await client.order({
                symbol, side: side.toUpperCase(), type: 'MARKET',
                quantity: roundedQty, newOrderRespType: 'FULL',
            });
            logOrder(order);
        }
        if (!order) return null;

        await balanceUpdt();

        const execQty = parseFloat(order.executedQty);
        const execQuote = parseFloat(order.cummulativeQuoteQty);
        const avgPrice = execQuote / execQty;

        // ── Integração com DCA ─────────────────────────────────────────────
        await processDcaOrder(side, avgPrice, execQty, execQuote, order, isStopLoss);

        return order;

    } catch (e) {
        console.error('❌ Erro na ordem:', e.message);
        return null;
    } finally {
        isOrderPending = false;
    }
}

/**
 * Processa a ordem em relação ao estado DCA e registra o trade quando necessário.
 */
async function processDcaOrder(side, avgPrice, execQty, execQuote, order, isStopLoss) {
    const sideBuy = side.toUpperCase() === 'BUY';
    const sideSell = side.toUpperCase() === 'SELL';

    if (dcaEnabled) {
        // Garante instância DCA
        if (!dcaStrategy) {
            dcaStrategy = new DCAStrategy({
                maxOrders: dcaMaxOrders, targetPercent: dcaTargetPercent,
                symbol, base, moeda, strategy,
                profitConfig: cfg.dca?.profitConfig || {},
            });
        }

        if (strategy === 'LONG') {
            if (sideBuy) {
                if (!dcaStrategy.isActive) {
                    dcaStrategy.startPosition(avgPrice, execQty, execQuote);
                } else {
                    dcaStrategy.addPosition(avgPrice, execQty, execQuote, true);
                }
                buyPrice = avgPrice;
                buyAmount = (buyAmount || 0) + execQuote;

            } else if (sideSell) {
                const entryPrice = dcaStrategy.isActive ? dcaStrategy.averageEntryPrice : buyPrice;
                if (dcaStrategy.isActive) {
                    const result = dcaStrategy.closePosition(avgPrice, execQty, execQuote);
                    if (result) console.log(chalk.magenta(`📦 DCA fechado: lucro ${result.profit.toFixed(8)} ${base}`));
                }
                const fee = await calcFeeInBase(order).catch(() => null);
                await registrarTrade('SELL', entryPrice, avgPrice, execQty, isStopLoss, fee);
                buyPrice = buyAmount = null;
            }

        } else { // SHORT
            if (sideSell) {
                if (!dcaStrategy.isActive) {
                    dcaStrategy.startPosition(avgPrice, execQty, execQuote);
                } else {
                    dcaStrategy.addPosition(avgPrice, execQty, execQuote, true);
                }
                sellPrice = avgPrice;
                sellAmount = (sellAmount || 0) + execQuote;

            } else if (sideBuy) {
                const entryPrice = dcaStrategy.isActive ? dcaStrategy.averageEntryPrice : sellPrice;
                if (dcaStrategy.isActive) {
                    const result = dcaStrategy.closePosition(avgPrice, execQty, execQuote);
                    if (result) console.log(chalk.magenta(`📦 DCA fechado: lucro ${result.profit.toFixed(8)} ${base}`));
                }
                const fee = await calcFeeInBase(order).catch(() => null);
                await registrarTrade('BUY', entryPrice, avgPrice, execQty, isStopLoss, fee);
                sellPrice = sellAmount = null;
            }
        }

    } else {
        // ── Sem DCA ────────────────────────────────────────────────────────
        if (strategy === 'LONG') {
            if (sideBuy) {
                buyPrice = avgPrice;
                buyAmount = (buyAmount || 0) + execQuote;
            } else if (sideSell && buyPrice) {
                const fee = await calcFeeInBase(order).catch(() => null);
                await registrarTrade('SELL', buyPrice, avgPrice, execQty, isStopLoss, fee);
                buyPrice = buyAmount = null;
            }
        } else {
            if (sideSell) {
                sellPrice = avgPrice;
                sellAmount = (sellAmount || 0) + execQuote;
            } else if (sideBuy && sellPrice) {
                const fee = await calcFeeInBase(order).catch(() => null);
                await registrarTrade('BUY', sellPrice, avgPrice, execQty, isStopLoss, fee);
                sellPrice = sellAmount = null;
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// STOP LOSS ADAPTATIVO
// ─────────────────────────────────────────────────────────────────────────────

function calcAdaptiveStopPct() {
    const buffer = cfg.dca?.stopLossBuffer ?? 1.5;
    if (!dcaEnabled || !dcaStrategy?.isActive || !cfg.dca?.adaptiveStopLoss) {
        return strategy === 'LONG' ? stopLossPercentLong : stopLossPercentShort;
    }

    const { ordersCount, averageEntryPrice } = dcaStrategy.getPositionInfo();
    const nextFactor = (dcaTargetPercent / 100) * (ordersCount + 1);

    let stopPct;
    if (strategy === 'LONG') {
        const nextOrderPrice = averageEntryPrice * (1 - nextFactor);
        const dropToNext = ((averageEntryPrice - nextOrderPrice) / averageEntryPrice) * 100;
        stopPct = Math.max(stopLossPercentLong, buffer, dropToNext * buffer);
    } else {
        const nextOrderPrice = averageEntryPrice * (1 + nextFactor);
        const riseToNext = ((nextOrderPrice - averageEntryPrice) / averageEntryPrice) * 100;
        stopPct = Math.max(stopLossPercentShort, buffer, riseToNext * buffer);
    }

    console.log(chalk.cyan(`📊 Stop Adaptativo: ${stopPct.toFixed(2)}% (buffer ${buffer}%)`));
    return Math.min(stopPct, 5); // cap de segurança
}

async function checkStopLoss() {
    if (!currentPrice) return;

    if (strategy === 'LONG' && stopLossPercentLong > 0 && tradeSide === 'SELL') {
        if (dcaStrategy?.isActive && dcaStrategy.checkContraryMove(currentPrice)) return;

        const entryPrice = dcaStrategy?.isActive ? dcaStrategy.averageEntryPrice : buyPrice;
        if (!entryPrice) return;

        const stopPct = calcAdaptiveStopPct();
        const stopPrice = entryPrice * (1 - stopPct / 100);

        if (currentPrice <= stopPrice) {
            console.log(chalk.red(`${nowStr()} 🛑 STOP LOSS LONG | Atual: ${currentPrice} | Stop: ${stopPrice.toFixed(6)} (${stopPct}%)`));
            const qty = dcaStrategy?.isActive
                ? dcaStrategy.totalQuantity
                : Math.max((buyAmount / buyPrice) * pctBaseLong, (minAmt || 5) / currentPrice);

            dcaStrategy?.cancel('Stop Loss');
            const order = await createOrder('SELL', qty, true);
            if (order) { tradeSide = 'BUY'; buyPrice = buyAmount = null; console.log(chalk.red('✅ Stop LONG executado.')); }
        }

    } else if (strategy === 'SHORT' && stopLossPercentShort > 0 && tradeSide === 'BUY') {
        if (dcaStrategy?.isActive && dcaStrategy.checkContraryMove(currentPrice)) return;

        const entryPrice = dcaStrategy?.isActive ? dcaStrategy.averageEntryPrice : sellPrice;
        if (!entryPrice) return;

        const stopPct = calcAdaptiveStopPct();
        const stopPrice = entryPrice * (1 + stopPct / 100);

        if (currentPrice >= stopPrice) {
            console.log(chalk.red(`${nowStr()} 🛑 STOP LOSS SHORT | Atual: ${currentPrice} | Stop: ${stopPrice.toFixed(6)} (${stopPct}%)`));
            const qty = dcaStrategy?.isActive
                ? dcaStrategy.totalQuantity
                : Math.max((getAvailableBase() * pctBaseLong) / (currentPrice * (1 + TAX_MARKET)), minQty || 0);

            dcaStrategy?.cancel('Stop Loss');
            await balanceUpdt();
            const order = await createOrder('BUY', qty, true);
            if (order) { tradeSide = 'SELL'; sellPrice = sellAmount = null; console.log(chalk.red('✅ Stop SHORT executado.')); }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CÁLCULO DE TENDÊNCIA
// ─────────────────────────────────────────────────────────────────────────────

function calcTrend(forSell) {
    if (!previousCandleClose || secureTrend === 0) return true;
    const trendPct = ((currentPrice - previousCandleClose) / previousCandleClose) * 100;
    if (forSell && strategy === 'SHORT') return trendPct <= secureTrend;
    return trendPct >= -secureTrend;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUANTIDADE PARA ORDENS PRINCIPAIS
// ─────────────────────────────────────────────────────────────────────────────

function calcBuyQty() {
    // LONG: entrada — usa cycleStartBalanceBase para manter mesmo capital entre ciclos
    if (!cycleStartBalanceBase) cycleStartBalanceBase = getAvailableBase();

    // modo "equal": usa capital do ciclo + banco de lucros acumulados
    const efectiva = cycleStartBalanceBase + (cfg.operacao.reinvestMode === 'equal' ? profitBankBase : 0);
    const qty = Math.max(
        (efectiva * pctBaseLong) / (currentPrice * (1 + TAX_MARKET)),
        (minAmt || 5) / currentPrice
    );

    // se usou profitBankBase, consome-o
    if (cfg.operacao.reinvestMode === 'equal' && profitBankBase > 0) {
        console.log(chalk.magenta(`[EQUAL] Usando banco ${profitBankBase.toFixed(8)} ${base} na ordem BUY`));
        profitBankBase = 0;
    }
    return qty;
}

function calcSellQtyLongClose() {
    // LONG close: vende a moeda acumulada (ou a posição DCA inteira)
    if (dcaEnabled && dcaStrategy?.isActive) return dcaStrategy.totalQuantity;
    return Math.max(getAvailableMoeda() * SAFETY_MARGIN, minQty || 0);
}

function calcSellQtyShortOpen() {
    // SHORT: entrada — vende moeda
    if (!cycleStartBalanceMoeda) cycleStartBalanceMoeda = getAvailableMoeda();
    const efectiva = cycleStartBalanceMoeda + (cfg.operacao.reinvestMode === 'equal' ? profitBankBase / (currentPrice || 1) : 0);
    const qty = Math.max(
        (efectiva * pctMoedaShort) / (1 + TAX_MARKET),
        Math.max(minQty || 0, (minAmt || 5) / currentPrice)
    );
    if (cfg.operacao.reinvestMode === 'equal' && profitBankBase > 0) {
        console.log(chalk.magenta(`[EQUAL] Usando banco ${profitBankBase.toFixed(8)} ${base} na ordem SELL`));
        profitBankBase = 0;
    }
    return qty;
}

function calcBuyQtyShortClose() {
    // SHORT close: recompra moeda
    if (dcaEnabled && dcaStrategy?.isActive) return dcaStrategy.totalQuantity;
    const availBase = getAvailableBase() + (cfg.operacao.reinvestProfits ? profitBankBase : 0);
    return Math.max(
        availBase / (currentPrice * (1 + TAX_MARKET)),
        Math.max(minQty || 0, (minAmt || 5) / currentPrice)
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTRATÉGIA DE COMPRA (BUY)
// ─────────────────────────────────────────────────────────────────────────────

async function executeBuyStrategy() {
    if (!currentPrice) return;

    // ── DCA extra LONG ───────────────────────────────────────────────────────
    if (dcaEnabled && dcaStrategy?.isActive && strategy === 'LONG') {
        if (dcaStrategy.checkContraryMove(currentPrice)) {
            await balanceUpdt();
            const avail = getAvailableBase();
            const qty = Math.max(
                (avail * pctBaseLong) / (currentPrice * (1 + TAX_MARKET)),
                Math.max(minQty || 0, (minAmt || 5) / currentPrice)
            );
            if (qty * currentPrice < (minAmt || 5)) {
                console.log(chalk.yellow(`⚠️ DCA extra LONG abaixo do minNotional`)); return;
            }
            console.log(chalk.cyan(`📊 DCA extra LONG: ${qty.toFixed(8)} ${moeda}`));
            const order = await createOrder('BUY', qty);
            if (order) console.log(chalk.green(`✅ DCA LONG extra executado`));
            return;
        }
    }

    // RSI guard
    if (rsi === null && (rsiBuy !== 0 || rsiSell !== 0)) {
        console.log(chalk.yellow('[BUY] RSI indisponível — pulando.')); return;
    }

    const isClosingShort = strategy === 'SHORT' && tradeSide === 'BUY';

    // ── LONG: entrada ────────────────────────────────────────────────────────
    if (strategy === 'LONG' && tradeSide === 'BUY') {
        if (rsi > rsiBuy && rsiBuy !== 0) return;

        if (!previousCandleClose) { console.log(chalk.gray('[BUY] Aguardando candle...')); return; }
        const changePct = ((currentPrice - previousCandleClose) / previousCandleClose) * 100;
        const trendOk = calcTrend(false);
        const highOk = secureHigh === 0 || (dailyHigh && currentPrice < dailyHigh / secureHigh);

        const ok = changePct <= -alvoBuy && trendOk && highOk;
        console.log(chalk.gray(`[LONG BUY] var=${changePct.toFixed(3)}% alvo≤-${alvoBuy}% ${ok ? '✅' : '❌'} | trend ${trendOk ? '✅' : '❌'} | high ${highOk ? '✅' : '❌'}`));

        if (!ok) return;

        await balanceUpdt();
        const qty = calcBuyQty();
        const order = await createOrder('BUY', qty);
        if (order) {
            tradeSide = 'SELL'; sellPrice = sellAmount = null;
            console.log(`✅ LONG: compra executada ${qty.toFixed(8)} ${moeda}`);
            console.log(chalk.gray('───────────────────────────────────'));
        }
        return;
    }

    // ── SHORT: fechamento (BUY fecha o SHORT) ────────────────────────────────
    if (isClosingShort) {
        // com DCA ativo e alvo não atingido, aguarda
        if (dcaEnabled && dcaStrategy?.isActive && !dcaStrategy.checkTarget(currentPrice)) {
            console.log(chalk.magenta(`[DCA] SHORT: alvo ${dcaStrategy.currentTargetPrice.toFixed(6)} não atingido.`)); return;
        }

        if (rsi > rsiBuy && rsiBuy !== 0) return;
        if (!sellPrice && !(dcaEnabled && dcaStrategy?.isActive)) { console.log(chalk.gray('[SHORT BUY] Aguardando sellPrice...')); return; }

        const entryPrice = dcaStrategy?.isActive ? dcaStrategy.averageEntryPrice : sellPrice;
        const changePct = ((currentPrice - entryPrice) / entryPrice) * 100;
        const trendOk = calcTrend(false);

        const ok = changePct <= -alvoBuy && trendOk;
        console.log(chalk.gray(`[SHORT CLOSE] var=${changePct.toFixed(3)}% alvo≤-${alvoBuy}% ${ok ? '✅' : '❌'} | trend ${trendOk ? '✅' : '❌'}`));

        if (!ok) return;

        await balanceUpdt();
        const qty = calcBuyQtyShortClose();

        // consome profitBankBase se reinvest
        if (cfg.operacao.reinvestProfits && profitBankBase > 0) profitBankBase = 0;

        const order = await createOrder('BUY', qty);
        if (order) {
            tradeSide = 'SELL'; sellPrice = sellAmount = null;
            console.log(`✅ SHORT fechado: compra ${qty.toFixed(8)} ${moeda}`);
            console.log(chalk.gray('───────────────────────────────────'));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ESTRATÉGIA DE VENDA (SELL)
// ─────────────────────────────────────────────────────────────────────────────

async function executeSellStrategy() {
    if (!currentPrice) return;

    // ── DCA extra SHORT ──────────────────────────────────────────────────────
    if (dcaEnabled && dcaStrategy?.isActive && strategy === 'SHORT') {
        if (dcaStrategy.checkContraryMove(currentPrice)) {
            await balanceUpdt();
            const avail = getAvailableMoeda();
            const qty = Math.max(
                (avail * pctMoedaShort) / (1 + TAX_MARKET),
                Math.max(minQty || 0, (minAmt || 5) / currentPrice)
            );
            if (qty * currentPrice < (minAmt || 5)) {
                console.log(chalk.yellow(`⚠️ DCA extra SHORT abaixo do minNotional`)); return;
            }
            console.log(chalk.cyan(`📊 DCA extra SHORT: ${qty.toFixed(8)} ${moeda}`));
            const order = await createOrder('SELL', qty);
            if (order) console.log(chalk.green(`✅ DCA SHORT extra executado`));
            return;
        }
    }

    // RSI guard
    if (rsi === null && (rsiBuy !== 0 || rsiSell !== 0)) {
        console.log(chalk.yellow('[SELL] RSI indisponível — pulando.')); return;
    }

    const isClosingLong = strategy === 'LONG' && tradeSide === 'SELL';

    // ── LONG: fechamento (SELL fecha o LONG) ─────────────────────────────────
    if (isClosingLong) {
        // com DCA ativo e alvo não atingido, aguarda
        if (dcaEnabled && dcaStrategy?.isActive && !dcaStrategy.checkTarget(currentPrice)) {
            console.log(chalk.magenta(`[DCA] LONG: alvo ${dcaStrategy.currentTargetPrice.toFixed(6)} não atingido.`)); return;
        }

        if (rsi < rsiSell && rsiSell !== 0) return;
        if (!buyPrice && !(dcaEnabled && dcaStrategy?.isActive)) { console.log(chalk.gray('[LONG SELL] Aguardando buyPrice...')); return; }

        const entryPrice = dcaStrategy?.isActive ? dcaStrategy.averageEntryPrice : buyPrice;
        const changePct = ((currentPrice - entryPrice) / entryPrice) * 100;
        const trendOk = calcTrend(true);

        const ok = changePct >= alvoSell && trendOk;
        console.log(chalk.gray(`[LONG CLOSE] var=${changePct.toFixed(3)}% alvo≥${alvoSell}% ${ok ? '✅' : '❌'} | trend ${trendOk ? '✅' : '❌'}`));

        if (!ok) return;

        await balanceUpdt();
        const qty = calcSellQtyLongClose();

        if (cfg.operacao.reinvestProfits && profitBankBase > 0) profitBankBase = 0;

        const order = await createOrder('SELL', qty);
        if (order) {
            tradeSide = 'BUY'; buyPrice = buyAmount = null;
            console.log(`✅ LONG fechado: venda ${qty.toFixed(8)} ${moeda}`);
            console.log(chalk.gray('───────────────────────────────────'));
        }
        return;
    }

    // ── SHORT: entrada ───────────────────────────────────────────────────────
    if (strategy === 'SHORT' && tradeSide === 'SELL') {
        if (rsi < rsiSell && rsiSell !== 0) return;

        if (!previousCandleClose) { console.log(chalk.gray('[SHORT SELL] Aguardando candle...')); return; }
        const changePct = ((currentPrice - previousCandleClose) / previousCandleClose) * 100;
        const trendOk = calcTrend(true);
        const lowOk = secureLow === 0 || (dailyLow && currentPrice > dailyLow * secureLow);

        const ok = changePct >= alvoSell && trendOk && lowOk;
        console.log(chalk.gray(`[SHORT SELL] var=${changePct.toFixed(3)}% alvo≥${alvoSell}% ${ok ? '✅' : '❌'} | trend ${trendOk ? '✅' : '❌'} | low ${lowOk ? '✅' : '❌'}`));

        if (!ok) return;

        await balanceUpdt();
        const qty = calcSellQtyShortOpen();
        const order = await createOrder('SELL', qty);
        if (order) {
            tradeSide = 'BUY'; buyPrice = buyAmount = null;
            console.log(`✅ SHORT aberto: venda ${qty.toFixed(8)} ${moeda}`);
            console.log(chalk.gray('───────────────────────────────────'));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG DE STATS
// ─────────────────────────────────────────────────────────────────────────────

function logStats() {
    const fin = stats.financeiro;
    const tr = stats.trades;
    const lucro = fin.lucroLiquidoTotal;
    const cor = lucro >= 0 ? chalk.green.bold : chalk.red.bold;
    const lucroStr = `${lucro >= 0 ? '+' : ''}${lucro.toFixed(4)} ${base}`;

    console.log(chalk.cyan('──────── 📊 DESEMPENHO ────────'));
    console.log(`Trades : ${tr.total} | ✅ ${tr.lucrativos} | ❌ ${tr.prejuizo} | 🛑 ${tr.stopLossAcionados}`);
    console.log(`Lucro  : ${cor(lucroStr)}`);
    console.log(`Taxas  : ~${chalk.yellow(fin.taxasTotais.toFixed(4))} ${base}`);
    console.log(`Melhor : ${chalk.green(`+${fin.maiorLucroTrade.toFixed(4)}`)} | Pior: ${chalk.red(`${fin.maiorPrejuizoTrade.toFixed(4)}`)}`);
    if (fin.saldoInicialBase != null && fin.saldoAtualBase != null) {
        const var_ = fin.saldoAtualBase - fin.saldoInicialBase;
        const c = var_ >= 0 ? chalk.green : chalk.red;
        console.log(`Saldo ${base}: ${fin.saldoInicialBase.toFixed(2)} → ${c(fin.saldoAtualBase.toFixed(2))} (${var_ >= 0 ? '+' : ''}${var_.toFixed(4)})`);
    }
    if (profitBankBase > 0) console.log(chalk.magenta(`💰 Banco lucros: ${profitBankBase.toFixed(8)} ${base}`));
    console.log(chalk.cyan('──────────────────────────────'));
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOP PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

async function monitor() {
    try {
        console.log(`\n${nowStr()} ──── CICLO ────`);

        // 1. Dados de mercado
        await getPrice();
        await update24hStats();

        const candleClose = await getLastCandleClose();
        if (candleClose !== null) {
            if (!candleInitialized) {
                previousCandleClose = candleClose;
                candleInitialized = true;
                console.log(chalk.yellow('[CANDLE] Capturado pela primeira vez — aguardando próximo ciclo.'));
                return;
            }
            previousCandleClose = candleClose;
        }

        // 2. RSI
        const rsiRaw = await updtRsi.getValue(symbol, candleInterval, rsiPeriod);
        rsi = (rsiRaw != null && !isNaN(Number(rsiRaw))) ? Math.round(Number(rsiRaw)) : null;
        if (rsi === null) console.warn('[RSI] Indisponível neste ciclo.');

        // 3. Atualiza tendência global (para log)
        trend = calcTrend(tradeSide === 'SELL');

        // 4. Calcula variação para log
        let changePct = null;
        if (strategy === 'LONG' && tradeSide === 'SELL') {
            const entry = dcaStrategy?.isActive ? dcaStrategy.averageEntryPrice : buyPrice;
            if (entry) changePct = ((currentPrice - entry) / entry) * 100;
        } else if (strategy === 'SHORT' && tradeSide === 'BUY') {
            const entry = dcaStrategy?.isActive ? dcaStrategy.averageEntryPrice : sellPrice;
            if (entry) changePct = ((currentPrice - entry) / entry) * 100;
        } else if (previousCandleClose) {
            changePct = ((currentPrice - previousCandleClose) / previousCandleClose) * 100;
        }

        // 5. Log de status
        const modeTag = DEMO ? chalk.yellow.bold('[DEMO] ') : '';
        const lucroAcum = stats.financeiro.lucroLiquidoTotal;
        const lucroC = lucroAcum >= 0 ? chalk.green.bold : chalk.red.bold;
        const changeTxt = changePct != null ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%` : 'N/A';
        const changeC = changePct != null ? (changePct >= 0 ? chalk.green : chalk.red) : chalk.gray;
        const sideLabel = tradeSide === 'SELL'
            ? chalk.white.bgRed.bold(` ${tradeSide} `)
            : chalk.white.bgGreen.bold(` ${tradeSide} `);

        console.log(`${modeTag}Preço: ${chalk.white.bold(currentPrice)} | Lucro: ${lucroC(`${lucroAcum >= 0 ? '+' : ''}${lucroAcum.toFixed(4)} ${base}`)}`);
        console.log(`Saldo → ${base}: ${balanceAmt?.toFixed(4) ?? 'N/A'} | ${moeda}: ${balanceQty ?? 'N/A'}`);
        console.log(`Variação (${candleInterval}): ${changeC(changeTxt)} | Trend: ${trend ? chalk.white('✅') : chalk.magenta('❌')} | RSI: ${rsi ?? 'N/A'}`);
        console.log(`Side: ${sideLabel} | Strategy: ${chalk.cyan(strategy)} | Mode: ${cfg.operacao.reinvestMode}`);

        if (dcaEnabled && dcaStrategy?.isActive) {
            const pos = dcaStrategy.getPositionInfo();
            const profit = dcaStrategy.calculateGuaranteedProfit(currentPrice);
            const pct = dcaStrategy.calculateProfitPercent(currentPrice);
            console.log(chalk.magentaBright(`📊 DCA: ${pos.ordersCount}/${pos.maxOrders} ordens | Avg: ${pos.averageEntryPrice.toFixed(6)} | Alvo: ${pos.currentTargetPrice.toFixed(6)} | P&L: ${profit.toFixed(4)} ${base} (${pct.toFixed(2)}%)`));
        }

        // 6. Stats acumulados
        logStats();

        // 7. Stop Loss
        await checkStopLoss();

        // 8. Estratégias
        if (rsi === null && (rsiBuy !== 0 || rsiSell !== 0)) {
            console.log(chalk.yellow('RSI zerado e ausente — pulando estratégias.'));
        } else {
            if (dcaEnabled && dcaStrategy?.isActive) {
                // com DCA ativo verifica ambos os lados (extras e fechamentos)
                await executeSellStrategy();
                await executeBuyStrategy();
            } else {
                if (tradeSide === 'SELL') await executeSellStrategy();
                else await executeBuyStrategy();
            }
        }

    } catch (e) {
        console.error('❌ Erro no monitor:', e.message);
    } finally {
        saveState();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); }
        catch (e) {
            if (i === retries - 1) throw e;
            console.warn(`Tentativa ${i + 1} falhou: ${e.message}. Retentando em ${delay}ms...`);
            await sleep(delay);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INICIALIZAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
    console.log(DEMO
        ? chalk.yellow.bold('⚠️  MODO DEMO — Nenhuma ordem real será enviada')
        : chalk.green.bold('🟢 MODO REAL'));
    console.log(`Estratégia: ${strategy} | Par: ${symbol} | Intervalo: ${candleInterval} | RSI: ${rsiPeriod}`);
    console.log(`Taxas → Market: ${(TAX_MARKET * 100).toFixed(2)}% | Limit: ${(TAX_LIMIT * 100).toFixed(3)}%`);
    console.log(`Reinvestimento → reinvestProfits: ${cfg.operacao.reinvestProfits} | reinvestMode: ${cfg.operacao.reinvestMode}`);
    console.log(`DCA → enabled: ${dcaEnabled} | maxOrders: ${dcaMaxOrders} | targetPercent: ${dcaTargetPercent}%`);
    console.log(chalk.gray('─────────────────────────────────────────────'));

    // Carrega filtros e saldo
    await updateMinOrderQty();
    await fetchTradeFees();

    try { await balanceUpdt(); } catch (e) { console.warn('Aviso: falha ao obter saldo inicial:', e.message); }

    // Restaura estado persistido e valida consistência
    loadPersistedState();
    validateState();

    // Inicializa sessão de stats
    const modeLabel = DEMO ? 'DEMO' : 'REAL';
    if (!stats.sessao.inicio || stats.sessao.modo !== modeLabel || stats.sessao.symbol !== symbol) {
        if (stats.sessao.inicio) archiveStats();
        stats = defaultStats();
        stats.sessao.inicio = new Date().toISOString();
        stats.sessao.modo = modeLabel;
        stats.sessao.symbol = symbol;
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
    saveStats();

    // Inicia loop
    await monitor();
    setInterval(monitor, monitoringInterval);
})();