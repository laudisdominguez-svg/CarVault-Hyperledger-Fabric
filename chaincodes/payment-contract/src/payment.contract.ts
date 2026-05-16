

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import './fabric-types-extended';
/**
 * Payment: representa un pago registrado en el ledger.
 * La clave en el ledger es:  PAYMENT_{paymentId}
 */
interface Payment {
  docType: 'payment';
  paymentId: string;

  /**
   * clientId: el ID completo X.509 del cliente en la red Fabric.
   * Se obtiene con: ctx.clientIdentity.getID()
   * Ejemplo: "x509::/C=MX/O=ClientesVIP/CN=client-abc123::..."
   */
  clientId: string;

  amount: number;
  currency: string;                        // 'MXN' | 'USD'
  paymentType: 'SUBSCRIPTION' | 'SERVICE'; // membresía anual o servicio puntual
  status: 'PENDING' | 'CONFIRMED' | 'REFUNDED';

  /**
   * externalRef: referencia del pago fuera de la blockchain.
   * Puede ser el número de transferencia bancaria, un ID de Stripe, etc.
   */
  externalRef: string;

  /**
   * proofHash: SHA256 del comprobante que el cliente subió a la app.
   * La app lo calcula ANTES de llamar al chaincode.
   * Si alguien altera el comprobante, el hash ya no coincidirá.
   */
  proofHash: string;

  /**
   * serviceOrderId: si el pago es por un servicio de mantenimiento,
   * aquí va el ID de la orden (definida en maintenance-cc).
   * Si es suscripción, dejar como cadena vacía ''.
   */
  serviceOrderId: string;

  createdAt: string;    // ISO 8601
  confirmedAt: string;  // ISO 8601, vacío hasta que se confirme
  confirmedBy: string;  // ID del admin que confirmó
  refundedAt?: string;  // ISO 8601, vacío hasta que se reembolse
  refundedBy?: string;  // ID del admin que hizo el reembolso
  refundReason?: string; // motivo del reembolso
}

/**
 * Subscription: membresía activa de un cliente.
 * La clave en el ledger es:  SUBSCRIPTION_{clientId}
 * Solo existe un registro por cliente (se sobreescribe en cada renovación).
 */
interface Subscription {
  docType: 'subscription';
  subscriptionId: string;   // SUB_{clientId}_{año}_{mes}
  clientId: string;
  plan: 'SILVER' | 'GOLD' | 'PLATINUM';
  startDate: string;        // ISO 8601
  endDate: string;          // ISO 8601 (startDate + 365 días)
  status: 'ACTIVE' | 'EXPIRED' | 'SUSPENDED';
  paymentId: string;        // el pago que activó esta suscripción
  maxCars: number;          // límite de autos según el plan
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN DE PLANES
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_CONFIG: Record<string, { maxCars: number; durationDays: number }> = {
  SILVER:   { maxCars: 5,      durationDays: 365 },
  GOLD:     { maxCars: 15,     durationDays: 365 },
  PLATINUM: { maxCars: 99999,  durationDays: 365 }, // ilimitado en práctica
};

/**
 * MSP ID de la organización AutoVault.
 * Debe coincidir exactamente con el MSP configurado en configtx.yaml.
 */
const AUTOVAULT_MSP = 'AutoVaultMSP';

// ─────────────────────────────────────────────────────────────────────────────
// CONTRATO
// ─────────────────────────────────────────────────────────────────────────────

@Info({
  title: 'PaymentContract',
  description: 'Gestión de pagos y suscripciones VIP — AutoVault (Ruta B)',
})
export class PaymentContract extends Contract {

  // ───────────────────────────────────────────────────────────────────────────
  // INICIALIZAR LEDGER
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * InitLedger se llama una sola vez cuando el chaincode se instancia.
   * Aquí puedes pre-cargar datos de prueba durante el desarrollo.
   */
  @Transaction()
  public async InitLedger(ctx: Context): Promise<void> {
    console.info('=== PaymentContract inicializado correctamente ===');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REGISTRO DE PAGOS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * RegisterPayment — solo Admin (AutoVaultMSP)
   *
   * El admin llama a esta función después de recibir la notificación de pago.
   * El pago queda en estado PENDING hasta que se llame ConfirmPayment.
   *
   * @param paymentId   - ID único del pago (generado por la app, ej: PAY-2025-001)
   * @param clientId    - ID X.509 del cliente en la red Fabric
   * @param amount      - monto pagado como string (se convierte a float)
   * @param currency    - 'MXN' o 'USD'
   * @param paymentType - 'SUBSCRIPTION' o 'SERVICE'
   * @param externalRef - referencia bancaria o ID externo del pago
   * @param proofHash   - SHA256 del comprobante (calculado por la app)
   * @param serviceOrderId - ID de la orden de mantenimiento si aplica, '' si no
   */
  @Transaction()
  public async RegisterPayment(
    ctx: Context,
    paymentId: string,
    clientId: string,
    amount: string,
    currency: string,
    paymentType: string,
    externalRef: string,
    proofHash: string,
    serviceOrderId: string,
  ): Promise<string> {

    // Solo admins de AutoVault pueden registrar pagos
    this._assertAdmin(ctx);

    // Verificar que no exista ya este pago
    const alreadyExists = await this._paymentExists(ctx, paymentId);
    if (alreadyExists) {
      throw new Error(`Ya existe un pago con ID ${paymentId} en el ledger.`);
    }

    // Validar paymentId no vacío
    if (!paymentId || paymentId.trim() === '') {
      throw new Error('paymentId no puede estar vacío.');
    }

    // Validar clientId no vacío
    if (!clientId || clientId.trim() === '') {
      throw new Error('clientId no puede estar vacío.');
    }

    // Validar monto
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error('amount debe ser un número positivo.');
    }

    // Validar moneda
    const validCurrencies = ['MXN', 'USD'];
    if (!validCurrencies.includes(currency.toUpperCase())) {
      throw new Error(`currency inválida: ${currency}. Las opciones son: ${validCurrencies.join(', ')}.`);
    }

    // Validar el tipo de pago
    if (paymentType !== 'SUBSCRIPTION' && paymentType !== 'SERVICE') {
      throw new Error(`paymentType inválido: ${paymentType}. Usa 'SUBSCRIPTION' o 'SERVICE'.`);
    }

    // Validar proofHash (SHA256 = 64 caracteres hexadecimales)
    if (!this._isValidSHA256(proofHash)) {
      throw new Error('proofHash debe ser un SHA256 válido (64 caracteres hexadecimales).');
    }

    // Validar externalRef no vacío
    if (!externalRef || externalRef.trim() === '') {
      throw new Error('externalRef no puede estar vacío.');
    }

    const payment: Payment = {
      docType: 'payment',
      paymentId,
      clientId,
      amount: parsedAmount,
      currency: currency.toUpperCase(),
      paymentType: paymentType as 'SUBSCRIPTION' | 'SERVICE',
      status: 'PENDING',
      externalRef,
      proofHash,
      serviceOrderId,
      createdAt: new Date().toISOString(),
      confirmedAt: '',
      confirmedBy: '',
    };

    // Escribir en el ledger
    await ctx.stub.putState(
      `PAYMENT_${paymentId}`,
      Buffer.from(JSON.stringify(payment)),
    );

    // Emitir evento para que la app pueda escucharlo y notificar al cliente
    ctx.stub.setEvent(
      'PaymentRegistered',
      Buffer.from(JSON.stringify({
        paymentId,
        clientId,
        amount: payment.amount,
        currency: payment.currency,
        paymentType,
      })),
    );

    console.info(`Pago ${paymentId} registrado como PENDING para cliente ${clientId}`);
    return JSON.stringify(payment);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ConfirmPayment — solo Admin (AutoVaultMSP)
   *
   * Cambia el estado de PENDING a CONFIRMED y registra quién confirmó y cuándo.
   * Después de confirmar, la app puede llamar a ActivateSubscription si aplica.
   *
   * @param paymentId - ID del pago a confirmar
   */
  @Transaction()
  public async ConfirmPayment(
    ctx: Context,
    paymentId: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const payment = await this._getPayment(ctx, paymentId);

    // Idempotencia: si ya está confirmado, retorna la confirmación existente
    if (payment.status === 'CONFIRMED') {
      console.info(`Pago ${paymentId} ya estaba CONFIRMED. Retornando estado actual.`);
      return JSON.stringify(payment);
    }

    if (payment.status !== 'PENDING') {
      throw new Error(
        `No se puede confirmar: el pago ${paymentId} ya está en estado ${payment.status}.`,
      );
    }

    // ID del admin que ejecuta esta transacción (queda firmado en el bloque)
    const adminId = ctx.clientIdentity.getID();

    payment.status    = 'CONFIRMED';
    payment.confirmedAt = new Date().toISOString();
    payment.confirmedBy = adminId;

    await ctx.stub.putState(
      `PAYMENT_${paymentId}`,
      Buffer.from(JSON.stringify(payment)),
    );

    // Este evento es el que la app escucha para enviarle la confirmación al cliente
    ctx.stub.setEvent(
      'PaymentConfirmed',
      Buffer.from(JSON.stringify({
        paymentId,
        clientId:    payment.clientId,
        amount:      payment.amount,
        currency:    payment.currency,
        paymentType: payment.paymentType,
        txId:        ctx.stub.getTxID(),  // ID de la transacción en Fabric
        confirmedAt: payment.confirmedAt,
      })),
    );

    console.info(`Pago ${paymentId} confirmado por ${adminId}`);
    return JSON.stringify(payment);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUSCRIPCIONES
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ActivateSubscription — solo Admin (AutoVaultMSP)
   *
   * Activa o renueva la membresía anual de un cliente.
   * Solo se puede llamar si el pago asociado ya está CONFIRMED.
   * Si el cliente ya tiene una suscripción activa, la sobreescribe (renovación).
   *
   * @param clientId  - ID X.509 del cliente
   * @param plan      - 'SILVER' | 'GOLD' | 'PLATINUM'
   * @param paymentId - ID del pago CONFIRMED que financia esta suscripción
   */
  @Transaction()
  public async ActivateSubscription(
    ctx: Context,
    clientId: string,
    plan: string,
    paymentId: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    // Verificar que el pago existe y está confirmado
    const payment = await this._getPayment(ctx, paymentId);

    if (payment.status !== 'CONFIRMED') {
      throw new Error(
        `No se puede activar la suscripción: el pago ${paymentId} no está CONFIRMED.`,
      );
    }

    if (payment.paymentType !== 'SUBSCRIPTION') {
      throw new Error(
        `El pago ${paymentId} es de tipo ${payment.paymentType}, no SUBSCRIPTION.`,
      );
    }

    // Validar el plan
    const config = PLAN_CONFIG[plan.toUpperCase()];
    if (!config) {
      throw new Error(
        `Plan inválido: ${plan}. Las opciones son: SILVER, GOLD, PLATINUM.`,
      );
    }

    const startDate = new Date();
    const endDate   = new Date();
    endDate.setDate(endDate.getDate() + config.durationDays);

    // Mes con cero a la izquierda para el ID
    const monthPadded = String(startDate.getMonth() + 1).padStart(2, '0');
    const subscriptionId = `SUB_${clientId}_${startDate.getFullYear()}_${monthPadded}`;

    const subscription: Subscription = {
      docType:        'subscription',
      subscriptionId,
      clientId,
      plan:           plan.toUpperCase() as 'SILVER' | 'GOLD' | 'PLATINUM',
      startDate:      startDate.toISOString(),
      endDate:        endDate.toISOString(),
      status:         'ACTIVE',
      paymentId,
      maxCars:        config.maxCars,
    };

    // Se usa SUBSCRIPTION_{clientId} → un solo registro por cliente (renovable)
    await ctx.stub.putState(
      `SUBSCRIPTION_${clientId}`,
      Buffer.from(JSON.stringify(subscription)),
    );

    ctx.stub.setEvent(
      'SubscriptionActivated',
      Buffer.from(JSON.stringify({
        clientId,
        plan:           subscription.plan,
        subscriptionId,
        endDate:        endDate.toISOString(),
        maxCars:        config.maxCars,
      })),
    );

    console.info(`Suscripción ${plan} activada para cliente ${clientId} hasta ${endDate.toISOString()}`);
    return JSON.stringify(subscription);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // QUERIES (solo lectura, @Transaction(false))
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GetSubscriptionStatus — Admin o el propio cliente
   *
   * Retorna la suscripción vigente del cliente.
   * Si la fecha de vencimiento ya pasó, retorna status: 'EXPIRED'.
   *
   * Nota: este cambio a EXPIRED es solo en la respuesta, NO escribe en el ledger.
   * Para marcarla como expirada en el ledger, el admin debe llamar a
   * SuspendSubscription() o un job periódico externo.
   */
  @Transaction(false)
  @Returns('string')
  public async GetSubscriptionStatus(
    ctx: Context,
    clientId: string,
  ): Promise<string> {

    this._assertOwnerOrAdmin(ctx, clientId);

    const subBytes = await ctx.stub.getState(`SUBSCRIPTION_${clientId}`);
    if (!subBytes || subBytes.length === 0) {
      throw new Error(`No existe suscripción registrada para el cliente ${clientId}.`);
    }

    const subscription: Subscription = JSON.parse(subBytes.toString());

    // Calcular si venció (solo para la respuesta, no escribe en ledger)
    if (subscription.status === 'ACTIVE' && new Date() > new Date(subscription.endDate)) {
      subscription.status = 'EXPIRED';
    }

    return JSON.stringify(subscription);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GetPayment — Admin o el propio cliente dueño del pago
   *
   * @param paymentId - ID del pago a consultar
  
  @Transaction(false)
  @Returns('string')
  public async GetPayment(
    ctx: Context,
    paymentId: string,
  ): Promise<string> {

    const payment = await this._getPayment(ctx, paymentId);
    this._assertOwnerOrAdmin(ctx, payment.clientId);
    return JSON.stringify(payment);
  }

  @Transaction(false)
  @Returns('string')
  public async GetClientPaymentHistory(
    ctx: Context,
    clientId: string,
  ): Promise<string> {

    this._assertOwnerOrAdmin(ctx, clientId);

    // Rich query de CouchDB — solo disponible cuando state DB es CouchDB
    const queryString = JSON.stringify({
      selector: {
        docType:  'payment',
        clientId: clientId,
      },
      sort: [{ createdAt: 'desc' }],
    });

    const iterator = await ctx.stub.getQueryResult(queryString);
    const results: Payment[] = [];

    for await (const result of iterator) {
      results.push(JSON.parse(result.value.toString()));
    }

    return JSON.stringify(results);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REEMBOLSO
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * RefundPayment — solo Admin (AutoVaultMSP)
   *
   * Marca un pago como REFUNDED. El reembolso real de dinero ocurre fuera
   * de la blockchain; este chaincode solo deja el registro inmutable del evento.
   *
   * @param paymentId - ID del pago a reembolsar
   * @param reason    - motivo del reembolso (queda en el ledger)
   */
  @Transaction()
  public async RefundPayment(
    ctx: Context,
    paymentId: string,
    reason: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const payment = await this._getPayment(ctx, paymentId);

    if (payment.status === 'REFUNDED') {
      throw new Error(`El pago ${paymentId} ya fue reembolsado previamente.`);
    }

    // Validar que reason no esté vacío
    if (!reason || reason.trim() === '') {
      throw new Error('reason no puede estar vacío.');
    }

    const adminId = ctx.clientIdentity.getID();

    payment.status = 'REFUNDED';
    payment.refundedAt = new Date().toISOString();
    payment.refundedBy = adminId;
    payment.refundReason = reason;

    await ctx.stub.putState(
      `PAYMENT_${paymentId}`,
      Buffer.from(JSON.stringify(payment)),
    );

    // Refund inteligente: si el pago era de suscripción, suspender automáticamente
    if (payment.paymentType === 'SUBSCRIPTION') {
      const subBytes = await ctx.stub.getState(`SUBSCRIPTION_${payment.clientId}`);
      if (subBytes && subBytes.length > 0) {
        const subscription: Subscription = JSON.parse(subBytes.toString());

        // Solo suspender si está ACTIVE
        if (subscription.status === 'ACTIVE') {
          subscription.status = 'SUSPENDED';
          await ctx.stub.putState(
            `SUBSCRIPTION_${payment.clientId}`,
            Buffer.from(JSON.stringify(subscription)),
          );
          console.info(
            `Suscripción de ${payment.clientId} suspendida automáticamente por reembolso de ${paymentId}`,
          );
        }
      }
    }

    ctx.stub.setEvent(
      'PaymentRefunded',
      Buffer.from(JSON.stringify({
        paymentId,
        clientId: payment.clientId,
        amount:   payment.amount,
        currency: payment.currency,
        reason,
        refundedBy: adminId,
        subscriptionSuspended: payment.paymentType === 'SUBSCRIPTION',
      })),
    );

    console.info(
      `Pago ${paymentId} marcado como REFUNDED por ${adminId}. Motivo: ${reason}`,
    );
    return JSON.stringify(payment);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUSPENDER SUSCRIPCIÓN (para el admin o un proceso automático)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * SuspendSubscription — solo Admin
   *
   * Suspende manualmente una suscripción (por impago, violación de contrato, etc.).
   * Para reactivarla, el cliente debe pagar y el admin llama a ActivateSubscription.
   */
  @Transaction()
  public async SuspendSubscription(
    ctx: Context,
    clientId: string,
    reason: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const subBytes = await ctx.stub.getState(`SUBSCRIPTION_${clientId}`);
    if (!subBytes || subBytes.length === 0) {
      throw new Error(`No existe suscripción para el cliente ${clientId}.`);
    }

    const subscription: Subscription = JSON.parse(subBytes.toString());
    subscription.status = 'SUSPENDED';

    await ctx.stub.putState(
      `SUBSCRIPTION_${clientId}`,
      Buffer.from(JSON.stringify(subscription)),
    );

    ctx.stub.setEvent(
      'SubscriptionSuspended',
      Buffer.from(JSON.stringify({ clientId, reason })),
    );

    return JSON.stringify(subscription);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MÉTODOS PRIVADOS DE APOYO
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Verifica que el invocador sea de la organización AutoVault (admin/asesor).
   * Lanza error si no.
   */
  private _assertAdmin(ctx: Context): void {
    const mspId = ctx.clientIdentity.getMSPID();
    if (mspId !== AUTOVAULT_MSP) {
      throw new Error(
        `Acceso denegado. Esta función es solo para ${AUTOVAULT_MSP}. Tu MSP: ${mspId}.`,
      );
    }
  }

  /**
   * Verifica que el invocador sea admin O sea el dueño del recurso.
   * Los admins pueden ver cualquier registro.
   * Los clientes solo pueden ver los suyos.
   *
   * Nota: en Fabric, ctx.clientIdentity.getID() retorna el subject completo
   * del certificado X.509. El clientId almacenado en el ledger debe ser
   * este mismo string para que la comparación funcione.
   */
  private _assertOwnerOrAdmin(ctx: Context, resourceClientId: string): void {
    const mspId = ctx.clientIdentity.getMSPID();
    if (mspId === AUTOVAULT_MSP) return; // admins siempre tienen acceso

    const callerId = ctx.clientIdentity.getID();
    if (callerId !== resourceClientId) {
      throw new Error(
        'Acceso denegado: solo puedes consultar tus propios pagos y suscripciones.',
      );
    }
  }

  /**
   * Lee un Payment del ledger por paymentId. Lanza error si no existe.
   */
  private async _getPayment(ctx: Context, paymentId: string): Promise<Payment> {
    const paymentBytes = await ctx.stub.getState(`PAYMENT_${paymentId}`);
    if (!paymentBytes || paymentBytes.length === 0) {
      throw new Error(`El pago ${paymentId} no existe en el ledger.`);
    }
    return JSON.parse(paymentBytes.toString()) as Payment;
  }

  /**
   * Verifica si un paymentId ya existe en el ledger.
   */
  private async _paymentExists(ctx: Context, paymentId: string): Promise<boolean> {
    const paymentBytes = await ctx.stub.getState(`PAYMENT_${paymentId}`);
    return paymentBytes !== null && paymentBytes.length > 0;
  }

  /**
   * Valida que proofHash sea un SHA256 válido (64 caracteres hexadecimales).
   */
  private _isValidSHA256(hash: string): boolean {
    return /^[a-fA-F0-9]{64}$/.test(hash);
  }
}
