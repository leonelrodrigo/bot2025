// dcaStrategy.js - Versão melhorada com cálculo de ganhos
const chalk = require('chalk');

class DCAStrategy {
    constructor(config) {
        // config.maxOrders foi o nome usado nos arquivos de configuração
        // mas internamente tratamos esse valor como número de ordens EXTRAS
        // (a primeira ordem inicial não conta). Preservamos compatibilidade
        // aceitando também config.maxExtraOrders.
        this.maxExtraOrders = (config.maxOrders !== undefined)
            ? config.maxOrders
            : (config.maxExtraOrders !== undefined ? config.maxExtraOrders : 3);
        this.targetPercent = config.targetPercent || 0.5;
        this.symbol = config.symbol;
        this.base = config.base;
        this.moeda = config.moeda;
        this.strategy = config.strategy;

        // Configuração de ganhos
        this.profitConfig = {
            baseProfit: config.baseProfit || 0.5,           // Lucro base por ordem
            extraOrderMultiplier: config.extraOrderMultiplier || 1.2, // Multiplicador para ordens extras
            minTotalProfit: config.minTotalProfit || 0.5,    // Lucro mínimo total (%)
            maxTotalProfit: config.maxTotalProfit || 2.0,     // Lucro máximo total (%)
            compoundProfits: config.compoundProfits || false  // Se os lucros são compostos
        };

        this.reset();
    }

    reset() {
        this.positions = [];
        this.currentTargetPrice = null;
        this.initialPositionPrice = null;
        this.totalQuantity = 0;
        this.totalCost = 0;
        this.totalValue = 0;
        this.averageEntryPrice = null;
        this.ordersCount = 0;
        this.isActive = false;
        this.lastActionPrice = null;

        // Novos campos para tracking de ganhos
        this.expectedProfit = 0;           // Lucro esperado em base
        this.expectedProfitPercent = 0;     // Lucro esperado em percentual
        this.profitPerOrder = [];           // Array com lucro esperado por ordem
        this.weightedTargetPrice = null;    // Preço alvo ponderado
    }

    /**
     * Calcula o lucro esperado baseado nas ordens
     */
    calculateExpectedProfits() {
        if (this.positions.length === 0) return { total: 0, perOrder: [] };

        const profits = [];
        let totalExpectedBase = 0;
        let totalWeight = 0;

        this.positions.forEach((pos, index) => {
            // Cada ordem contribui com um lucro proporcional ao seu tamanho
            const orderWeight = pos.quantity / this.totalQuantity;

            // O lucro percentual para esta ordem depende se é a primeira ou extra
            let orderProfitPercent;
            if (index === 0) {
                // Primeira ordem: lucro base
                orderProfitPercent = this.profitConfig.baseProfit;
            } else {
                // Ordens extras: lucro multiplicado
                orderProfitPercent = this.profitConfig.baseProfit *
                    Math.pow(this.profitConfig.extraOrderMultiplier, index);
            }

            // Aplica limites
            orderProfitPercent = Math.min(
                orderProfitPercent,
                this.profitConfig.maxTotalProfit
            );

            // Calcula lucro em base para esta ordem
            const orderProfitBase = pos.amount * (orderProfitPercent / 100);

            profits.push({
                orderIndex: index,
                price: pos.price,
                quantity: pos.quantity,
                amount: pos.amount,
                weight: orderWeight,
                profitPercent: orderProfitPercent,
                profitBase: orderProfitBase,
                targetPrice: this.calculateOrderTargetPrice(pos.price, orderProfitPercent)
            });

            totalExpectedBase += orderProfitBase;
            totalWeight += orderWeight * orderProfitPercent;
        });

        // Lucro total percentual ponderado
        const totalProfitPercent = totalWeight;

        // Preço alvo ponderado
        let weightedTarget = 0;
        if (this.strategy === 'LONG') {
            weightedTarget = this.positions.reduce((sum, pos) => {
                return sum + (pos.price * (1 + totalProfitPercent / 100) * (pos.quantity / this.totalQuantity));
            }, 0);
        } else {
            weightedTarget = this.positions.reduce((sum, pos) => {
                return sum + (pos.price * (1 - totalProfitPercent / 100) * (pos.quantity / this.totalQuantity));
            }, 0);
        }

        return {
            perOrder: profits,
            totalProfitBase: totalExpectedBase,
            totalProfitPercent: totalProfitPercent,
            weightedTargetPrice: weightedTarget
        };
    }

    /**
     * Calcula o preço alvo para uma ordem específica
     */
    calculateOrderTargetPrice(price, profitPercent) {
        if (this.strategy === 'LONG') {
            return price * (1 + profitPercent / 100);
        } else {
            return price * (1 - profitPercent / 100);
        }
    }

    /**
     * Inicia uma nova posição
     */
    startPosition(price, quantity, amount) {
        this.reset();

        this.positions.push({
            price,
            quantity,
            timestamp: Date.now(),
            amount
        });

        this.totalQuantity = quantity;
        this.totalCost = amount;
        this.totalValue = amount;
        this.averageEntryPrice = price;
        this.ordersCount = 1;
        this.isActive = true;
        this.lastActionPrice = price;

        // Calcula lucros esperados
        const profits = this.calculateExpectedProfits();
        this.expectedProfit = profits.totalProfitBase;
        this.expectedProfitPercent = profits.totalProfitPercent;
        this.profitPerOrder = profits.perOrder;
        this.weightedTargetPrice = profits.weightedTargetPrice;

        // Define o alvo inicial como o preço alvo ponderado
        this.currentTargetPrice = this.weightedTargetPrice;

        this.logPositionStatus('iniciada');

        return this.getPositionInfo();
    }

    /**
     * Adiciona uma nova posição
     */
    addPosition(price, quantity, amount, ignoreCheck = false) {
        if (!this.isActive) {
            console.log(chalk.yellow('⚠️ DCA: Estratégia não está ativa'));
            return null;
        }

        // ordersCount inclui a ordem inicial; extras já usadas = ordersCount - 1
        const extrasUsed = this.ordersCount - 1;
        if (extrasUsed >= this.maxExtraOrders) {
            console.log(chalk.yellow(`⚠️ DCA: Número máximo de ordens extras (${this.maxExtraOrders}) atingido`));
            return null;
        }

        if (!ignoreCheck) {
            const isContraryMove = this.checkContraryMove(price);
            if (!isContraryMove) {
                return null;
            }
        }

        // Adiciona nova posição
        this.positions.push({
            price,
            quantity,
            timestamp: Date.now(),
            amount
        });

        // Recalcula totais
        this.totalQuantity += quantity;
        this.totalCost += amount;
        this.totalValue = this.totalQuantity * price;
        this.averageEntryPrice = this.totalCost / this.totalQuantity;
        this.ordersCount++;
        this.lastActionPrice = price;

        // Recalcula lucros esperados
        const profits = this.calculateExpectedProfits();
        this.expectedProfit = profits.totalProfitBase;
        this.expectedProfitPercent = profits.totalProfitPercent;
        this.profitPerOrder = profits.perOrder;
        this.weightedTargetPrice = profits.weightedTargetPrice;

        // Atualiza alvo para o preço ponderado
        this.currentTargetPrice = this.weightedTargetPrice;

        this.logPositionStatus('ordem extra adicionada');

        return this.getPositionInfo();
    }

    /**
     * Log do status da posição com detalhes de ganhos
     */
    logPositionStatus(action) {
        console.log(chalk.cyan(`\n📊 DCA: Posição ${action}`));
        console.log(chalk.cyan(`   Ordens: ${this.ordersCount}/${1 + this.maxExtraOrders}`));
        console.log(chalk.cyan(`   Preço médio: ${this.averageEntryPrice.toFixed(6)}`));
        console.log(chalk.cyan(`   Alvo atual: ${this.currentTargetPrice.toFixed(6)}`));
        console.log(chalk.green(`   Lucro esperado: ${this.expectedProfit.toFixed(4)} ${this.base} (${this.expectedProfitPercent.toFixed(2)}%)`));

        // Mostra contribuição de cada ordem
        console.log(chalk.gray(`\n   Contribuição por ordem:`));
        this.profitPerOrder.forEach((p, i) => {
            const color = i === 0 ? chalk.white : chalk.gray;
            console.log(color(`   Ordem #${i + 1}: $${p.price.toFixed(2)} → $${p.targetPrice.toFixed(2)} (${p.profitPercent.toFixed(2)}% | ${p.profitBase.toFixed(4)} ${this.base})`));
        });
    }

    /**
     * Verifica se atingiu o alvo
     */
    checkTarget(currentPrice) {
        if (!this.isActive || !this.currentTargetPrice) return false;

        if (this.strategy === 'LONG') {
            return currentPrice >= this.currentTargetPrice;
        } else {
            return currentPrice <= this.currentTargetPrice;
        }
    }

    /**
     * Calcula o lucro atual
     */
    calculateCurrentProfit(currentPrice) {
        if (!this.isActive || !this.averageEntryPrice) return 0;

        const currentValue = this.totalQuantity * currentPrice;

        if (this.strategy === 'LONG') {
            return currentValue - this.totalCost;
        } else {
            return this.totalCost - currentValue;
        }
    }

    /**
     * Calcula o percentual de lucro atual em relação ao lucro esperado
     */
    calculateProgressToTarget(currentPrice) {
        if (!this.isActive || !this.currentTargetPrice) return 0;

        if (this.strategy === 'LONG') {
            const totalMove = this.currentTargetPrice - this.averageEntryPrice;
            const currentMove = currentPrice - this.averageEntryPrice;
            return (currentMove / totalMove) * 100;
        } else {
            const totalMove = this.averageEntryPrice - this.currentTargetPrice;
            const currentMove = this.averageEntryPrice - currentPrice;
            return (currentMove / totalMove) * 100;
        }
    }

    /**
     * Calcula quantidade para próxima ordem baseada no potencial de lucro
     */
    calculateNextOrderQuantity(currentPrice, availableBalance, minQty) {
        if (!this.isActive) return 0;
        // evitar cálculo se não há ordens extras restantes
        const extrasUsed = this.ordersCount - 1;
        if (extrasUsed >= this.maxExtraOrders) return 0;

        // Base quantity from first order
        const baseQuantity = this.positions[0]?.quantity || 0;

        // Calcula quanto precisamos para atingir o lucro desejado
        const currentProfit = this.calculateCurrentProfit(currentPrice);
        const remainingProfit = this.expectedProfit - currentProfit;

        // Se já estamos próximos do lucro esperado, não adicionar ordem
        if (remainingProfit <= 0) return 0;

        // Calcula quantidade necessária para atingir o lucro restante
        // Assumindo que a nova ordem também vai gerar lucro
        let suggestedQuantity;

        if (this.strategy === 'LONG') {
            // Para LONG: quanto precisamos comprar para que, quando o preço subir até o alvo,
            // o lucro total atinja o esperado
            const priceToTarget = this.currentTargetPrice - currentPrice;
            if (priceToTarget <= 0) return 0;

            const neededProfit = remainingProfit;
            const profitPerUnit = priceToTarget;
            suggestedQuantity = neededProfit / profitPerUnit;
        } else {
            // Para SHORT
            const priceToTarget = currentPrice - this.currentTargetPrice;
            if (priceToTarget <= 0) return 0;

            const neededProfit = remainingProfit;
            const profitPerUnit = priceToTarget;
            suggestedQuantity = neededProfit / profitPerUnit;
        }

        // Limita pelo saldo disponível
        const maxPossible = availableBalance / currentPrice;
        suggestedQuantity = Math.min(suggestedQuantity, maxPossible);

        // Garante mínimo
        suggestedQuantity = Math.max(suggestedQuantity, minQty);

        // Não ultrapassa 2x a quantidade base por segurança
        suggestedQuantity = Math.min(suggestedQuantity, baseQuantity * 2);

        return suggestedQuantity;
    }

    /**
     * Fecha a posição
     */
    closePosition(exitPrice, exitQuantity, exitAmount) {
        if (!this.isActive) return null;

        const profit = this.calculateCurrentProfit(exitPrice);
        const profitPercent = ((profit / this.totalCost) * 100);
        const progress = this.calculateProgressToTarget(exitPrice);

        console.log(chalk.green(`\n💰 DCA: Posição fechada com sucesso!`));
        console.log(chalk.green(`   Preço médio: ${this.averageEntryPrice.toFixed(6)} → Saída: ${exitPrice.toFixed(6)}`));
        console.log(chalk.green(`   Lucro realizado: ${profit.toFixed(4)} ${this.base} (${profitPercent.toFixed(2)}%)`));
        console.log(chalk.green(`   Lucro esperado: ${this.expectedProfit.toFixed(4)} ${this.base} (${this.expectedProfitPercent.toFixed(2)}%)`));
        console.log(chalk.green(`   Progresso do alvo: ${progress.toFixed(1)}%`));
        console.log(chalk.green(`   Ordens utilizadas: ${this.ordersCount}/${1 + this.maxExtraOrders}`));

        // Detalhamento por ordem
        console.log(chalk.gray(`\n   Desempenho por ordem:`));
        this.positions.forEach((pos, i) => {
            const orderProfit = (exitPrice - pos.price) * pos.quantity;
            const orderProfitPercent = ((exitPrice - pos.price) / pos.price) * 100;
            const expectedForOrder = this.profitPerOrder[i]?.profitBase || 0;
            const achievement = (orderProfit / expectedForOrder) * 100;

            console.log(chalk.gray(
                `   Ordem #${i + 1}: $${pos.price.toFixed(2)} → $${exitPrice.toFixed(2)} | ` +
                `Lucro: ${orderProfit.toFixed(4)} ${this.base} (${orderProfitPercent.toFixed(2)}%) | ` +
                `Meta: ${achievement.toFixed(0)}%`
            ));
        });

        const result = {
            ...this.getPositionInfo(),
            exitPrice,
            exitQuantity,
            exitAmount,
            profit,
            profitPercent,
            expectedProfit: this.expectedProfit,
            expectedProfitPercent: this.expectedProfitPercent,
            achievement: (profit / this.expectedProfit) * 100,
            timestamp: Date.now()
        };

        this.reset();
        return result;
    }

    /**
     * Verifica se o preço se moveu de forma contrária à posição,
     * justificando uma nova ordem DCA.
     */
    checkContraryMove(currentPrice) {
        if (!this.isActive || !this.lastActionPrice) return false;
        // não insere nova ordem se já atingimos máximo de extras
        const extrasUsed = this.ordersCount - 1;
        if (extrasUsed >= this.maxExtraOrders) {
            //console.log(chalk.yellow('⚠️ DCA: máximo de ordens extras atingido, não há movimento contrário')); // opcional
            return false;
        }

        const movePercent = ((currentPrice - this.lastActionPrice) / this.lastActionPrice) * 100;

        if (this.strategy === 'LONG') {
            // Para LONG: movimento contrário = queda >= targetPercent
            return movePercent <= -(this.targetPercent);
        } else {
            // Para SHORT: movimento contrário = alta >= targetPercent
            return movePercent >= this.targetPercent;
        }
    }

    /**
     * Retorna um resumo da posição atual.
     */
    getPositionInfo() {
        return {
            isActive: this.isActive,
            ordersCount: this.ordersCount,
            maxOrders: 1 + this.maxExtraOrders, // total máximo (inicial + extras)
            averageEntryPrice: this.averageEntryPrice || 0,
            totalQuantity: this.totalQuantity,
            totalCost: this.totalCost,
            currentTargetPrice: this.currentTargetPrice || 0,
            expectedProfit: this.expectedProfit,
            expectedProfitPercent: this.expectedProfitPercent,
            positions: this.positions
        };
    }

    /**
     * Retorna o lucro/prejuízo realizado ao fechar agora (alias de calculateCurrentProfit).
     */
    calculateGuaranteedProfit(currentPrice) {
        return this.calculateCurrentProfit(currentPrice);
    }

    /**
     * Retorna o percentual de lucro/prejuízo atual em relação ao custo total.
     */
    calculateProfitPercent(currentPrice) {
        if (!this.isActive || this.totalCost === 0) return 0;
        const profit = this.calculateCurrentProfit(currentPrice);
        return (profit / this.totalCost) * 100;
    }

    /**
     * Cancela a estratégia DCA e reseta o estado.
     */
    cancel(reason = '') {
        if (reason) {
            console.log(chalk.yellow(`⚠️ DCA: Estratégia cancelada — ${reason}`));
        }
        this.reset();
    }
}

module.exports = DCAStrategy;