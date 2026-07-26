import dotenv from 'dotenv';

dotenv.config();

/**
 * CONFIGURACIÓN UNIFICADA DEL PROYECTO CARVAULT
 * 
 * Esta configuración centraliza:
 * - Credenciales y variables de entorno
 * - Conectores a Hyperledger Fabric
 * - Constantes compartidas del sistema
 * - Configuración de MySQL
 */

// ──────────────────────────────────────────────────────────────────────────
// VARIABLES DE ENTORNO
// ──────────────────────────────────────────────────────────────────────────

export const CONFIG = {
  // API y Servidor
  APP_NAME: 'CarVault VIP - Sistema Integrado Fabric-MySQL',
  VERSION: '1.0.0',
  ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT),
  HOST: process.env.HOST,

  // Base de Datos MySQL
  MYSQL: {
    HOST: process.env.MYSQL_HOST,
    PORT: parseInt(process.env.MYSQL_PORT),
    DATABASE: process.env.MYSQL_DATABASE,
    USER: process.env.MYSQL_USER || 'root',
    PASSWORD: process.env.MYSQL_PASSWORD,
    SSL: process.env.MYSQL_SSL === 'true',
    POOL_SIZE: parseInt(process.env.MYSQL_POOL_SIZE),
  },

  // Hyperledger Fabric
  FABRIC: {
    CHANNEL_ID: process.env.FABRIC_CHANNEL,
    ORG_MSP_ID: process.env.FABRIC_MSP || 'AutoVaultMSP',
    PEER_HOST: process.env.FABRIC_PEER_HOST || 'localhost',
    PEER_PORT: parseInt(process.env.FABRIC_PEER_PORT),
    ORDERER_HOST: process.env.FABRIC_ORDERER_HOST || 'localhost',
    ORDERER_PORT: parseInt(process.env.FABRIC_ORDERER_PORT),
    CA_HOST: process.env.FABRIC_CA_HOST || 'localhost',
    CA_PORT: parseInt(process.env.FABRIC_CA_PORT),
    CONNECTION_PROFILE_PATH: process.env.FABRIC_CONNECTION_PROFILE || './fabric-connection-profile.json',
    WALLET_PATH: process.env.FABRIC_WALLET_PATH || './wallet',
    USER_IDENTITY: process.env.FABRIC_USER_IDENTITY || 'org1User',
  },

  // Chaincodes
  CHAINCODES: {
    CAR_CC: 'car-cc',
    PAYMENT_CC: 'payment-cc',
    IDENTITY_CC: 'identity-cc',
    MAINTENANCE_CC: 'maintenance-cc',
  },

  // Gemini AI
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'MY_GEMINI_API_KEY',

  // CouchDB (State Database de Fabric)
  COUCHDB: {
    HOST: process.env.COUCHDB_HOST || 'localhost',
    PORT: parseInt(process.env.COUCHDB_PORT || '5984', 10),
    USER: process.env.COUCHDB_USER || 'admin',
    PASSWORD: process.env.COUCHDB_PASSWORD || 'adminpw',
  },

  // S3 / File Storage
  STORAGE: {
    TYPE: process.env.STORAGE_TYPE || 's3', // 's3' | 'azure' | 'ipfs'
    BUCKET: process.env.STORAGE_BUCKET || 'carvault-documents',
    REGION: process.env.STORAGE_REGION || 'us-east-1',
    ACCESS_KEY: process.env.STORAGE_ACCESS_KEY || '',
    SECRET_KEY: process.env.STORAGE_SECRET_KEY || '',
  },

  // Seguridad y JWT
  JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  JWT_EXPIRY: process.env.JWT_EXPIRY || '24h',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FORMAT: process.env.LOG_FORMAT || 'json',
};

// ──────────────────────────────────────────────────────────────────────────
// CONSTANTES DE NEGOCIO
// ──────────────────────────────────────────────────────────────────────────

export const BUSINESS_RULES = {
  // Planes de Suscripción
  SUBSCRIPTION_PLANS: {
    SILVER: {
      maxCars: 5,
      durationDays: 365,
      priceUSD: 2500,
    },
    GOLD: {
      maxCars: 15,
      durationDays: 365,
      priceUSD: 7500,
    },
    PLATINUM: {
      maxCars: 99999,
      durationDays: 365,
      priceUSD: 25000,
    },
  },

  // Estados de Vehículos
  CAR_STATUS: ['ACTIVE', 'IN_MAINTENANCE', 'INACTIVE'] as const,

  // Estados de Servicios
  SERVICE_STATUS: [
    'REQUESTED',
    'SCHEDULED',
    'EN_ROUTE',
    'IN_PROGRESS',
    'COMPLETED_BY_TECH',
    'CONFIRMED_BY_CLIENT',
    'CANCELLED',
  ] as const,

  // Tipos de Servicios
  SERVICE_TYPES: [
    'DETALLADO',
    'CAMBIO_ACEITE',
    'INSPECCION_MECANICA',
    'RESTAURACION_PARCIAL',
    'ALMACENAMIENTO',
  ] as const,

  // Condiciones de Vehículos
  CAR_CONDITIONS: [
    'CONCURSO',
    'EXCELENTE',
    'BUENA',
    'REGULAR',
    'RESTAURACION',
  ] as const,

  // Transmisiones
  TRANSMISSIONS: ['MANUAL', 'AUTOMATICA', 'SEMI_AUTOMATICA'] as const,

  // MSPs (Membership Service Providers)
  MSPS: {
    AUTOVAULT: 'AutoVaultMSP',
    CLIENTS_VIP: 'ClientesVIPMSP',
    TECNICOS: 'TecnicosMSP',
  } as const,
};

// ──────────────────────────────────────────────────────────────────────────
// CONSTANTES DE SYNCHRONIZACIÓN
// ──────────────────────────────────────────────────────────────────────────

export const SYNC_CONFIG = {
  // Estrategia de sincronización
  STRATEGY: 'EVENT_DRIVEN', // 'EVENT_DRIVEN' | 'POLLING' | 'HYBRID'

  // Tiempos de reintento
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 1000,
  RETRY_BACKOFF: 2, // exponencial

  // Timeouts
  FABRIC_TIMEOUT_MS: 10000,
  DB_TIMEOUT_MS: 5000,

  // Batch processing
  BATCH_SIZE: 10,
  BATCH_INTERVAL_MS: 5000,

  // Event streaming
  KAFKA_BROKERS: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  KAFKA_TOPIC: 'carvault-events',
  KAFKA_GROUP_ID: 'carvault-sync-group',
};

// ──────────────────────────────────────────────────────────────────────────
// TABLAS Y ÍNDICES DE MySQL
// ──────────────────────────────────────────────────────────────────────────

export const DB_TABLES = {
  OWNERS: 'owners',
  USERS: 'users',
  ROLES_PERMISSIONS: 'roles_permissions',
  LOCATIONS: 'locations',
  COLLECTIONS: 'collections',
  VEHICLES: 'vehicles',
  INVENTORY_MOVEMENTS: 'inventory_movements',
  PROPERTY_CHANGES_HISTORY: 'property_changes_history',
  VEHICLE_DOCUMENTS: 'vehicle_documents',
  BLOCKCHAIN_TX_REF: 'blockchain_tx_ref',
  OPERATIONAL_AUDIT: 'operational_audit',
} as const;

// ──────────────────────────────────────────────────────────────────────────
// VALIDADORES Y FORMATTERS
// ──────────────────────────────────────────────────────────────────────────

export const VALIDATORS = {
  VIN_LENGTH: 17,
  VIN_REGEX: /^[A-HJ-NPR-Z0-9]{17}$/i,

  EMAIL_REGEX: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,

  UUID_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,

  X509_PATTERN: /x509::[^:]*::[A-Za-z0-9\/=+]+$/,
};

// ──────────────────────────────────────────────────────────────────────────
// FUNCIONES AUXILIARES
// ──────────────────────────────────────────────────────────────────────────

export function getConnectionString(): string {
  const { MYSQL } = CONFIG;
  const protocol = MYSQL.SSL ? 'mysql://' : 'mysql://';
  return `${protocol}${MYSQL.USER}:${MYSQL.PASSWORD}@${MYSQL.HOST}:${MYSQL.PORT}/${MYSQL.DATABASE}`;
}

export function getFabricConfig() {
  const { FABRIC, CHAINCODES } = CONFIG;
  return {
    channelId: FABRIC.CHANNEL_ID,
    mspId: FABRIC.ORG_MSP_ID,
    peers: {
      peer0: `grpc${FABRIC.PEER_HOST === 'localhost' ? '' : 's'}://${FABRIC.PEER_HOST}:${FABRIC.PEER_PORT}`,
    },
    orderers: {
      orderer0: `grpc${FABRIC.ORDERER_HOST === 'localhost' ? '' : 's'}://${FABRIC.ORDERER_HOST}:${FABRIC.ORDERER_PORT}`,
    },
    chaincodes: CHAINCODES,
  };
}

export function isProduction(): boolean {
  return CONFIG.ENV === 'production';
}

export function isDevelopment(): boolean {
  return CONFIG.ENV === 'development';
}

export default CONFIG;
