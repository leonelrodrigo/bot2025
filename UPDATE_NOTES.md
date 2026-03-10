# Atualizações Importantes do Bot & Cache Server

Este documento descreve as mudanças implementadas ao longo do desenvolvimento recente. Servirá como referência para futuros agentes ou colaboradores, facilitando o entendimento do histórico e da arquitetura adotada.

---

## Contexto
A base original consistia de um `TradeBot.js` independente que se comunicava diretamente com a API Binance para obter candles, preço, stats e taxas. Cada instância precisava de credenciais e mantinha lógica duplicada de cache/RSI. O objetivo era escalar para 50+ bots com menor carga de rede e evitar múltiplas conexões WebSocket.

A evolução centralizou os dados de mercado em um servidor único (`cacheServer.js`), deixando o bot responsável apenas por executar ordens e manter estado de sessão.

---

## Mudanças Principais

### 1. Cache Server Centralizado (`cacheServer.js`)
- Inicialização de Redis com fallback para memória.
- Monitoramento de candles via REST (padrão) e polling periódico.
- `trackSymbol()` para iniciar vigilância de qualquer par/intervalo solicitado, com `pollPriceOnce()` de priming.
- `subscribePrice()` com WebSocket para atualização de preços e `update24h()` para stats 24h.
- Novos endpoints HTTP:
  - `/cache?symbol=&interval=` – retorna array de closes e garante que o símbolo esteja sendo rastreado.
  - `/price?symbol=` – fornece último preço válido; implementa retry com poll rápido e validações (não zero/negativo).
  - `/stats24h?symbol=` – entrega stats 24h em cache.
  - `/exchangeInfo` – cache de informação de exchange, permite consulta por símbolo.
  - `/tradeFee` – retorna taxas de trade, devolve 204 sem credenciais, cache de 10 min.
- Logging com timestamp formatado `[HH:MM:SS-YYYY]` e ajustes de throttling para evitar floods.
- Sniffer dos eventos WS inválidos (payload completo) para investigação.
- Proteção contra valores inválidos/zeros do WS usando whitelist de campos (`lastPrice`, `curDayClose`, etc.).
- Exibição de valores internos (Redis/map) quando `/price` detecta inválidos.
- Ajuste de logs para indicar quando um símbolo começou a ser rastreado e quando candles são atualizados.

### 2. Modificações no `TradeBot.js`
- Novo helper `fetchCache(path, params)` para chamadas HTTP ao cache server.
- Atualização de todas as interações com dados de mercado para usar endpoints do cache server:
  - candles (`getLastCandle`), preço (`update24hStats`/`convertAssetToBase`/dentro de `adjustQtyToFilters`), exchangeInfo, stats e taxas.
- Implementação de priming na inicialização para evitar preço inicial zero.
- Validações extras para garantir `currentPrice > 0` antes de calcular pedidos.
- Retry genérico `withRetry()` para garantir robustez em chamadas falhas.
- Função `logTS()` com timestamp no início de cada ciclo de monitoramento.
- Adição de mecanismo para armazenar e aplicar taxas por símbolo e estimativa de comissões em `calcOrderFeeInBase`.
- Uso de cache do servidor para balanços e conversões fora de pares diretos.
- Maior gerenciamento de configuração dinâmica via `fs.watchFile`.
- Tradução e ampliação de documentação interna (comentários e logs) para português.

### 3. Correções e Refinamentos
- Prevenção de -100% ao iniciar quando preço era zero; validado no servidor e no bot.
- Introdução de timestamps no formato correto em todos os logs.
- Remoção de preços zero vindos do WS através de filtro na assinatura.
- Throttle de logs inválidos para um por minuto por par.
- Várias melhorias de tratamento de erro, mensagens explicativas e fallback.

---

## Comparação com o sistema anterior

| Aspecto                   | Antigo                                   | Novo (atual)                                                |
|---------------------------|------------------------------------------|-------------------------------------------------------------|
| Fonte de dados de mercado | Cada bot consulta Binance diretamente     | Cache server único fornece candles, preços, stats, fees     |
| Conexões WS               | Uma por bot                               | Uma só por par no cache server (reduzido)                   |
| Redis                     | Não utilizado                              | Cache central com fallback em memória                      |
| Escalabilidade            | Difícil (muitos sockets)                  | Facilmente 50+ bots usando um único endpoint               |
| Configuração de pares     | Estática; cada bot decide                 | Dinâmica via `/cache` (trackSymbol automático)              |
| Lógica de preços inválidos| O bot recebia 0 e quebrava cálculo        | Ignora zeros, registra payloads e reconquista via poll      |
| Logs temporais            | Sem ou pouco timestamp                    | `HH:MM:SS-YYYY` em todos eventos chave                      |
| Reinício/config dinâmica  | Reinício obrigatório                      | Recarrega config sem restart, monitora mudanças            |

---

## Relevância para futuros agentes

1. **Arquitetura de Micro‑serviço** – O cache server é um componente reutilizável independente do TradeBot, permitindo reuso em testes, dashboards ou outros bots.
2. **Endpoints documentados** – Qualquer novo cliente HTTP (Node, Python, etc.) pode conversar com o servidor sem código específico do Binance.
3. **Melhor observabilidade** – Logs com timestamps e sniffer WS facilitam diagnóstico de desvios.
4. **Resiliência** – A redundância Redis/memória, priming e retry tornam o sistema tolerante a falhas momentâneas.

---

## Próximas melhorias sugeridas

- Adicionar métricas (Prometheus/StatsD) no cache server para monitorar latência e tamanho dos caches.
- Implementar autenticação simples se o serviço for exposto na rede.
- Suporte a múltiplos intervalos de polling ou webhooks para alertas.

---

Este documento deve ser atualizado sempre que houver alteração relevante nas responsabilidades ou implementação dos dois principais componentes (`cacheServer.js` e `TradeBot.js`).

<!-- Fim do arquivo -->