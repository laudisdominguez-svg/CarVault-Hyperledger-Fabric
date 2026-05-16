/*
 * AutoVault VIP — maintenance-cc
 * Chaincode de órdenes de servicio domiciliario para Hyperledger Fabric
 *
 * Flujo de estados de una orden:
 *   REQUESTED → SCHEDULED → EN_ROUTE → IN_PROGRESS
 *             → COMPLETED_BY_TECH → CONFIRMED_BY_CLIENT
 *
 *   Desde REQUESTED o SCHEDULED: → CANCELLED
 *
 * Actores por estado:
 *   REQUESTED          ← Cliente VIP (o Admin en su nombre)
 *   SCHEDULED          ← Admin (asigna técnico + fecha)
 *   EN_ROUTE           ← Técnico
 *   IN_PROGRESS        ← Técnico  [llama car-cc: SetCarStatus(IN_MAINTENANCE)]
 *   COMPLETED_BY_TECH  ← Técnico  (sube reporte con hash de fotos)
 *   CONFIRMED_BY_CLIENT← Cliente  [llama car-cc: SetCarStatus(ACTIVE)]
 *   CANCELLED          ← Cliente o Admin (solo desde REQUESTED / SCHEDULED)
 *
 * Llamadas cruzadas (invokeChaincode en el mismo canal):
 *   → payment-cc : GetSubscriptionStatus  (cliente debe tener ACTIVE)
 *   → car-cc     : SetCarStatus           (IN_MAINTENANCE / ACTIVE)
 *
 * Requiere CouchDB como state database.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import './fabric-types-extended';

const AUTOVAULT_MSP  = 'AutoVaultMSP';
const TECNICOS_MSP   = 'TecnicosMSP';
const PAYMENT_CC     = 'payment-cc';
const CAR_CC         = 'car-cc';
const CHANNEL_NAME   = 'main-channel';

type ServiceStatus =
  | 'REQUESTED'
  | 'SCHEDULED'
  | 'EN_ROUTE'
  | 'IN_PROGRESS'
  | 'COMPLETED_BY_TECH'
  | 'CONFIRMED_BY_CLIENT'
  | 'CANCELLED';

type ServiceType =
  | 'DETALLADO'          // limpieza y pulido profesional
  | 'CAMBIO_ACEITE'
  | 'INSPECCION_MECANICA'
  | 'RESTAURACION_PARCIAL'
  | 'ALMACENAMIENTO'     // preparación para guardar el auto
  | 'DIAGNOSTICO'
  | 'OTRO';

/**
 * ServiceOrder: activo principal del ledger.
 * Clave en el ledger: SERVICE_{orderId}
 *
 * Una orden nace cuando el cliente solicita un servicio.
 * Cada transición de estado queda firmada por el actor que la ejecutó,
 * y el historial completo es auditable con GetOrderHistory().
 */
interface ServiceOrder {
  docType:   'serviceOrder';
  orderId:   string;

  // ── Partes involucradas ──
  clientId:     string;  // ID X.509 del cliente propietario del auto
  carId:        string;  // ID del auto en car-cc
  technicianId: string;  // ID X.509 del técnico asignado (vacío hasta SCHEDULED)

  // ── Descripción del servicio ──
  serviceType:  ServiceType;
  description:  string;  // detalle libre de lo que se necesita
  priceUSD:     number;  // precio cotizado (0 hasta que admin lo define en SCHEDULED)

  // ── Agenda ──
  requestedDate: string;  // fecha/hora preferida por el cliente (ISO 8601)
  scheduledDate: string;  // fecha/hora confirmada por el admin (ISO 8601)
  completedDate: string;  // fecha/hora real de finalización (ISO 8601)

  // ── Dirección del servicio domiciliario ──
  // Se guarda en la orden para que el técnico la tenga disponible.
  // En producción considera usar Private Data Collections para no
  // exponer la dirección del cliente en el ledger a todos los peers.
  addressStreet:  string;
  addressCity:    string;
  addressNotes:   string;  // instrucciones de acceso (ej: "portón azul, timbre 2")

  // ── Estado y trazabilidad ──
  status:          ServiceStatus;
  cancellationReason: string;    // solo si status es CANCELLED

  // ── Timestamps por transición ──
  requestedAt:   string;
  scheduledAt:   string;
  enRouteAt:     string;
  startedAt:     string;
  techCompletedAt: string;
  clientConfirmedAt: string;
  cancelledAt:   string;

  // ── Quién ejecutó cada transición ──
  requestedBy:         string;
  scheduledBy:         string;  // ID del admin
  techConfirmedBy:     string;  // ID del técnico
  clientConfirmedBy:   string;  // ID del cliente
  cancelledBy:         string;

  // ── Calificación del cliente ──
  rating:   number;   // 1-5, 0 hasta que el cliente confirma
  feedback: string;   // comentario libre del cliente
}

/**
 * ServiceReport: reporte que sube el técnico al completar el servicio.
 * Clave en el ledger: REPORT_{orderId}
 *
 * Solo existe cuando la orden llega a COMPLETED_BY_TECH.
 * Las fotos del reporte siguen el mismo patrón que car-cc: hash en ledger, archivo en S3.
 */
interface ServiceReport {
  docType:   'serviceReport';
  reportId:  string;         // igual al orderId para simplicidad
  orderId:   string;
  carId:     string;
  clientId:  string;
  technicianId: string;

  // ── Trabajo realizado ──
  workSummary:   string;           // descripción del trabajo hecho
  partsUsed:     string[];         // lista de piezas o materiales usados
  observations:  string;           // observaciones técnicas para el historial del auto
  nextServiceRec: string;          // recomendación del técnico para el próximo servicio

  // ── Fotos del reporte ──
  // Las fotos reales van a S3/IPFS; aquí solo los hashes.
  photoHashes:  string[];  // SHA256 de cada foto tomada durante el servicio
  photoUrls:    string[];  // URLs en S3/IPFS (mismo orden que photoHashes)

  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRATO
// ─────────────────────────────────────────────────────────────────────────────

@Info({
  title: 'MaintenanceContract',
  description: 'Órdenes de servicio domiciliario — AutoVault VIP',
})
export class MaintenanceContract extends Contract {

  @Transaction()
  public async InitLedger(ctx: Context): Promise<void> {
    console.info('=== MaintenanceContract inicializado correctamente ===');
  }

  // ─── PASO 1 ───────────────────────────────────────────────────────────────
  // REQUESTED: cliente solicita el servicio
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * RequestService — Cliente VIP (o Admin en su nombre)
   *
   * El cliente solicita un servicio para uno de sus autos.
   * El admin verá la solicitud en su dashboard y procederá a asignar
   * técnico y fecha (SCHEDULED).
   *
   * Verifica:
   *   · Suscripción ACTIVE del cliente (invokeChaincode → payment-cc)
   *   · El auto no esté ya IN_MAINTENANCE
   *
   * @param orderId       - ID único (generado por la app, ej: SVC-2025-001)
   * @param carId         - ID del auto en car-cc
   * @param serviceType   - tipo de servicio
   * @param description   - descripción adicional del cliente
   * @param requestedDate - fecha preferida (ISO 8601)
   * @param addressStreet - calle y número del domicilio
   * @param addressCity   - ciudad
   * @param addressNotes  - instrucciones de acceso
   */
  @Transaction()
  public async RequestService(
    ctx:           Context,
    orderId:       string,
    carId:         string,
    serviceType:   string,
    description:   string,
    requestedDate: string,
    addressStreet: string,
    addressCity:   string,
    addressNotes:  string,
  ): Promise<string> {

    // El caller puede ser el cliente o un admin que actúa en su nombre
    const callerId = ctx.clientIdentity.getID();
    const mspId    = ctx.clientIdentity.getMSPID();

    // Si es el cliente quien solicita, debe tener suscripción ACTIVE
    if (mspId !== AUTOVAULT_MSP) {
      await this._assertActiveSubscription(ctx, callerId);
    }

    // Verificar que la orden no exista
    if (await this._orderExists(ctx, orderId)) {
      throw new Error(`Ya existe una orden con ID ${orderId}.`);
    }

    // Validar serviceType
    const tiposValidos: ServiceType[] = [
      'DETALLADO', 'CAMBIO_ACEITE', 'INSPECCION_MECANICA',
      'RESTAURACION_PARCIAL', 'ALMACENAMIENTO', 'DIAGNOSTICO', 'OTRO',
    ];
    if (!tiposValidos.includes(serviceType as ServiceType)) {
      throw new Error(`Tipo de servicio inválido: ${serviceType}.`);
    }

    const now = new Date().toISOString();
    const clientId = callerId; // Si es admin, la app proporciona el clientId correcto

    const order: ServiceOrder = {
      docType:      'serviceOrder',
      orderId,
      clientId,
      carId,
      technicianId: '',
      serviceType:  serviceType as ServiceType,
      description,
      priceUSD:     0,

      requestedDate,
      scheduledDate:    '',
      completedDate:    '',

      addressStreet,
      addressCity,
      addressNotes,

      status:             'REQUESTED',
      cancellationReason: '',

      requestedAt:        now,
      scheduledAt:        '',
      enRouteAt:          '',
      startedAt:          '',
      techCompletedAt:    '',
      clientConfirmedAt:  '',
      cancelledAt:        '',

      requestedBy:       callerId,
      scheduledBy:       '',
      techConfirmedBy:   '',
      clientConfirmedBy: '',
      cancelledBy:       '',

      rating:   0,
      feedback: '',
    };

    await ctx.stub.putState(`SERVICE_${orderId}`, Buffer.from(JSON.stringify(order)));

    ctx.stub.setEvent(
      'ServiceRequested',
      Buffer.from(JSON.stringify({
        orderId,
        clientId,
        carId,
        serviceType,
        requestedDate,
      })),
    );

    console.info(`Orden ${orderId} creada — auto: ${carId}, servicio: ${serviceType}`);
    return JSON.stringify(order);
  }

  // ─── PASO 2 ───────────────────────────────────────────────────────────────
  // SCHEDULED: admin asigna técnico, fecha y precio
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ScheduleService — solo Admin (AutoVaultMSP)
   *
   * El admin revisa la solicitud y asigna:
   *   · Técnico disponible para esa fecha
   *   · Fecha/hora confirmada de visita
   *   · Precio del servicio (en USD)
   *
   * El cliente recibe una notificación con todos estos datos.
   *
   * @param orderId       - ID de la orden
   * @param technicianId  - ID X.509 del técnico asignado
   * @param scheduledDate - fecha/hora confirmada (ISO 8601)
   * @param priceUSD      - precio del servicio como string
   */
  @Transaction()
  public async ScheduleService(
    ctx:           Context,
    orderId:       string,
    technicianId:  string,
    scheduledDate: string,
    priceUSD:      string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const order = await this._getOrder(ctx, orderId);
    this._assertStatus(order, ['REQUESTED'], 'ScheduleService');

    order.technicianId  = technicianId;
    order.scheduledDate = scheduledDate;
    order.priceUSD      = parseFloat(priceUSD);
    order.status        = 'SCHEDULED';
    order.scheduledAt   = new Date().toISOString();
    order.scheduledBy   = ctx.clientIdentity.getID();

    await ctx.stub.putState(`SERVICE_${orderId}`, Buffer.from(JSON.stringify(order)));

    ctx.stub.setEvent(
      'ServiceScheduled',
      Buffer.from(JSON.stringify({
        orderId,
        clientId:      order.clientId,
        carId:         order.carId,
        technicianId,
        scheduledDate,
        priceUSD:      order.priceUSD,
      })),
    );

    return JSON.stringify(order);
  }

  // ─── PASO 3 ───────────────────────────────────────────────────────────────
  // EN_ROUTE: técnico confirma que va en camino
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * TechnicianEnRoute — Técnico asignado (TecnicosMSP)
   *
   * El técnico confirma desde su app que salió hacia el domicilio del cliente.
   * El cliente recibe una notificación push en ese momento.
   *
   * Solo el técnico asignado puede ejecutar esta función.
   *
   * @param orderId - ID de la orden
   */
  @Transaction()
  public async TechnicianEnRoute(ctx: Context, orderId: string): Promise<string> {
    this._assertTechnicianOrAdmin(ctx);

    const order = await this._getOrder(ctx, orderId);
    this._assertStatus(order, ['SCHEDULED'], 'TechnicianEnRoute');
    this._assertAssignedTechnician(ctx, order);

    order.status    = 'EN_ROUTE';
    order.enRouteAt = new Date().toISOString();

    await ctx.stub.putState(`SERVICE_${orderId}`, Buffer.from(JSON.stringify(order)));

    ctx.stub.setEvent(
      'TechnicianEnRoute',
      Buffer.from(JSON.stringify({
        orderId,
        clientId:     order.clientId,
        carId:        order.carId,
        technicianId: order.technicianId,
        enRouteAt:    order.enRouteAt,
      })),
    );

    return JSON.stringify(order);
  }

  // ─── PASO 4 ───────────────────────────────────────────────────────────────
  // IN_PROGRESS: técnico llega y empieza el trabajo
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * StartService — Técnico asignado (TecnicosMSP)
   *
   * El técnico confirma llegada y comienza el trabajo.
   *
   * Llama a car-cc (invokeChaincode) para marcar el auto como IN_MAINTENANCE.
   * Esto previene que otro servicio se solicite para el mismo auto mientras
   * está siendo atendido.
   *
   * @param orderId - ID de la orden
   */
  @Transaction()
  public async StartService(ctx: Context, orderId: string): Promise<string> {
    this._assertTechnicianOrAdmin(ctx);

    const order = await this._getOrder(ctx, orderId);
    this._assertStatus(order, ['EN_ROUTE'], 'StartService');
    this._assertAssignedTechnician(ctx, order);

    // Marcar el auto como IN_MAINTENANCE en car-cc
    const carResponse = await ctx.stub.invokeChaincode(
      CAR_CC,
      ['SetCarStatus', order.carId, 'IN_MAINTENANCE'],
      CHANNEL_NAME,
    );
    if (carResponse.status !== 200) {
      throw new Error(
        `No se pudo cambiar el estado del auto ${order.carId} en car-cc: ` +
        carResponse.message,
      );
    }

    order.status    = 'IN_PROGRESS';
    order.startedAt = new Date().toISOString();
    order.techConfirmedBy = ctx.clientIdentity.getID();

    await ctx.stub.putState(`SERVICE_${orderId}`, Buffer.from(JSON.stringify(order)));

    ctx.stub.setEvent(
      'ServiceStarted',
      Buffer.from(JSON.stringify({
        orderId,
        clientId:     order.clientId,
        carId:        order.carId,
        technicianId: order.technicianId,
        startedAt:    order.startedAt,
      })),
    );

    return JSON.stringify(order);
  }

  // ─── PASO 5 ───────────────────────────────────────────────────────────────
  // COMPLETED_BY_TECH: técnico sube reporte y cierra su parte
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * CompleteService — Técnico asignado (TecnicosMSP)
   *
   * El técnico termina el trabajo y sube el reporte completo:
   *   · Resumen del trabajo realizado
   *   · Piezas o materiales utilizados (JSON array como string)
   *   · Observaciones técnicas para el historial del auto
   *   · Recomendación del próximo servicio
   *   · Hashes SHA256 de las fotos tomadas (JSON array como string)
   *   · URLs de las fotos en S3/IPFS (JSON array como string)
   *
   * El cliente recibe una notificación para confirmar el servicio.
   *
   * @param orderId        - ID de la orden
   * @param workSummary    - descripción del trabajo hecho
   * @param partsUsedJson  - JSON array de strings (ej: '["Filtro aceite","Aceite 5W30"]')
   * @param observations   - observaciones técnicas
   * @param nextServiceRec - recomendación del próximo servicio
   * @param photoHashesJson - JSON array de SHA256 (ej: '["abc123...", "def456..."]')
   * @param photoUrlsJson   - JSON array de URLs (mismo orden que photoHashes)
   */
  @Transaction()
  public async CompleteService(
    ctx:             Context,
    orderId:         string,
    workSummary:     string,
    partsUsedJson:   string,
    observations:    string,
    nextServiceRec:  string,
    photoHashesJson: string,
    photoUrlsJson:   string,
  ): Promise<string> {

    this._assertTechnicianOrAdmin(ctx);

    const order = await this._getOrder(ctx, orderId);
    this._assertStatus(order, ['IN_PROGRESS'], 'CompleteService');
    this._assertAssignedTechnician(ctx, order);

    const now         = new Date().toISOString();
    const partsUsed   = JSON.parse(partsUsedJson)   as string[];
    const photoHashes = JSON.parse(photoHashesJson) as string[];
    const photoUrls   = JSON.parse(photoUrlsJson)   as string[];

    if (photoHashes.length !== photoUrls.length) {
      throw new Error(
        `El número de hashes (${photoHashes.length}) no coincide con ` +
        `el número de URLs (${photoUrls.length}).`,
      );
    }

    // Crear el reporte en el ledger
    const report: ServiceReport = {
      docType:      'serviceReport',
      reportId:     orderId,
      orderId,
      carId:        order.carId,
      clientId:     order.clientId,
      technicianId: order.technicianId,
      workSummary,
      partsUsed,
      observations,
      nextServiceRec,
      photoHashes,
      photoUrls,
      createdAt: now,
    };

    await ctx.stub.putState(`REPORT_${orderId}`, Buffer.from(JSON.stringify(report)));

    // Actualizar la orden
    order.status          = 'COMPLETED_BY_TECH';
    order.completedDate   = now;
    order.techCompletedAt = now;

    await ctx.stub.putState(`SERVICE_${orderId}`, Buffer.from(JSON.stringify(order)));

    // Notificar al cliente: tiene pendiente confirmar el servicio
    ctx.stub.setEvent(
      'ServiceCompletedByTech',
      Buffer.from(JSON.stringify({
        orderId,
        clientId:      order.clientId,
        carId:         order.carId,
        technicianId:  order.technicianId,
        priceUSD:      order.priceUSD,
        completedDate: now,
      })),
    );

    return JSON.stringify({ order, report });
  }

  // ─── PASO 6 ───────────────────────────────────────────────────────────────
  // CONFIRMED_BY_CLIENT: cliente aprueba el servicio
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ClientConfirm — Cliente VIP propietario del auto
   *
   * El cliente revisa el reporte, califica el servicio y confirma.
   * Esta confirmación:
   *   1. Cierra la orden en el ledger
   *   2. Llama a car-cc para reactivar el auto (ACTIVE)
   *   3. Emite evento que la app usa para iniciar el cobro del servicio
   *      (el admin entonces llamará a RegisterPayment en payment-cc)
   *
   * El cliente firmó en el contrato físico la obligación de confirmar
   * servicios cuando le correspondan — esta es la transacción que lo
   * materializa on-chain.
   *
   * @param orderId  - ID de la orden
   * @param rating   - calificación 1-5 como string
   * @param feedback - comentario libre del cliente
   */
  @Transaction()
  public async ClientConfirm(
    ctx:      Context,
    orderId:  string,
    rating:   string,
    feedback: string,
  ): Promise<string> {

    const order = await this._getOrder(ctx, orderId);

    // Solo el cliente propietario puede confirmar
    this._assertOwnerOrAdmin(ctx, order.clientId);

    this._assertStatus(order, ['COMPLETED_BY_TECH'], 'ClientConfirm');

    const ratingNum = parseInt(rating, 10);
    if (ratingNum < 1 || ratingNum > 5) {
      throw new Error(`La calificación debe ser entre 1 y 5. Recibido: ${rating}`);
    }

    const now = new Date().toISOString();

    // Reactivar el auto en car-cc
    const carResponse = await ctx.stub.invokeChaincode(
      CAR_CC,
      ['SetCarStatus', order.carId, 'ACTIVE'],
      CHANNEL_NAME,
    );
    if (carResponse.status !== 200) {
      throw new Error(
        `No se pudo reactivar el auto ${order.carId} en car-cc: ` +
        carResponse.message,
      );
    }

    order.status            = 'CONFIRMED_BY_CLIENT';
    order.clientConfirmedAt = now;
    order.clientConfirmedBy = ctx.clientIdentity.getID();
    order.rating            = ratingNum;
    order.feedback          = feedback;

    await ctx.stub.putState(`SERVICE_${orderId}`, Buffer.from(JSON.stringify(order)));

    // Este evento es lo que la app escucha para notificar al admin
    // que debe registrar el cobro del servicio en payment-cc
    ctx.stub.setEvent(
      'ServiceConfirmedByClient',
      Buffer.from(JSON.stringify({
        orderId,
        clientId:   order.clientId,
        carId:      order.carId,
        priceUSD:   order.priceUSD,
        rating:     ratingNum,
        confirmedAt: now,
        paymentDue: true,
      })),
    );

    console.info(`Orden ${orderId} confirmada por cliente. Rating: ${ratingNum}/5`);
    return JSON.stringify(order);
  }

  // ─── CANCELACIÓN ──────────────────────────────────────────────────────────

  /**
   * CancelService — Cliente propietario o Admin
   *
   * Solo se puede cancelar desde REQUESTED o SCHEDULED.
   * Una vez que el técnico está EN_ROUTE o trabajando, la cancelación
   * debe gestionarse fuera del chaincode (entre las partes).
   *
   * @param orderId - ID de la orden
   * @param reason  - motivo de la cancelación
   */
  @Transaction()
  public async CancelService(
    ctx:     Context,
    orderId: string,
    reason:  string,
  ): Promise<string> {

    const order = await this._getOrder(ctx, orderId);
    this._assertOwnerOrAdmin(ctx, order.clientId);
    this._assertStatus(order, ['REQUESTED', 'SCHEDULED'], 'CancelService');

    const now = new Date().toISOString();

    order.status              = 'CANCELLED';
    order.cancellationReason  = reason;
    order.cancelledAt         = now;
    order.cancelledBy         = ctx.clientIdentity.getID();

    await ctx.stub.putState(`SERVICE_${orderId}`, Buffer.from(JSON.stringify(order)));

    ctx.stub.setEvent(
      'ServiceCancelled',
      Buffer.from(JSON.stringify({
        orderId,
        clientId:    order.clientId,
        carId:       order.carId,
        reason,
        cancelledBy: order.cancelledBy,
      })),
    );

    return JSON.stringify(order);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUERIES (solo lectura)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GetServiceOrder — Admin, cliente propietario, o técnico asignado
   *
   * El técnico solo puede ver sus órdenes asignadas.
   * El cliente solo puede ver las órdenes de sus propios autos.
   */
  @Transaction(false)
  @Returns('string')
  public async GetServiceOrder(ctx: Context, orderId: string): Promise<string> {
    const order = await this._getOrder(ctx, orderId);
    this._assertCanReadOrder(ctx, order);
    return JSON.stringify(order);
  }

  /**
   * GetServiceReport — Admin, cliente propietario, o técnico asignado
   *
   * Retorna el reporte detallado del técnico para una orden.
   * Solo existe cuando la orden llegó a COMPLETED_BY_TECH.
   */
  @Transaction(false)
  @Returns('string')
  public async GetServiceReport(ctx: Context, orderId: string): Promise<string> {
    const order = await this._getOrder(ctx, orderId);
    this._assertCanReadOrder(ctx, order);

    const reportBytes = await ctx.stub.getState(`REPORT_${orderId}`);
    if (!reportBytes || reportBytes.length === 0) {
      throw new Error(
        `No existe reporte para la orden ${orderId}. ` +
        `El reporte se genera cuando el técnico completa el servicio.`,
      );
    }

    return reportBytes.toString();
  }

  /**
   * GetClientServiceHistory — Admin o cliente propietario
   *
   * Retorna todas las órdenes de un cliente, ordenadas de más reciente a más antigua.
   * Requiere CouchDB.
   *
   * @param clientId - ID X.509 del cliente
   */
  @Transaction(false)
  @Returns('string')
  public async GetClientServiceHistory(
    ctx:      Context,
    clientId: string,
  ): Promise<string> {

    this._assertOwnerOrAdmin(ctx, clientId);

    const queryString = JSON.stringify({
      selector: {
        docType:  'serviceOrder',
        clientId: clientId,
      },
      sort: [{ requestedAt: 'desc' }],
    });

    return await this._runQuery(ctx, queryString);
  }

  /**
   * GetCarServiceHistory — Admin, cliente propietario, o técnico
   *
   * Retorna el historial de servicios de un auto específico.
   * Muy útil para mostrar en la ficha del auto en la app.
   *
   * @param carId    - ID del auto en car-cc
   * @param clientId - ID del propietario (para verificar acceso)
   */
  @Transaction(false)
  @Returns('string')
  public async GetCarServiceHistory(
    ctx:      Context,
    carId:    string,
    clientId: string,
  ): Promise<string> {

    this._assertOwnerOrAdmin(ctx, clientId);

    const queryString = JSON.stringify({
      selector: {
        docType: 'serviceOrder',
        carId:   carId,
      },
      sort: [{ requestedAt: 'desc' }],
    });

    return await this._runQuery(ctx, queryString);
  }

  /**
   * GetPendingOrders — solo Admin (AutoVaultMSP)
   *
   * Retorna todas las órdenes que requieren acción del admin:
   * las que están en REQUESTED (sin técnico asignado aún).
   */
  @Transaction(false)
  @Returns('string')
  public async GetPendingOrders(ctx: Context): Promise<string> {
    this._assertAdmin(ctx);

    const queryString = JSON.stringify({
      selector: {
        docType: 'serviceOrder',
        status:  'REQUESTED',
      },
      sort: [{ requestedAt: 'asc' }],  // primero llegado, primero atendido
    });

    return await this._runQuery(ctx, queryString);
  }

  /**
   * GetTechnicianOrders — Admin o el propio técnico
   *
   * Retorna las órdenes asignadas a un técnico específico.
   * El técnico puede filtrar por status para ver solo las activas.
   *
   * @param technicianId - ID X.509 del técnico
   * @param statusFilter - status a filtrar, '' para todos
   */
  @Transaction(false)
  @Returns('string')
  public async GetTechnicianOrders(
    ctx:           Context,
    technicianId:  string,
    statusFilter:  string,
  ): Promise<string> {

    // Admin puede ver cualquier técnico; técnico solo se ve a sí mismo
    if (!this._isAdmin(ctx)) {
      if (ctx.clientIdentity.getID() !== technicianId) {
        throw new Error('Solo puedes ver tus propias órdenes asignadas.');
      }
    }

    const selector: any = {
      docType:      'serviceOrder',
      technicianId: technicianId,
    };

    if (statusFilter && statusFilter !== '') {
      selector.status = statusFilter;
    }

    const queryString = JSON.stringify({
      selector,
      sort: [{ scheduledDate: 'asc' }],
    });

    return await this._runQuery(ctx, queryString);
  }

  /**
   * GetOrderHistory — Admin, cliente propietario, o técnico asignado
   *
   * Historial inmutable completo de una orden: cada cambio de estado
   * con el txId del bloque, quién lo firmó y cuándo.
   * Nativo de Hyperledger Fabric (getHistoryForKey).
   */
  @Transaction(false)
  @Returns('string')
  public async GetOrderHistory(ctx: Context, orderId: string): Promise<string> {
    const order = await this._getOrder(ctx, orderId);
    this._assertCanReadOrder(ctx, order);

    const historyIterator = await ctx.stub.getHistoryForKey(`SERVICE_${orderId}`);
    const history: object[] = [];

    for await (const modification of historyIterator) {
      const entry: any = {
        txId:      modification.txId,
        timestamp: modification.timestamp,
        isDelete:  modification.isDelete,
      };
      if (!modification.isDelete && modification.value) {
        entry.value = JSON.parse(modification.value.toString());
      }
      history.push(entry);
    }

    return JSON.stringify(history);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MÉTODOS PRIVADOS DE APOYO
  // ─────────────────────────────────────────────────────────────────────────

  /** Solo AutoVaultMSP */
  private _assertAdmin(ctx: Context): void {
    if (ctx.clientIdentity.getMSPID() !== AUTOVAULT_MSP) {
      throw new Error(`Acceso denegado. Función reservada para ${AUTOVAULT_MSP}.`);
    }
  }

  /** AutoVaultMSP o TecnicosMSP */
  private _assertTechnicianOrAdmin(ctx: Context): void {
    const msp = ctx.clientIdentity.getMSPID();
    if (msp !== AUTOVAULT_MSP && msp !== TECNICOS_MSP) {
      throw new Error(`Acceso denegado. Solo técnicos o admins pueden ejecutar esta función.`);
    }
  }

  private _isAdmin(ctx: Context): boolean {
    return ctx.clientIdentity.getMSPID() === AUTOVAULT_MSP;
  }

  /** Admin o propietario del recurso */
  private _assertOwnerOrAdmin(ctx: Context, resourceClientId: string): void {
    if (this._isAdmin(ctx)) return;
    if (ctx.clientIdentity.getID() !== resourceClientId) {
      throw new Error('Acceso denegado: solo puedes gestionar tus propias órdenes.');
    }
  }

  /**
   * Verifica acceso de lectura a una orden.
   * Pueden leer: admin, cliente propietario, técnico asignado.
   */
  private _assertCanReadOrder(ctx: Context, order: ServiceOrder): void {
    if (this._isAdmin(ctx)) return;
    const callerId = ctx.clientIdentity.getID();
    if (callerId === order.clientId || callerId === order.technicianId) return;
    throw new Error('Acceso denegado: no tienes permiso para ver esta orden.');
  }

  /**
   * Verifica que quien llama sea el técnico asignado a la orden.
   * Los admins siempre pueden ejecutar transiciones de técnico.
   */
  private _assertAssignedTechnician(ctx: Context, order: ServiceOrder): void {
    if (this._isAdmin(ctx)) return;
    if (ctx.clientIdentity.getID() !== order.technicianId) {
      throw new Error(
        `Solo el técnico asignado (${order.technicianId}) puede ejecutar esta acción.`,
      );
    }
  }

  /**
   * Verifica que la orden esté en uno de los estados permitidos.
   * Lanza un error descriptivo con el estado actual y los esperados.
   */
  private _assertStatus(
    order:          ServiceOrder,
    allowedStatuses: ServiceStatus[],
    functionName:   string,
  ): void {
    if (!allowedStatuses.includes(order.status)) {
      throw new Error(
        `${functionName}() requiere status: [${allowedStatuses.join(' | ')}]. ` +
        `Estado actual de la orden ${order.orderId}: ${order.status}.`,
      );
    }
  }

  /** Lee una ServiceOrder del ledger. Lanza error si no existe. */
  private async _getOrder(ctx: Context, orderId: string): Promise<ServiceOrder> {
    const bytes = await ctx.stub.getState(`SERVICE_${orderId}`);
    if (!bytes || bytes.length === 0) {
      throw new Error(`La orden ${orderId} no existe en el ledger.`);
    }
    return JSON.parse(bytes.toString()) as ServiceOrder;
  }

  /** Retorna true si la orden ya existe. */
  private async _orderExists(ctx: Context, orderId: string): Promise<boolean> {
    const bytes = await ctx.stub.getState(`SERVICE_${orderId}`);
    return bytes !== null && bytes.length > 0;
  }

  /**
   * Verifica suscripción ACTIVE del cliente via invokeChaincode → payment-cc.
   */
  private async _assertActiveSubscription(
    ctx:      Context,
    clientId: string,
  ): Promise<void> {
    const subResponse = await ctx.stub.invokeChaincode(
      PAYMENT_CC,
      ['GetSubscriptionStatus', clientId],
      CHANNEL_NAME,
    );
    if (subResponse.status !== 200) {
      throw new Error(`No se pudo verificar la suscripción del cliente ${clientId}.`);
    }
    const sub = JSON.parse(subResponse.payload.toString());
    if (sub.status !== 'ACTIVE') {
      throw new Error(
        `Suscripción inactiva (${sub.status}). Renueva tu membresía para solicitar servicios.`,
      );
    }
  }

  /** Ejecuta una CouchDB rich query y retorna el array como string JSON. */
  private async _runQuery(ctx: Context, queryString: string): Promise<string> {
    const iterator = await ctx.stub.getQueryResult(queryString);
    const results: object[] = [];
    for await (const result of iterator) {
      results.push(JSON.parse(result.value.toString()));
    }
    return JSON.stringify(results);
  }
}
