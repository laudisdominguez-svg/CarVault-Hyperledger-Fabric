/**
 * fabric-types-extended.ts
 * Extensiones de tipos para Hyperledger Fabric v2.5
 * Resuelve problemas de tipado con iteradores async
 */

import { Context, StateQueryIterator, HistoryQueryIterator } from 'fabric-contract-api';

declare module 'fabric-contract-api' {
  interface StateQueryIterator {
    [Symbol.asyncIterator](): AsyncIterator<any>;
  }

  interface HistoryQueryIterator {
    [Symbol.asyncIterator](): AsyncIterator<any>;
  }
}

// Para usarlo, simplemente importa este archivo en los contratos
export {};
