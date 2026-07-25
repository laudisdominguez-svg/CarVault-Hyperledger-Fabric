/**
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  CARVAULT VIP - FABRIC SDK INTEGRATION                                ║
 * ║  Cliente para invocar chaincodes en Hyperledger Fabric                ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 */
import { CONFIG } from "./config";
import { createFabricGateway, getContract } from './fabric-network';
// ═════════════════════════════════════════════════════════════════════════════
// FABRIC CLIENT
// ═════════════════════════════════════════════════════════════════════════════
export class FabricClient {
    constructor() {
        this.gatewayConnected = false;
        this.contractInstances = new Map();
    }
    /**
     * Inicializar conexión a Fabric
     */
    async connect() {
        try {
            console.log("🔗 Conectando a Hyperledger Fabric...");
            console.log(`   📍 Canal: ${CONFIG.FABRIC.CHANNEL_ID}`);
            console.log(`   📍 Peer: ${CONFIG.FABRIC.PEER_HOST}:${CONFIG.FABRIC.PEER_PORT}`);
            console.log(`   📍 Orderer: ${CONFIG.FABRIC.ORDERER_HOST}:${CONFIG.FABRIC.ORDERER_PORT}`);
            this.gateway = await createFabricGateway();
            this.gatewayConnected = true;
            console.log("✅ Conectado a Fabric correctamente\n");
        }
        catch (error) {
            console.error("❌ Error conectando a Fabric:", error.message);
            throw error;
        }
    }
    /**
     * Invocar función en chaincode (escritura)
     * @param chaincodeName Nombre del chaincode (ej: car-cc)
     * @param functionName Nombre de la función (ej: RegisterCar)
     * @param args Argumentos de la función
     */
    async invoke(chaincodeName, functionName, args) {
        try {
            if (!this.gatewayConnected || !this.gateway) {
                throw new Error("Gateway no está conectado. Ejecutar connect() primero.");
            }
            console.log(`⏳ Invocando ${chaincodeName}.${functionName}(${args.join(", ")})`);
            const contract = await this.getContract(chaincodeName);
            const resultBuffer = await contract.submitTransaction(functionName, ...args);
            const txId = contract.getTransactionId?.() || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            console.log(`✅ Transacción enviada: ${txId}\n`);
            return {
                success: true,
                txId,
                payload: resultBuffer.toString('utf8'),
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            console.error(`❌ Error invocando ${chaincodeName}.${functionName}:`, error.message);
            return {
                success: false,
                error: error.message,
                timestamp: new Date().toISOString(),
            };
        }
    }
    /**
     * Consultar estado en chaincode (lectura)
     * @param chaincodeName Nombre del chaincode
     * @param functionName Nombre de la función (ej: GetCar)
     * @param args Argumentos
     */
    async query(chaincodeName, functionName, args) {
        try {
            if (!this.gatewayConnected || !this.gateway) {
                throw new Error("Gateway no está conectado. Ejecutar connect() primero.");
            }
            console.log(`🔍 Consultando ${chaincodeName}.${functionName}(${args.join(", ")})`);
            const contract = await this.getContract(chaincodeName);
            const resultBuffer = await contract.evaluateTransaction(functionName, ...args);
            console.log(`✅ Query completada\n`);
            return {
                success: true,
                data: JSON.parse(resultBuffer.toString('utf8')),
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            console.error(`❌ Error en query ${chaincodeName}.${functionName}:`, error.message);
            return {
                success: false,
                error: error.message,
                timestamp: new Date().toISOString(),
            };
        }
    }
    /**
     * Obtener historial de un asset
     * @param chaincodeName Nombre del chaincode
     * @param assetId ID del asset
     */
    async getHistory(chaincodeName, assetId) {
        try {
            console.log(`📜 Obteniendo historial de ${assetId}`);
            const contract = await this.getContract(chaincodeName);
            const resultBuffer = await contract.evaluateTransaction('GetHistory', assetId);
            console.log(`✅ Historial obtenido\n`);
            return {
                success: true,
                data: JSON.parse(resultBuffer.toString('utf8')),
                timestamp: new Date().toISOString(),
            };
        }
        catch (error) {
            console.error(`❌ Error obteniendo historial:`, error.message);
            return {
                success: false,
                error: error.message,
                timestamp: new Date().toISOString(),
            };
        }
    }
    /**
     * Desconectar del gateway
     */
    async disconnect() {
        try {
            console.log("🔌 Desconectando de Fabric...");
            if (this.gateway) {
                this.gateway.disconnect();
            }
            this.gatewayConnected = false;
            console.log("✅ Desconectado\n");
        }
        catch (error) {
            console.error("❌ Error desconectando:", error.message);
        }
    }
    /**
     * Obtener instancia de contrato
     */
    async getContract(chaincodeName) {
        if (!this.contractInstances.has(chaincodeName)) {
            if (!this.gateway) {
                throw new Error('Gateway no está inicializado.');
            }
            const contract = await getContract(this.gateway, chaincodeName);
            this.contractInstances.set(chaincodeName, contract);
        }
        return this.contractInstances.get(chaincodeName);
    }
    /**
     * Verificar estado de conexión
     */
    isConnected() {
        return this.gatewayConnected;
    }
}
// ═════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Crear instancia singleton de FabricClient
 */
let fabricClientInstance = null;
export async function getFabricClient() {
    if (!fabricClientInstance) {
        fabricClientInstance = new FabricClient();
        await fabricClientInstance.connect();
    }
    return fabricClientInstance;
}
/**
 * Invocar chaincode car-cc
 */
export async function invokeCarCC(functionName, args) {
    const client = await getFabricClient();
    return client.invoke(CONFIG.CHAINCODES.CAR_CC, functionName, args);
}
/**
 * Invocar chaincode identity-cc
 */
export async function invokeIdentityCC(functionName, args) {
    const client = await getFabricClient();
    return client.invoke(CONFIG.CHAINCODES.IDENTITY_CC, functionName, args);
}
/**
 * Invocar chaincode payment-cc
 */
export async function invokePaymentCC(functionName, args) {
    const client = await getFabricClient();
    return client.invoke(CONFIG.CHAINCODES.PAYMENT_CC, functionName, args);
}
/**
 * Invocar chaincode maintenance-cc
 */
export async function invokeMaintenanceCC(functionName, args) {
    const client = await getFabricClient();
    return client.invoke(CONFIG.CHAINCODES.MAINTENANCE_CC, functionName, args);
}
