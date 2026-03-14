# Manual de Configuração — Trade Bot
## Estratégia DCA & Gerenciamento de Operações

> **Dollar-Cost Averaging (DCA) + controle de reinvestimento**  
> Versão 2.0 · Guia completo de parâmetros, lógica e modelos de estratégia

---

## Índice

1. [O Que é DCA?](#1-o-que-é-dca)
2. [Estrutura da Configuração](#2-estrutura-da-configuração)
3. [Bloco `operacao`](#3-bloco-operacao)
   - 3.1 [reinvestProfits](#31-reinvestprofits)
   - 3.2 [reinvestMode](#32-reinvestmode)
4. [Bloco `dca`](#4-bloco-dca)
   - 4.1 [enabled](#41-enabled)
   - 4.2 [maxOrders](#42-maxorders)
   - 4.3 [targetPercent](#43-targetpercent)
   - 4.4 [adaptiveStopLoss](#44-adaptivestoploss)
   - 4.5 [stopLossBuffer](#45-stoplossbuffer)
5. [Bloco `dca.profitConfig`](#5-bloco-dcaprofitconfig)
   - 5.1 [baseProfit](#51-baseprofit)
   - 5.2 [extraOrderMultiplier](#52-extraordermultiplier)
   - 5.3 [minTotalProfit](#53-mintotalprofit)
   - 5.4 [maxTotalProfit](#54-maxtotalprofit)
6. [Como os Parâmetros Interagem](#6-como-os-parâmetros-interagem)
7. [Modelos de Estratégia](#7-modelos-de-estratégia)
8. [Tabela de Referência Rápida](#8-tabela-de-referência-rápida)
9. [Erros Comuns](#9-erros-comuns)

---

## 1. O Que é DCA?

**Dollar-Cost Averaging (DCA)** é uma estratégia de alocação de capital que distribui compras de um ativo em múltiplos níveis de preço, em vez de realizar uma única compra com todo o capital disponível. No contexto de trade bots, o DCA funciona como um **mecanismo de recuperação de posições deficitárias**.

Quando a primeira ordem de compra (ordem base) entra no mercado e o preço recua, o bot executa ordens adicionais em preços progressivamente menores. Isso reduz o **preço médio de entrada** da posição total, tornando a meta de lucro mais fácil de atingir quando o preço se recuperar.

> 💡 **Princípio central:** O DCA não aumenta a chance de o mercado subir — ele reduz o preço médio da posição, diminuindo a distância que o preço precisa percorrer para que a operação se torne lucrativa.

### Fluxo de Funcionamento

```
1. Bot abre a ordem base no preço atual de mercado
       ↓
2. O preço recua abaixo do ponto de entrada
       ↓
3. Ao cair targetPercent%, o bot coloca a 1ª ordem DCA
       ↓
4. O preço médio da posição é recalculado
       ↓
5. Passos 2–4 se repetem até atingir maxOrders
       ↓
6. Quando o preço alcança o target de lucro, a posição é encerrada
       ↓
7. Lucro é tratado conforme reinvestProfits + reinvestMode
```

---

## 2. Estrutura da Configuração

A configuração é dividida em dois blocos principais:

```json
{
  "operacao": {
    "reinvestProfits": false,
    "reinvestMode": "equal"
  },
  "dca": {
    "enabled": false,
    "maxOrders": 3,
    "targetPercent": 0.25,
    "adaptiveStopLoss": true,
    "stopLossBuffer": 1.5,
    "profitConfig": {
      "baseProfit": 0.25,
      "extraOrderMultiplier": 1.2,
      "minTotalProfit": 0.25,
      "maxTotalProfit": 1.0
    }
  }
}
```

| Bloco | Responsabilidade |
|---|---|
| `operacao` | Define **o que fazer com o lucro** após o fechamento da posição |
| `dca` | Define **como acumular a posição** durante uma queda de preço |

---

## 3. Bloco `operacao`

Controla o comportamento do bot após o encerramento de uma operação lucrativa — especificamente, **como o lucro obtido é tratado** no ciclo seguinte.

---

### 3.1 `reinvestProfits`

| Campo | Tipo | Exemplo |
|---|---|---|
| `reinvestProfits` | `boolean` | `false` |

**Descrição:** Liga ou desliga o reinvestimento automático do lucro nas operações seguintes.

- `false` — O lucro é mantido/retirado conforme o modo configurado em `reinvestMode`, mas o tamanho das ordens não cresce automaticamente. Comportamento previsível e de risco fixo.
- `true` — O lucro gerado é reinvestido, aumentando progressivamente o capital alocado em novas operações. O comportamento exato do reinvestimento é controlado por `reinvestMode`.

> ⚠️ **Atenção:** Ao ativar `reinvestProfits: true`, o tamanho das posições cresce com o tempo. Certifique-se de que outros controles de risco (ex.: limite máximo de posição) estejam configurados para evitar exposição excessiva em sequências de drawdown.

---

### 3.2 `reinvestMode`

| Campo | Tipo | Exemplo | Depende de |
|---|---|---|---|
| `reinvestMode` | `string (enum)` | `"equal"` | `reinvestProfits` |

**Descrição:** Define a **lógica de como o lucro é alocado** no próximo ciclo de operação. Aceita três valores:

---

#### `"base"` — Mantém lucro em moeda base

O lucro permanece na moeda base (ex.: USDT). O tamanho das próximas ordens **não é alterado**. O saldo de base cresce a cada operação.

```
Operação 1: compra com 100 USDT → lucro 0.5 USDT → saldo base = 100.5 USDT
Operação 2: compra com 100 USDT (tamanho inalterado)
```

**Quando usar:** Quando o objetivo é acumular moeda base sem aumentar exposição. Ideal para bots conservadores ou quando `reinvestProfits: false`.

---

#### `"moeda"` — Converte lucro para o ativo negociado

O lucro em moeda base é **convertido para o ativo** (ex.: BTC). Somente ativo quando `reinvestProfits: true`. O saldo do ativo cresce e as próximas ordens usam mais do ativo acumulado.

```
Operação 1: compra 0.001 BTC → lucro em USDT → convertido para BTC
Operação 2: posição ligeiramente maior em BTC
```

**Quando usar:** Quando a estratégia é de **acumulação do ativo** ao longo do tempo — o bot compra mais do ativo a cada ciclo lucrativo.

---

#### `"equal"` — Mantém quantidade igual à última ordem (incluindo extras)

O bot usa parte do lucro para garantir que a **quantidade da próxima ordem base seja igual à quantidade total média das ordens anteriores**, incluindo as ordens DCA executadas. Isso mantém a consistência de tamanho mesmo após ciclos com múltiplas ordens DCA.

```
Ciclo com DCA: ordem base 100 USDT + 2 ordens DCA de 100 USDT cada
→ quantidade média por ordem = 100 USDT
→ próxima ordem base = 100 USDT (mantida igual)

Lucro redistribuído para reequilibrar o tamanho, não para crescer.
```

**Quando usar:** Quando se quer **consistência operacional** — o bot mantém sempre o mesmo tamanho de posição independente de quantas ordens DCA foram acionadas no ciclo anterior. Recomendado como padrão para estratégias de médio prazo.

---

#### Resumo comparativo dos modos

| `reinvestMode` | `reinvestProfits` necessário | Efeito no próximo ciclo | Perfil |
|---|---|---|---|
| `"base"` | `false` | Saldo base cresce, ordens iguais | Conservador |
| `"moeda"` | `true` | Mais ativo acumulado | Acumulação |
| `"equal"` | `false` / `true` | Tamanho de ordem normalizado | Consistência |

---

## 4. Bloco `dca`

Define o comportamento do mecanismo de Dollar-Cost Averaging — quando e como o bot executa ordens adicionais durante quedas de preço.

---

### 4.1 `enabled`

| Campo | Tipo | Exemplo |
|---|---|---|
| `enabled` | `boolean` | `false` |

**Descrição:** Ativa ou desativa completamente o módulo DCA. Com `false`, o bot opera com ordens simples sem acionamento de ordens adicionais em queda.

**Quando desativar:**
- Mercados em tendência fortemente de baixa
- Alta volatilidade onde ordens DCA podem agravar perdas
- Testes iniciais de configuração sem exposição adicional

---

### 4.2 `maxOrders`

| Campo | Tipo | Exemplo |
|---|---|---|
| `maxOrders` | `integer` | `3` |

**Descrição:** Número máximo de ordens DCA que o bot pode executar além da ordem base. Um valor de `3` significa até **4 ordens simultâneas** (1 base + 3 DCA).

**Impacto no capital necessário:**

| `maxOrders` | Ordens totais | Capital mínimo (ordens iguais) |
|---|---|---|
| 1 | 2 | 2× tamanho da ordem base |
| 3 | 4 | 4× tamanho da ordem base |
| 5 | 6 | 6× tamanho da ordem base |
| 10 | 11 | 11× tamanho da ordem base |

> ⚠️ Calcule sempre o capital máximo comprometido **antes** de definir `maxOrders`. Nunca configure mais ordens do que o capital disponível pode suportar.

---

### 4.3 `targetPercent`

| Campo | Tipo | Exemplo |
|---|---|---|
| `targetPercent` | `float` | `0.25` |

**Descrição:** Percentual de queda do preço, a partir da **última ordem executada**, necessário para acionar a próxima ordem DCA. O valor `0.25` representa uma queda de 0.25% (25 basis points).

Este parâmetro define o **espaçamento entre ordens no ladder de preço**.

| `targetPercent` | Espaçamento | Indicado para |
|---|---|---|
| `0.05 – 0.1%` | Muito apertado | Stablecoins, pares de baixa volatilidade |
| `0.1 – 0.5%` | Moderado | BTC, ETH em mercado calmo |
| `0.5 – 1.5%` | Espaçado | Altcoins de média/alta volatilidade |
| `1.5%+` | Muito espaçado | Ativos extremamente voláteis |

**Range total coberto:**
```
Range = targetPercent × maxOrders

Exemplo: 0.25% × 3 = 0.75% de cobertura total
```

---

### 4.4 `adaptiveStopLoss`

| Campo | Tipo | Exemplo |
|---|---|---|
| `adaptiveStopLoss` | `boolean` | `true` |

**Descrição:** Quando ativo, o stop-loss é **recalculado automaticamente** após cada nova ordem DCA, sendo baseado no novo preço médio ponderado da posição — não no preço de entrada da ordem base original.

| | `true` | `false` |
|---|---|---|
| **Stop baseado em** | Preço médio atual | Preço da ordem base |
| **Proteção** | Proporcional à posição real | Pode ser excessivamente distante |
| **Requer** | `stopLossBuffer` configurado | Não |
| **Recomendado** | Sim, para DCA | Não com DCA ativo |

---

### 4.5 `stopLossBuffer`

| Campo | Tipo | Exemplo |
|---|---|---|
| `stopLossBuffer` | `float` | `1.5` |

**Descrição:** Margem de segurança em percentual aplicada **abaixo do preço médio** da posição para posicionar o stop-loss. O valor `1.5` coloca o stop 1.5% abaixo do preço médio.

**Fórmula:**
```
Stop Loss = Preço Médio × (1 − stopLossBuffer / 100)
```

**Exemplo prático:**
```
Preço médio da posição: R$ 100.000
stopLossBuffer: 1.5

Stop Loss = 100.000 × (1 - 0.015) = R$ 98.500
```

**Calibração recomendada:** Use o ATR (Average True Range) diário do ativo como referência. O `stopLossBuffer` deve ser maior que movimentos normais intraday para evitar acionamentos indesejados (*stop hunt*).

---

## 5. Bloco `dca.profitConfig`

Define os alvos de lucro da operação e como eles se comportam conforme o número de ordens DCA executadas.

---

### 5.1 `baseProfit`

| Campo | Tipo | Exemplo |
|---|---|---|
| `baseProfit` | `float` | `0.25` |

**Descrição:** Percentual de lucro alvo para a **ordem base** (sem nenhuma ordem DCA acionada). O valor `0.25` representa um alvo de 0.25% de lucro na condição mais simples da operação.

> 💡 Mantenha `baseProfit` sempre acima do custo total da operação (spread + taxas + slippage). Em plataformas com 0.1% de taxa por lado, o `baseProfit` mínimo efetivo é **0.2%** para cobrir custos.

---

### 5.2 `extraOrderMultiplier`

| Campo | Tipo | Exemplo |
|---|---|---|
| `extraOrderMultiplier` | `float` | `1.2` |

**Descrição:** Fator multiplicador aplicado ao alvo de lucro para **cada ordem DCA adicional**. A cada nova ordem DCA executada, o target de lucro é multiplicado por este valor.

**Raciocínio:** Cada ordem DCA aumenta o risco e o capital exposto. Exigir um lucro proporcionalmente maior compensa esse risco incremental.

**Exemplo de progressão com `baseProfit: 0.25` e `extraOrderMultiplier: 1.2`:**

```
Ordem Base (0 DCA):   alvo = 0.25%
Após 1ª ordem DCA:    alvo = 0.25% × 1.2   = 0.30%
Após 2ª ordem DCA:    alvo = 0.30% × 1.2   = 0.36%
Após 3ª ordem DCA:    alvo = 0.36% × 1.2   = 0.432%
```

> ⚠️ Valores de `extraOrderMultiplier` acima de **2.0** com muitas ordens DCA podem criar alvos inatingíveis. Mantenha entre **1.1 e 1.5** para estratégias com 3+ ordens.

---

### 5.3 `minTotalProfit`

| Campo | Tipo | Exemplo |
|---|---|---|
| `minTotalProfit` | `float` | `0.25` |

**Descrição:** Lucro total mínimo exigido para que o bot **feche a posição**. Funciona como um piso — o bot não encerrará a operação abaixo deste percentual, mesmo que o cálculo resulte em valor menor.

Especialmente importante quando taxas de negociação são altas. Garante que nenhuma operação seja encerrada com lucro inferior ao necessário para cobrir custos.

**Regra:**
```
minTotalProfit ≥ (taxa de entrada + taxa de saída)
```

---

### 5.4 `maxTotalProfit`

| Campo | Tipo | Exemplo |
|---|---|---|
| `maxTotalProfit` | `float` | `1.0` |

**Descrição:** Teto de lucro total da operação. Quando o lucro acumulado atingir este valor, o bot **encerra a posição** independentemente de outros fatores. O valor `1.0` representa um alvo máximo de 1%.

Evita que o bot mantenha posições abertas indefinidamente aguardando lucros excessivos, reduzindo a exposição ao risco de reversão.

| Perfil | `maxTotalProfit` sugerido | Lógica |
|---|---|---|
| Scalper | `0.3 – 0.5%` | Alta frequência, pequenos ganhos |
| Day Trader | `0.5 – 1.5%` | Equilíbrio frequência/retorno |
| Swing Trader | `1.5 – 5.0%` | Menos operações, alvos maiores |

---

## 6. Como os Parâmetros Interagem

### 6.1 Envelope de Lucro

Os parâmetros de `profitConfig` formam um envelope com piso e teto:

```
alvo_calculado = baseProfit × (extraOrderMultiplier ^ nº_ordens_DCA)

alvo_final = max(minTotalProfit, min(alvo_calculado, maxTotalProfit))
```

**Exemplo com a configuração padrão após 2 ordens DCA:**
```
alvo_calculado = 0.25% × (1.2²) = 0.36%
alvo_final = max(0.25%, min(0.36%, 1.0%)) = 0.36%
→ Bot aguarda 0.36% de lucro para fechar
```

---

### 6.2 Stop-Loss Adaptativo em Ação

```
BTC entrada: $100.000 | targetPercent: 0.25% | stopLossBuffer: 1.5%

Ordem Base:   compra @ $100.000 | Preço médio: $100.000
              Stop = $100.000 × 0.985 = $98.500

1ª DCA:       compra @ $99.750  | Preço médio: $99.875
              Stop = $99.875 × 0.985 = $98.377

2ª DCA:       compra @ $99.501  | Preço médio: $99.750
              Stop = $99.750 × 0.985 = $98.254

3ª DCA:       compra @ $99.252  | Preço médio: $99.626
              Stop = $99.626 × 0.985 = $98.131
```

---

### 6.3 Interação entre `reinvestMode` e DCA

O `reinvestMode: "equal"` tem importância especial em conjunto com o DCA. Quando o bot executa 3 ordens DCA em um ciclo, o capital total comprometido é 4× o tamanho da ordem base. No ciclo seguinte, o modo `"equal"` normaliza o tamanho da ordem base para manter consistência, evitando que o bot inicie o próximo ciclo com uma posição muito diferente.

```
Ciclo anterior: 4 ordens × 100 USDT = 400 USDT comprometidos
reinvestMode: "equal" → próxima ordem base = 100 USDT (mantida)
                       (não cresce para compensar o ciclo anterior)
```

---

## 7. Modelos de Estratégia

### Estratégia 1 — Scalper Conservador
> Alta frequência · Baixo risco · Mercados estáveis

**Objetivo:** Muitas operações pequenas e rápidas com máxima proteção de capital.  
**Indicado para:** BTC/USDT, ETH/USDT em períodos de baixa volatilidade.

```json
{
  "operacao": {
    "reinvestProfits": false,
    "reinvestMode": "base"
  },
  "dca": {
    "enabled": true,
    "maxOrders": 2,
    "targetPercent": 0.05,
    "adaptiveStopLoss": true,
    "stopLossBuffer": 0.8,
    "profitConfig": {
      "baseProfit": 0.05,
      "extraOrderMultiplier": 1.1,
      "minTotalProfit": 0.05,
      "maxTotalProfit": 0.3
    }
  }
}
```

**Lógica:** `targetPercent` muito pequeno aciona DCA rapidamente. `maxOrders: 2` limita o capital comprometido. `maxTotalProfit: 0.3%` garante saídas rápidas. `reinvestMode: "base"` acumula saldo sem aumentar exposição.

---

### Estratégia 2 — Day Trader Equilibrado
> Frequência moderada · Risco balanceado · Configuração de referência

**Objetivo:** Equilíbrio entre frequência de operações e retorno por trade.  
**Indicado para:** A maioria dos pares de médio volume.

```json
{
  "operacao": {
    "reinvestProfits": false,
    "reinvestMode": "equal"
  },
  "dca": {
    "enabled": true,
    "maxOrders": 3,
    "targetPercent": 0.25,
    "adaptiveStopLoss": true,
    "stopLossBuffer": 1.5,
    "profitConfig": {
      "baseProfit": 0.25,
      "extraOrderMultiplier": 1.2,
      "minTotalProfit": 0.25,
      "maxTotalProfit": 1.0
    }
  }
}
```

**Lógica:** Esta é a configuração de referência do manual. Range total de 0.75% (3 × 0.25%). Alvos progressivos: 0.25%, 0.30%, 0.36%, 0.43%. O `reinvestMode: "equal"` mantém consistência de tamanho entre ciclos.

---

### Estratégia 3 — Swing Trader Agressivo
> Baixa frequência · Alto risco · Mercados voláteis

**Objetivo:** Capturar movimentos maiores em ativos de alta volatilidade.  
**Indicado para:** Altcoins, BTC em períodos de alta volatilidade.

```json
{
  "operacao": {
    "reinvestProfits": false,
    "reinvestMode": "equal"
  },
  "dca": {
    "enabled": true,
    "maxOrders": 5,
    "targetPercent": 1.0,
    "adaptiveStopLoss": true,
    "stopLossBuffer": 3.0,
    "profitConfig": {
      "baseProfit": 0.5,
      "extraOrderMultiplier": 1.5,
      "minTotalProfit": 0.5,
      "maxTotalProfit": 5.0
    }
  }
}
```

**Lógica:** Range total de 5% (5 × 1.0%) cobre movimentos expressivos. `stopLossBuffer: 3.0%` protege contra *stop hunt* em ativos voláteis. Alvos progressivos compensam o maior risco por operação.

---

### Estratégia 4 — Acumulação de Ativo
> Longo prazo · Reinvestimento em ativo · Bot rodando continuamente

**Objetivo:** Acumular progressivamente o ativo negociado com os lucros gerados.  
**Indicado para:** Bots operando 24/7 com visão de acumulação de BTC ou ETH.

```json
{
  "operacao": {
    "reinvestProfits": true,
    "reinvestMode": "moeda"
  },
  "dca": {
    "enabled": true,
    "maxOrders": 3,
    "targetPercent": 0.25,
    "adaptiveStopLoss": true,
    "stopLossBuffer": 2.0,
    "profitConfig": {
      "baseProfit": 0.25,
      "extraOrderMultiplier": 1.2,
      "minTotalProfit": 0.25,
      "maxTotalProfit": 2.0
    }
  }
}
```

**Lógica:** `reinvestProfits: true` + `reinvestMode: "moeda"` converte cada lucro em mais do ativo. O saldo do ativo cresce a cada ciclo. `maxTotalProfit: 2.0%` equilibra crescimento e frequência de fechamentos.

---

## 8. Tabela de Referência Rápida

### Bloco `operacao`

| Parâmetro | Tipo | Exemplo | Resumo |
|---|---|---|---|
| `reinvestProfits` | `boolean` | `false` | Liga/desliga reinvestimento de lucros |
| `reinvestMode` | `string` | `"equal"` | Como o lucro é alocado: `"base"`, `"moeda"` ou `"equal"` |

### Bloco `dca`

| Parâmetro | Tipo | Exemplo | Resumo |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Liga/desliga o módulo DCA |
| `maxOrders` | `integer` | `3` | Nº máximo de ordens DCA adicionais |
| `targetPercent` | `float` | `0.25` | % de queda para acionar próxima ordem DCA |
| `adaptiveStopLoss` | `boolean` | `true` | Stop recalculado a cada nova ordem DCA |
| `stopLossBuffer` | `float` | `1.5` | % abaixo do preço médio para o stop |

### Bloco `dca.profitConfig`

| Parâmetro | Tipo | Exemplo | Resumo |
|---|---|---|---|
| `baseProfit` | `float` | `0.25` | Alvo de lucro da ordem base (%) |
| `extraOrderMultiplier` | `float` | `1.2` | Multiplicador de lucro por ordem DCA |
| `minTotalProfit` | `float` | `0.25` | Lucro mínimo para fechar a posição (%) |
| `maxTotalProfit` | `float` | `1.0` | Teto de lucro — fecha ao atingir (%) |

---

## 9. Erros Comuns

### ❌ Erro 1 — Range DCA insuficiente para a volatilidade do ativo

**Sintoma:** O preço cai mais do que `targetPercent × maxOrders` e o bot fica preso sem ordens DCA disponíveis.

**Solução:** Aumente `maxOrders` ou `targetPercent`. Calcule o ATR diário do ativo e dimensione o range para cobrir pelo menos **50% do ATR diário**.

---

### ❌ Erro 2 — `minTotalProfit` menor que o custo total da operação

**Sintoma:** O bot fecha operações aparentemente lucrativas, mas o saldo não cresce.

**Solução:** Some todas as taxas (entrada + saída) e defina `minTotalProfit` acima deste valor. Com 0.1% por operação: `minTotalProfit ≥ 0.2%`.

---

### ❌ Erro 3 — `reinvestProfits: true` sem controle de exposição máxima

**Sintoma:** Em drawdowns consecutivos, o bot abre posições cada vez maiores, podendo comprometer o capital de forma descontrolada.

**Solução:** Use `reinvestProfits: true` somente com um limite máximo de posição configurado em outros módulos do bot. Prefira `reinvestMode: "equal"` como ponto de partida mais seguro.

---

### ❌ Erro 4 — `stopLossBuffer` muito pequeno em ativos voláteis

**Sintoma:** O stop é acionado por movimentos normais de curto prazo (*stop hunt*), mesmo antes de qualquer movimento adverso real.

**Solução:** Calibre o `stopLossBuffer` usando o ATR do ativo. Para BTC, um buffer de **1.5–2.5%** costuma ser adequado. Para altcoins de alta volatilidade, considere **3.0–5.0%**.

---

### ❌ Erro 5 — `extraOrderMultiplier` alto com muitas ordens DCA

**Sintoma:** Com 5+ ordens DCA e multiplicador 2.0, o alvo da última ordem pode ultrapassar o `maxTotalProfit`, criando inconsistências na lógica de saída.

**Solução:** Mantenha `extraOrderMultiplier` entre **1.1 e 1.5** para estratégias com 3+ ordens. Reserve valores mais altos para configurações com poucas ordens DCA.

---

### ❌ Erro 6 — `reinvestMode: "moeda"` com `reinvestProfits: false`

**Sintoma:** O bot está configurado para converter lucro em ativo, mas `reinvestProfits: false` desativa o reinvestimento. O modo `"moeda"` não tem efeito.

**Solução:** Para usar `reinvestMode: "moeda"` de forma efetiva, configure `reinvestProfits: true`. Para acumulação passiva sem reinvestimento ativo, use `reinvestMode: "base"` com `reinvestProfits: false`.

---

*Manual de Configuração DCA — Trade Bot · Versão 2.0*  
*Realize sempre backtests antes de operar com capital real.*
