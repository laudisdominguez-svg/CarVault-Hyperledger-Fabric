/**
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  CARVAULT VIP - FABRIC SDK INTEGRATION                                ║
 * ║  Cliente para invocar chaincodes en Hyperledger Fabric                ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 */

import { CONFIG } from "./config.js";
import { Gateway } from 'fabric-network';
import { createFabricGateway, getContract } from './fabric-network.js';

// ═════════════════════════════════════════════════════════════════════════════
// TIPOS DE FABRIC
// ═════════════════════════════════════════════════════════════════════════════

export interface FabricChaincodeResult {
  success: boolean;
  txId?: string;
  blockNumber?: number;
  payload?: string;
  error?: string;
  timestamp: string;
}

export interface FabricQueryResult {
  success: boolean;
  data?: any;
  error?: string;
  timestamp: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// FABRIC CLIENT
// ═════════════════════════════════════════════════════════════════════════════

export class FabricClient {
  private gatewayConnected = false;
  private gateway?: Gateway;
  private contractInstances: Map<string, any> = new Map();

  /**
   * Inicializar conexión a Fabric
   */
  async connect(): Promise<void> {
    try {
      console.log("🔗 Conectando a Hyperledger Fabric...");
      console.log(`   📍 Canal: ${CONFIG.FABRIC.CHANNEL_ID}`);
      console.log(`   📍 Peer: ${CONFIG.FABRIC.PEER_HOST}:${CONFIG.FABRIC.PEER_PORT}`);
      console.log(`   📍 Orderer: ${CONFIG.FABRIC.ORDERER_HOST}:${CONFIG.FABRIC.ORDERER_PORT}`);

      this.gateway = await createFabricGateway();
      this.gatewayConnected = true;

      console.log("✅ Conectado a Fabric correctamente\n");
    } catch (error: any) {
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
  async invoke(
    chaincodeName: string,
    functionName: string,
    args: string[]
  ): Promise<FabricChaincodeResult> {
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
    } catch (error: any) {
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
  async query(
    chaincodeName: string,
    functionName: string,
    args: string[]
  ): Promise<FabricQueryResult> {
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
    } catch (error: any) {
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
  async getHistory(
    chaincodeName: string,
    assetId: string
  ): Promise<FabricQueryResult> {
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
    } catch (error: any) {
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
  async disconnect(): Promise<void> {
    try {
      console.log("🔌 Desconectando de Fabric...");
      if (this.gateway) {
        this.gateway.disconnect();
      }
      this.gatewayConnected = false;
      console.log("✅ Desconectado\n");
    } catch (error: any) {
      console.error("❌ Error desconectando:", error.message);
    }
  }

  /**
   * Obtener instancia de contrato
   */
  private async getContract(chaincodeName: string): Promise<any> {
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
  isConnected(): boolean {
    return this.gatewayConnected;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Crear instancia singleton de FabricClient
 */
let fabricClientInstance: FabricClient | null = null;

export async function getFabricClient(): Promise<FabricClient> {
  if (!fabricClientInstance) {
    fabricClientInstance = new FabricClient();
    await fabricClientInstance.connect();
  }
  return fabricClientInstance;
}

/**
 * Invocar chaincode car-cc
 */
export async function invokeCarCC(
  functionName: string,
  args: string[]
): Promise<FabricChaincodeResult> {
  const client = await getFabricClient();
  return client.invoke(CONFIG.CHAINCODES.CAR_CC, functionName, args);
}

/**
 * Invocar chaincode identity-cc
 */
export async function invokeIdentityCC(
  functionName: string,
  args: string[]
): Promise<FabricChaincodeResult> {
  const client = await getFabricClient();
  return client.invoke(CONFIG.CHAINCODES.IDENTITY_CC, functionName, args);
}

/**
 * Invocar chaincode payment-cc
 */
export async function invokePaymentCC(
  functionName: string,
  args: string[]
): Promise<FabricChaincodeResult> {
  const client = await getFabricClient();
  return client.invoke(CONFIG.CHAINCODES.PAYMENT_CC, functionName, args);
}

/**
 * Invocar chaincode maintenance-cc
 */
export async function invokeMaintenanceCC(
  functionName: string,
  args: string[]
): Promise<FabricChaincodeResult> {
  const client = await getFabricClient();
  return client.invoke(CONFIG.CHAINCODES.MAINTENANCE_CC, functionName, args);
}

