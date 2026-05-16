/*
 * AutoVault VIP — car-cc
 * Punto de entrada del chaincode de inventario de autos coleccionables
 *
 * Exporta:
 *   - CarContract: clase principal del contrato inteligente
 *   - Tipos e interfaces para clientes y aplicaciones
 */

export { CarContract } from './car.contract';

// Tipos e interfaces sincronizados con car.contract.ts
export interface Car {
  docType: 'car';
  carId: string;
  clientId: string;
  vin: string;
  marca: string;
  modelo: string;
  anio: number;
  color: string;
  numeracion: string;
  motor: string;
  cilindrada: string;
  transmision: 'MANUAL' | 'AUTOMATICA' | 'SEMI_AUTOMATICA';
  kilometraje: number;
  condicion: 'CONCURSO' | 'EXCELENTE' | 'BUENA' | 'REGULAR' | 'RESTAURACION';
  valoracionUSD: number;
  ultimaValuacion: string;
  valuadoPor: string;
  status: 'ACTIVE' | 'IN_MAINTENANCE' | 'INACTIVE';
  notasInternas: string;
  registradoPor: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  deletedBy?: string;
}

export interface CarDocument {
  docType: 'carDocument';
  docId: string;
  carId: string;
  clientId: string;
  tipo: 'TITULO_PROPIEDAD' | 'POLIZA_SEGURO' | 'CERTIFICADO_AUTENTICIDAD' | 'FACTURA_COMPRA' | 'HOMOLOGACION' | 'OTRO';
  descripcion: string;
  fileHash: string;
  fileUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  vencimiento: string;
}

export interface CarPhoto {
  docType: 'carPhoto';
  photoId: string;
  carId: string;
  clientId: string;
  fileHash: string;
  fileUrl: string;
  caption: string;
  esPrincipal: boolean;
  uploadedBy: string;
  uploadedAt: string;
}

export interface CarDeletion {
  docType: 'carDeletion';
  carId: string;
  clientId: string;
  deletedAt: string;
  deletedBy: string;
  carDataSnapshot: Car;
}

export interface SubscriptionResponse {
  status: string;
  plan: string;
  maxCars: number;
  endDate: string;
}

// Array de contratos disponibles
export const contracts: any[] = [{ CarContract }];

// Información del chaincode
export const chaincodeName = 'car-cc';
export const chaincodeVersion = '1.0.0';
export const chaincodeDescription = 'Inventario de autos coleccionables VIP — AutoVault';
