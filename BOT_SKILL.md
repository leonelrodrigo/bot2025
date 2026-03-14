# Skill para Agente - Bot de Trading Binance

Este arquivo descreve o "skill" que um agente deve usar para entender, diagnosticar e evoluir o código do bot.
O objetivo é fornecer contexto suficiente para que o agente responda a dúvidas, sugira melhorias, explique o sistema ou ajude na expansão para dezenas de instâncias.

## 1. Propósito do Skill

- Fornecer ao agente a estrutura, configurações e funcionalidades do bot.
- Permitir geração de documentação, explicações de parâmetros e diagnóstico.
- Servir como referência para implementação de novos recursos e para avaliar impactos de mudanças em ambiente multibot.

## 2. Componentes Principais

### `binance.js`
O script principal que:
- Carrega configurações, saldos e estatísticas.
- Interage com a API Binance para preços e execução de ordens.
- Mantém lógica de estratégia, stop loss, DCA e reinvestimento.
- Usa `updtRsi.getValue()` para obter RSI; a lógica de RSI foi externalizada para permitir cache.
- Contém vários utilitários (conversão de ativos, ajuste de quantidades, etc.) que podem ser modularizados.

### `cacheServer.js`
Servidor Node/Express que:
- Recebe requisições dos bots para monitorar um par/intervalo (`/cache`).
- Faz um único polling por par/intervalo à Binance e atualiza o cache periodicamente.
- Abastece também **preços em tempo real** e **stats 24h** usando um único websocket conectado à Binance.
- Armazena candles, preços e stats no Redis (ou em memória se Redis indisponível).
- Expõe endpoints adicionais (`/price`, `/stats24h`, etc.) para que qualquer bot obtenha dados de mercado sem chamar a Binance diretamente.
- Serve esses dados a todos os bots, reduzindo o consumo de rate‑limit e simplificando a arquitetura multibot.
- É o ponto natural para adicionar métricas e escalar horizontalmente (cluster, contêineres, etc.).

### `rsi.js`
Módulo que calcula o RSI com base nos fechamentos de candles.
- Primeiro tenta puxar da chave `candles:<symbol>:<interval>` no Redis.
- Em caso de falha, busca diretamente via API (fallback).
- Isso isola o cálculo de RSI e facilita o uso de cache.

## 3. Configurações e Estratégias

Ver seção 6 do manual (`MANUAL_BOT.md`) para a lista completa de configurações.

### Estratégias suportadas
- LONG/SHORT com parâmetros de entrada/saída.
- Reinvestimento em `base`, `moeda` ou modo `equal`.  
  * `base`: lucro guardado em ativo base e usado para garantir que a banca inicial não encolha; resto vira lucro.  
  * `moeda`: lucro convertido diretamente em moeda negociada.  
  * `equal`: preserva o valor usado na última ordem (inclui ordens extras DCA), recompondo qualquer déficit com lucro acumulado.
- DCA com `maxOrders`, `targetPercent` e `profitConfig` (baseProfit, extraOrderMultiplier, min/max total profit).
- Stop loss adaptativo influenciado pelo estado de DCA (`adaptiveStopLoss`) e buffer configurável (`stopLossBuffer`).

O agente deve compreender como cada parâmetro influencia a tomada de decisão.

## 4. Operação Multibot

- Um único cache server central alimentando vários bots.
- Cada bot roda seu próprio arquivo de estatísticas e usa a mesma base de candles.
- A configuração `BOT_ID` permite separar arquivos quando necessário.
- Para escalar acima de ~50 instâncias recomenda‑se:
  - hospedar `cacheServer` em infraestrutura dedicada ou em cluster (PM2, Docker, Kubernetes).
  - dimensionar Redis (sentinelas/clustering) e usar prefixos/nomes distintos por ambiente.
  - distribuir bots entre várias máquinas para evitar saturar CPU, I/O e watchers de arquivo.
  - migrar configurações sensíveis para um serviço externo (HTTP/DB) em vez de múltiplos `fs.watch`.
  - monitorar métricas centralizadas (tempo de resposta, consumo de API, memória) e logs (ELK, Prometheus).

## 5. Logs e Diagnóstico

- `cacheServer` exibe se o Redis está conectado e quando atualiza cada par.
- Bots logam saldos, RSI, variações e tradeSide a cada ciclo.
- Erros do Redis são capturados e desativam o cache automaticamente.
- Métricas extras podem ser adicionadas ao `cacheServer` (contadores de requisições, latência) e ao bot (tempo de ciclo, número de ordens).

## 6. Uso do Skill

Quando questionado, o agente pode:
- Explicar qualquer bloco de código presente nos arquivos citados.
- Ajudar a ajustar parâmetros ou adicionar novos recursos.
- Fornecer exemplos de como iniciar o sistema, testar o cache e escalar bots.
- Sugerir refatorações ou melhorias baseadas nas configurações atuais.
- Propor arquiteturas modulares ou distribuídas para suportar dezenas de instâncias com estabilidade.

Este documento e o manual são suficientes para que o agente compreenda e interaja com toda a base de código.
