# Manual do Bot de Trading Binance

Este documento descreve detalhadamente o funcionamento do bot, sua arquitetura, configurações e estratégias.
É destinado a qualquer agente (ou desenvolvedor) que precise entender ou operar o sistema.

---

## 1. Visão Geral

O projeto consiste em três componentes principais:

1. **`binance.js`** – bot principal que executa a estratégia de trading.
2. **`cacheServer.js`** – serviço centralizado que coleta candles da Binance e armazena em Redis (ou memória) para economizar requisições.
3. **`rsi.js`** – módulo que calcula o RSI usando dados do cache.

A ideia central é que **um único processo (`cacheServer`) faz chamadas à API da Binance** e distribui os preços para múltiplas instâncias do bot, evitando problemas de rate limit.

---

## 2. Configuração Inicial

### Dependências
Instale com:

```bash
npm install
```

As seguintes bibliotecas são usadas:

- `binance-api-node` – cliente oficial Binance
- `technicalindicators` – cálculo de indicadores técnicos (RSI)
- `chalk` – cores nos logs
- `dotenv` – leitura de `.env`
- `express` – servidor HTTP para cache
- `redis` – cliente Redis

### Redis (opcional mas recomendado)

O cache server tenta conectar em `redis://localhost:6379` ou no valor de `REDIS_URL`.
Se não houver Redis, o serviço mantém o cache em memória e os bots continuam funcionando, porém sem persistência externa.

### Variáveis de Ambiente

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `CACHE_PORT` | Porta HTTP do cache server | 3000 (ou 4000 configurado) |
| `REDIS_URL` | URL do Redis | `redis://localhost:6379` |
| `POLL_INTERVAL_MS` | Intervalo de atualização em ms | 60000 |
| `BINANCE_API_KEY` | Chave Binance | — |
| `BINANCE_API_SECRET` | Secret Binance | — |
| `BOT_ID` | Identificador opcional para múltiplas instâncias | — |

Coloque esses valores em um arquivo `.env` ou exporte no shell.

---

## 3. Cache Server (`cacheServer.js`)

### Funcionamento
- Recebe requisições GET `/cache?symbol=XXX&interval=YYY` para candles.
- Ao primeiro pedido para um símbolo/intervalo, inicia polling (via `binance.candles`) e grava fechamentos (`close`) no Redis ou em memória.
- Mantém uma única conexão WebSocket com a Binance para receber **preços em tempo real** e estatísticas 24h de todos símbolos monitorados.
- Cada novo par/intervalo rastreado via `/cache` também garante a assinatura do preço e a atualização periódica de stats.
- A cada `POLL_INTERVAL_MS` repete o polling, substituindo o valor no cache e atualizando stats.
- O servidor nunca faz chamadas diretas no bot; ele apenas responde dados aprovados ao bots que pedirem o cache.

### Endpoints

- **GET /cache**
  - Parâmetros: `symbol` (e.g., BTCUSDT), `interval` (e.g., 1m, 5m)
  - Resposta: array JSON de fechamentos ou 404 se ainda não houver dados.
- **GET /price**
  - Parâmetros: `symbol`
  - Resposta: `{ price: número }` ou 404 se não houver valor conhecido.
- **GET /stats24h**
  - Parâmetros: `symbol`
  - Resposta: objeto JSON com lowPrice/highPrice/etc. ou 404 se não disponível.
- **GET /exchangeInfo**
  - Parâmetros opcionais: `symbol`.
  - Retorna o `exchangeInfo` completo ou apenas a entrada referente a `symbol`.
- **GET /tradeFee**
  - Parâmetros: `symbol`.
  - Retorna o array de taxas de trade (cache de 10 min).

### Configuração
- Ajuste porta com `CACHE_PORT`.
- Ajuste Redis com `REDIS_URL`.
- Ajuste intervalo com `POLL_INTERVAL_MS`.

---

## 4. Bot Principal (`binance.js`)

### Lógica geral
1. Carrega configurações de `data/config.json` (ou `{BOT_ID}_config.json`).
2. Inicia cliente Binance (REAL/DEMO conforme config).
3. Faz `await monitor()` periodicamente, lendo preços e RSI.
4. Executa estratégias (`executeBuyStrategy`, `executeSellStrategy`).
5. Cria ordens com `createOrder` e registra trades com `registrarTrade`.
6. Atualiza estatísticas em `data/stats.json` e arquiva sessões antigas.

### Integração com Cache
- O RSI agora é obtido por `updtRsi.getValue(symbol, interval, rsiPeriod)`, que busca dados no Redis ou cache server.
- O bot não precisa lidar com candles diretamente.

### Parâmetros de execução
```bash
node binance.js --id=bot1
```
`--id` define arquivos de configuração/estatísticas separados para cada instância.

---

## 5. Módulo RSI (`rsi.js`)

- Tenta ler chaves `candles:<symbol>:<interval>` no Redis.
- Se falhar ou não houver dados, faz fallback em `client.candles` (REST).
- Calcula RSI com período `rsiPeriod` e retorna valor arredondado.

---

## 6. Configurações do bot

O arquivo `config.json` contém várias seções:

### `modo`
- `demo`: boolean
- `base`: ativo base (ex: USDT)
- `moeda`: ativo negociado (ex: ETH)
- `strategy`: `LONG` ou `SHORT`
- `tradeSide`: `BUY` ou `SELL` inicial

### `taxas`
- `market`, `limit`: taxas decimais

### `timing`
- `monitoringInterval` (ms)
- `candleInterval` (para RSI, e.g. "1m")
- `rsiPeriod`

### `rsi`
- `rsiBuy`, `rsiSell`

### `alvos`
- `alvoBuy`, `alvoSell` (percentual)

### `seguranca`
- `secureTrend`, `secureLow`, `secureHigh`
- `stopLossPercentLong`, `stopLossPercentShort`
- `pctCompra`, `pctVenda`, `pctBaseLong`, `pctMoedaShort`

### `operacao`
- `reinvestProfits`: boolean
- `reinvestMode`: `'base'`, `'moeda'`, `'equal'`

### `dca`
- `enabled`: boolean
- `maxOrders`: inteiro
- `targetPercent`: decimal

Esses valores podem ser alterados em runtime (config server observa arquivo e aplica alguns campos sem reiniciar).

---

## 7. Estratégias detalhadas

### LONG / SHORT
- **LONG**: compra em quedas e vende em altas.
- **SHORT**: abre posição vendida em altas e fecha em quedas (requere saldo/mini contrato configurado). 

### Reinvestimento
- **`base`**: lucros convertidos para o ativo `base` antes de reinvestir.
- **`moeda`**: conversão para `moeda`.
- **`equal`**: mantém mesma quantidade negociada do trade anterior oposto.

### DCA (Dollar Cost Averaging)
- Enquanto `dca.enabled`:
  - `trackSymbol` cria um objeto `DCAStrategy` internamente.
  - Ao detectar movimento contrário excedendo `targetPercent`, adiciona ordens extras até `maxOrders`.
  - Ao atingir o alvo combinado, fecha tudo em lucro garantido.
  - Stop loss adaptativo considera quantas ordens ainda cabem.

### Stop Loss Adaptativo
- Ajusta dinamicamente o percentual com base no estado da DCA e no número de ordens restantes.
- Nunca mais apertado que o stop base configurado; cap máximo de 5%.

---

## 8. Operação de múltiplos bots

1. Inicie o `cacheServer` (uma só vez).
2. Inicie quantos bots quiser (`node binance.js --id=...`).
   - cada bot, ao calcular RSI, **disparará internamente** uma requisição HTTP ao cache server se os dados ainda não existirem (vídeo em `rsi.js`); isso garante que o par/intervalo seja registrado.
3. Todos os bots compartilham o mesmo cache e, uma vez que o par foi pedido pela primeira vez, **nenhum deles faz chamadas diretas à Binance** — o cache server centraliza todos os pedidos.
4. Cada bot cria seus próprios arquivos de estatística.

#### Quando os bots precisam pedir

- **Antes de usar um símbolo/intervalo pela primeira vez** – senão o RSI estará indisponível (`rsi = null` e você verá avisos no log “RSI ausente”).
- **Toda vez que mudar de par ou intervalo** – cada combinação é monitorada separadamente.
- O módulo RSI cuida de acionar o cache server automaticamente, mas a lógica de monitoramento do servidor garante que apenas o primeiro pedido dispara uma chamada à Binance (os demais ficam bloqueados pelo `trackSymbol`).

#### Escalando para dezenas de instâncias

- Executar mais de 50 bots simultâneos é factível, mas recomenda‑se algumas precauções:
  - hospedar o `cacheServer` em infraestrutura própria ou em cluster (PM2, Docker, Kubernetes), dividindo símbolos/intervalos entre réplicas.
  - dimensionar o Redis (uso de sentinelas, clustering ou serviço gerenciado) e organizar chaves com prefixos por ambiente.
  - distribuir bots por várias máquinas/contêineres para evitar saturar CPU, I/O e limite de watchers de arquivo.
  - substituir `fs.watchFile` por uma API de configuração externa ou polling global, reduzindo sobrecarga de I/O.
  - centralizar logs e métricas (Prometheus, Grafana, ELK) para acompanhar uso de API, memória e tempo de ciclo.
  - considerar um balanceador para o cache server ou múltiplas instâncias que compartilham o mesmo Redis.

---

## 9. Diagnóstico e logs

- O cache server loga conexões, atualizações e erros de Redis.
- Cada bot imprime saldos, variações, tradeSide, RSI, lucros acumulados etc.
- `RSI ausente` indica falta de candles; neste caso o cache provavelmente não foi inicializado para aquele par.

---

## 10. Exemplos de uso

```bash
# iniciar redis
docker run -d -p 6379:6379 redis
# iniciar serviço de cache
node cacheServer.js
# testar com curl
curl 'http://localhost:4000/cache?symbol=BTCUSDT&interval=1m'
# iniciar bot
node binance.js --id=bot1
node binance.js --id=bot2
```

---

## 11. Manutenção e evolução

- Ajuste parâmetros em `config.json` e o bot aplica a maioria deles automaticamente.
- Se precisar suportar muitos símbolos/intervalos, execute vários cache servers ou instâncias em paralelo, apontando para o mesmo Redis.
- Este manual deve ser atualizado sempre que novas estratégias ou configurações forem adicionadas.
- Para facilitar manutenção em ambientes grandes, considere:
  - refatorar o código em módulos reutilizáveis (separar ordens, utilitários, estratégias) e adicionar testes automatizados.
  - migrar para TypeScript ou outra linguagem com tipagem para reduzir erros de runtime.
  - implementar telemetria e alertas para detectar problemas rapidamente.
  - planejar arquitetura orientada a microserviços se o volume ultrapassar centenas de bots.
  - usar orquestradores (Docker Compose, Kubernetes) para gerenciar a escala e garantir isolamento.

---

Boa sorte e bons trades!  🎯
