/*
 * AutoVault VIP — payment-cc
 * Punto de entrada del chaincode
 */

import { PaymentContract } from './payment.contract';

export { PaymentContract };
export const contracts: any[] = [PaymentContract];
