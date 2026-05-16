/*
 * AutoVault VIP — car-cc
 * Chaincode de inventario de autos coleccionables para Hyperledger Fabric
 *
 * Responsabilidades:
 *   · Registro y gestión de autos coleccionables (ficha técnica completa)
 *   · Hash de fotos y documentos (los archivos reales viven en S3 / IPFS)
 *   · Control de acceso por rol y propiedad
 *   · Historial inmutable de cada auto (getHistoryForKey)
 *   · Respeta el límite de autos según el plan de suscripción del cliente
 *
 * Dependencias cruzadas (invokeChaincode):
 *   · payment-cc → GetSubscriptionStatus  (verifica suscripción ACTIVE antes de escribir)
 *
 * Requiere CouchDB como state database (para rich queries).
 *
 * Dependencias: fabric-contract-api, fabric-shim
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import './fabric-types-extended';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const AUTOVAULT_MSP = 'AutoVaultMSP';
const PAYMENT_CC    = 'payment-cc';   // nombre del chaincode de pagos
const CHANNEL_NAME  = 'main-channel'; // canal donde viven todos los chaincodes

// Límite de autos por plan (debe coincidir con payment-cc)
const MAX_CARS_BY_PLAN: Record<string, number> = {
  SILVER:   5,
  GOLD:     15,
  PLATINUM: 99999,
};

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS DE DATOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Car: activo principal del ledger.
 * Clave en el ledger: CAR_{carId}
 *
 * Las fotos y documentos son activos separados vinculados por carId.
 * NUNCA se guarda la foto o el PDF aquí; solo el conteo y el propio objeto Car.
 */
interface Car {
  docType:    'car';
  carId:      string;

  /**
   * clientId: ID X.509 completo del propietario (ctx.clientIdentity.getID()).
   * Es el mismo string que se usa en payment-cc como clave de suscripción.
   */
  clientId:   string;

  // ── Identificación ──
  vin:        string;   // Vehicle Identification Number (17 caracteres)
  marca:      string;   // Ej: Ferrari, Porsche, Shelby
  modelo:     string;   // Ej: 250 GTO, 911 Carrera RS, Cobra 427
  anio:       number;   // año de fabricación
  color:      string;
  numeracion: string;   // número de producción si aplica (ej: "47 de 100")

  // ── Especificaciones técnicas ──
  motor:         string;  // Ej: "V12 3.0L"
  cilindrada:    string;  // Ej: "3000cc"
  transmision:   'MANUAL' | 'AUTOMATICA' | 'SEMI_AUTOMATICA';
  kilometraje:   number;  // en km; 0 si es desconocido
  condicion:     'CONCURSO' | 'EXCELENTE' | 'BUENA' | 'REGULAR' | 'RESTAURACION';

  // ── Valoración ──
  valoracionUSD:    number;  // valor estimado en USD
  ultimaValuacion:  string;  // ISO 8601 de cuándo se valuó
  valuadoPor:       string;  // ID del admin que actualizó la valuación

  // ── Estado operativo ──
  status: 'ACTIVE' | 'IN_MAINTENANCE' | 'INACTIVE';

  // ── Notas del asesor ──
  notasInternas: string;  // solo visible para admin; no se expone al cliente

  // ── Metadatos ──
  registradoPor: string;  // ID del admin/asesor que lo registró
  createdAt:     string;  // ISO 8601
  updatedAt:     string;  // ISO 8601
  deletedAt?:    string;  // ISO 8601 si fue eliminado
  deletedBy?:    string;  // ID del admin que lo eliminó
}

/**
 * CarDeletion: registro inmutable de eliminación de auto.
 * Clave en el ledger: CARDEL_{carId}
 *
 * Se usa para auditoría: quién eliminó el auto, cuándo, y snapshot de datos.
 */
interface CarDeletion {
  docType:          'carDeletion';
  carId:            string;
  clientId:         string;
  deletedAt:        string;  // ISO 8601
  deletedBy:        string;  // ID del admin
  carDataSnapshot:  Car;     // snapshot del auto antes de borrar
}

/**
 * CarDocument: documento legal asociado a un auto.
 * Clave en el ledger: CARDOC_{carId}_{docId}
 *
 * El archivo real (PDF, imagen) vive en S3/IPFS.
 * Solo se guarda el SHA256 para verificar integridad.
 */
interface CarDocument {
  docType:   'carDocument';
  docId:     string;
  carId:     string;
  clientId:  string;

  tipo: 'TITULO_PROPIEDAD'
      | 'POLIZA_SEGURO'
      | 'CERTIFICADO_AUTENTICIDAD'
      | 'FACTURA_COMPRA'
      | 'HOMOLOGACION'
      | 'OTRO';

  descripcion: string;   // texto libre: "Título de propiedad - estado TX"
  fileHash:    string;   // SHA256 del archivo original
  fileUrl:     string;   // URL en S3 / IPFS (off-chain)
  uploadedBy:  string;   // ID del que subió el documento
  uploadedAt:  string;   // ISO 8601
  vencimiento: string;   // ISO 8601 si tiene fecha de vencimiento (ej: póliza), '' si no
}

/**
 * CarPhoto: foto de un auto coleccionable.
 * Clave en el ledger: CARPHOTO_{carId}_{photoId}
 *
 * La imagen real vive en S3/IPFS.
 * El hash garantiza que la foto no fue alterada.
 */
interface CarPhoto {
  docType:    'carPhoto';
  photoId:    string;
  carId:      string;
  clientId:   string;
  fileHash:   string;   // SHA256 de la imagen
  fileUrl:    string;   // URL en S3 / IPFS
  caption:    string;   // descripción breve (ej: "Motor V12 restaurado 2023")
  esPrincipal: boolean; // si es la foto de portada del auto
  uploadedBy: string;
  uploadedAt: string;
}

// Estructura que devuelve GetSubscriptionStatus de payment-cc
interface SubscriptionResponse {
  status:  string;
  plan:    string;
  maxCars: number;
  endDate: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRATO
// ─────────────────────────────────────────────────────────────────────────────

@Info({
  title: 'CarContract',
  description: 'Inventario de autos coleccionables VIP — AutoVault',
})
export class CarContract extends Contract {

  // ───────────────────────────────────────────────────────────────────────────
  // INICIALIZAR LEDGER
  // ───────────────────────────────────────────────────────────────────────────

  @Transaction()
  public async InitLedger(ctx: Context): Promise<void> {
    console.info('=== CarContract inicializado correctamente ===');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REGISTRO DE AUTOS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * RegisterCar — solo Admin / Asesor (AutoVaultMSP)
   *
   * El asesor registra el auto DESPUÉS de la visita domiciliaria de confirmación.
   * Verifica que el cliente tiene suscripción ACTIVE y que no ha llegado al
   * límite de autos de su plan.
   *
   * @param carId        - ID único del auto (generado por la app, ej: CAR-2025-001)
   * @param clientId     - ID X.509 del cliente propietario
   * @param vin          - VIN del vehículo (17 chars)
   * @param marca        - marca del auto (ej: Ferrari)
   * @param modelo       - modelo del auto (ej: 250 GTO)
   * @param anio         - año de fabricación como string
   * @param color        - color del auto
   * @param numeracion   - número de producción si aplica
   * @param motor        - descripción del motor
   * @param cilindrada   - cilindrada
   * @param transmision  - MANUAL | AUTOMATICA | SEMI_AUTOMATICA
   * @param kilometraje  - kilómetros como string
   * @param condicion    - estado general del auto
   * @param valoracionUSD - valor estimado en USD como string
   * @param notasInternas - notas privadas del asesor
   */
  @Transaction()
  public async RegisterCar(
    ctx:            Context,
    carId:          string,
    clientId:       string,
    vin:            string,
    marca:          string,
    modelo:         string,
    anio:           string,
    color:          string,
    numeracion:     string,
    motor:          string,
    cilindrada:     string,
    transmision:    string,
    kilometraje:    string,
    condicion:      string,
    valoracionUSD:  string,
    notasInternas:  string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    // Validar carId no vacío
    if (!carId || carId.trim() === '') {
      throw new Error('carId no puede estar vacío.');
    }

    // Validar clientId no vacío
    if (!clientId || clientId.trim() === '') {
      throw new Error('clientId no puede estar vacío.');
    }

    // Verificar que el auto no exista ya
    if (await this._carExists(ctx, carId)) {
      throw new Error(`Ya existe un auto con ID ${carId} en el ledger.`);
    }

    // Validar VIN: exactamente 17 caracteres
    if (!vin || vin.length !== 17) {
      throw new Error(`VIN inválido: debe tener exactamente 17 caracteres. Recibido: ${vin.length}.`);
    }

    // Validar marca y modelo no vacíos
    if (!marca || marca.trim() === '') {
      throw new Error('Marca no puede estar vacía.');
    }
    if (!modelo || modelo.trim() === '') {
      throw new Error('Modelo no puede estar vacío.');
    }

    // Validar año: número entre 1800 y 2100
    const anioNum = parseInt(anio, 10);
    if (isNaN(anioNum) || anioNum < 1800 || anioNum > 2100) {
      throw new Error(`Año inválido: ${anio}. Rango válido: 1800-2100.`);
    }

    // Validar color no vacío
    if (!color || color.trim() === '') {
      throw new Error('Color no puede estar vacío.');
    }

    // Validar motor no vacío
    if (!motor || motor.trim() === '') {
      throw new Error('Motor no puede estar vacío.');
    }

    // Validar cilindrada no vacía
    if (!cilindrada || cilindrada.trim() === '') {
      throw new Error('Cilindrada no puede estar vacía.');
    }

    // Validar transmisión
    const validTransmisiones = ['MANUAL', 'AUTOMATICA', 'SEMI_AUTOMATICA'];
    if (!validTransmisiones.includes(transmision.toUpperCase())) {
      throw new Error(
        `Transmisión inválida: ${transmision}. ` +
        `Opciones: ${validTransmisiones.join(', ')}.`
      );
    }

  // Validar kilometraje: no negativo
    const kmNum = parseInt(kilometraje, 10);
    if (isNaN(kmNum) || kmNum < 0) {
      throw new Error(`Kilometraje inválido: debe ser un número no negativo. Recibido: ${kilometraje}.`);
    }

    // Validar condición
    const validCondiciones = ['CONCURSO', 'EXCELENTE', 'BUENA', 'REGULAR', 'RESTAURACION'];
    if (!validCondiciones.includes(condicion.toUpperCase())) {
      throw new Error(
        `Condición inválida: ${condicion}. ` +
        `Opciones: ${validCondiciones.join(', ')}.`
      );
    }

    // Validar valoración: número positivo y razonable
    const valuacion = parseFloat(valoracionUSD);
    if (isNaN(valuacion)) {
      throw new Error(`Valuación inválida: ${valoracionUSD} no es un número.`);
    }
    if (valuacion <= 0) {
      throw new Error(`Valuación debe ser positiva. Recibido: ${valuacion}.`);
    }
    if (valuacion > 100_000_000) {
      throw new Error(`Valuación excede límite máximo ($100M USD). Recibido: ${valuacion}.`);
    }

    // Verificar VIN único (previene duplicados del mismo auto)
    await this._assertVinUnique(ctx, vin);

    // Verificar suscripción activa del cliente y límite de autos
    await this._assertSubscriptionAndCarLimit(ctx, clientId);

    const adminId = ctx.clientIdentity.getID();
    const now     = new Date().toISOString();

    const car: Car = {
      docType:       'car',
      carId,
      clientId,
      vin:           vin.toUpperCase(),
      marca,
      modelo,
      anio:          anioNum,
      color,
      numeracion,
      motor,
      cilindrada,
      transmision:   transmision.toUpperCase() as Car['transmision'],
      kilometraje:   kmNum,
      condicion:     condicion.toUpperCase() as Car['condicion'],
      valoracionUSD: valuacion,
      ultimaValuacion: now,
      valuadoPor:    adminId,
      status:        'ACTIVE',
      notasInternas,
      registradoPor: adminId,
      createdAt:     now,
      updatedAt:     now,
    };

    await ctx.stub.putState(`CAR_${carId}`, Buffer.from(JSON.stringify(car)));

    ctx.stub.setEvent(
      'CarRegistered',
      Buffer.from(JSON.stringify({
        carId,
        clientId,
        marca,
        modelo,
        anio: car.anio,
        vin:  car.vin,
      })),
    );

    console.info(`Auto ${carId} (${marca} ${modelo} ${anioNum}) registrado para cliente ${clientId}`);
    return JSON.stringify(car);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ACTUALIZACIÓN DE DETALLES
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * UpdateCarDetails — Admin o el propio cliente propietario
   *
   * Permite actualizar campos no críticos del auto: color, condición,
   * kilometraje, motor, notas. El VIN, marca, modelo y año son inmutables
   * una vez registrados (requieren DeleteCar + RegisterCar para corregir).
   *
   * El cliente firmó en el contrato físico que es responsable de la
   * exactitud de los datos publicados, así que puede actualizarlos él mismo.
   */
  @Transaction()
  public async UpdateCarDetails(
    ctx:          Context,
    carId:        string,
    color:        string,
    condicion:    string,
    kilometraje:  string,
    motor:        string,
    cilindrada:   string,
    numeracion:   string,
  ): Promise<string> {

    const car = await this._getCar(ctx, carId);
    this._assertOwnerOrAdmin(ctx, car.clientId);

    // Si es el cliente quien actualiza, verificar suscripción activa
    if (!this._isAdmin(ctx)) {
      await this._assertActiveSubscription(ctx, car.clientId);
    }

    // Validar condición si se proporciona
    if (condicion && condicion.trim() !== '') {
      const validCondiciones = ['CONCURSO', 'EXCELENTE', 'BUENA', 'REGULAR', 'RESTAURACION'];
      if (!validCondiciones.includes(condicion.toUpperCase())) {
        throw new Error(
          `Condición inválida: ${condicion}. ` +
          `Opciones: ${validCondiciones.join(', ')}.`
        );
      }
      car.condicion = condicion.toUpperCase() as Car['condicion'];
    }

    // Validar kilometraje si se proporciona
    if (kilometraje && kilometraje.trim() !== '') {
      const kmNum = parseInt(kilometraje, 10);
      if (isNaN(kmNum) || kmNum < 0) {
        throw new Error(`Kilometraje inválido: debe ser no negativo. Recibido: ${kilometraje}.`);
      }
      car.kilometraje = kmNum;
    }

    // Actualizar campos opcionales
    if (color && color.trim() !== '') car.color = color;
    if (motor && motor.trim() !== '') car.motor = motor;
    if (cilindrada && cilindrada.trim() !== '') car.cilindrada = cilindrada;
    if (numeracion && numeracion.trim() !== '') car.numeracion = numeracion;

    car.updatedAt = new Date().toISOString();

    await ctx.stub.putState(`CAR_${carId}`, Buffer.from(JSON.stringify(car)));

    ctx.stub.setEvent(
      'CarUpdated',
      Buffer.from(JSON.stringify({ carId, clientId: car.clientId, updatedBy: ctx.clientIdentity.getID() })),
    );

    return JSON.stringify(car);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // VALUACIÓN
  // ───────────────────────────────────────────────────────────────────────────

 /**
   * UpdateValuation — solo Admin / Asesor (AutoVaultMSP)
   *
   * Solo los admins actualizan la valuación oficial del auto.
   * El cliente puede ver el historial de valuaciones via GetCarHistory().
   *
   * @param carId          - ID del auto
   * @param valoracionUSD  - nuevo valor estimado en USD
   */
  @Transaction()
  public async UpdateValuation(
    ctx:           Context,
    carId:         string,
    valoracionUSD: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    // Validar valuación: número positivo y razonable
    const valNum = parseFloat(valoracionUSD);
    if (isNaN(valNum)) {
      throw new Error(`Valuación inválida: ${valoracionUSD} no es un número.`);
    }
    if (valNum <= 0) {
      throw new Error(`Valuación debe ser positiva. Recibido: ${valNum}.`);
    }
    if (valNum > 100_000_000) {
      throw new Error(`Valuación excede límite máximo ($100M USD). Recibido: ${valNum}.`);
    }

    const car = await this._getCar(ctx, carId);

    car.valoracionUSD    = valNum;
    car.ultimaValuacion  = new Date().toISOString();
    car.valuadoPor       = ctx.clientIdentity.getID();
    car.updatedAt        = new Date().toISOString();

    await ctx.stub.putState(`CAR_${carId}`, Buffer.from(JSON.stringify(car)));

    ctx.stub.setEvent(
      'CarValuated',
      Buffer.from(JSON.stringify({
        carId,
        clientId:      car.clientId,
        valoracionUSD: car.valoracionUSD,
        fecha:         car.ultimaValuacion,
      })),
    );

    return JSON.stringify(car);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ESTADO DEL AUTO
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * SetCarStatus — solo Admin (AutoVaultMSP)
   *
   * Cambia el estado operativo del auto.
   * maintenance-cc llama a SetCarStatus('IN_MAINTENANCE') cuando inicia un servicio
   * y a SetCarStatus('ACTIVE') cuando lo completa.
   *
   * @param carId  - ID del auto
   * @param status - ACTIVE | IN_MAINTENANCE | INACTIVE
   */
  @Transaction()
  public async SetCarStatus(
    ctx:    Context,
    carId:  string,
    status: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const validStatuses = ['ACTIVE', 'IN_MAINTENANCE', 'INACTIVE'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Status inválido: ${status}. Opciones: ${validStatuses.join(', ')}`);
    }

    const car   = await this._getCar(ctx, carId);
    car.status  = status as Car['status'];
    car.updatedAt = new Date().toISOString();

    await ctx.stub.putState(`CAR_${carId}`, Buffer.from(JSON.stringify(car)));

    ctx.stub.setEvent(
      'CarStatusChanged',
      Buffer.from(JSON.stringify({ carId, clientId: car.clientId, status })),
    );

    return JSON.stringify(car);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DOCUMENTOS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * AddDocument — Admin o el propio cliente propietario
   *
   * El cliente firmó en el contrato físico la responsabilidad sobre sus documentos.
   * Por eso puede subirlos él mismo desde la app.
   * El archivo real va a S3/IPFS; aquí solo se registra el hash SHA256.
   *
   * @param docId       - ID único del documento (generado por la app)
   * @param carId       - ID del auto al que pertenece
   * @param tipo        - tipo de documento
   * @param descripcion - descripción libre
   * @param fileHash    - SHA256 del archivo (calculado por la app antes de llamar)
   * @param fileUrl     - URL del archivo en S3 / IPFS
   * @param vencimiento - ISO 8601 si tiene vencimiento (ej: póliza), '' si no
   */
  @Transaction()
  public async AddDocument(
    ctx:          Context,
    docId:        string,
    carId:        string,
    tipo:         string,
    descripcion:  string,
    fileHash:     string,
    fileUrl:      string,
    vencimiento:  string,
  ): Promise<string> {

    const car = await this._getCar(ctx, carId);
    this._assertOwnerOrAdmin(ctx, car.clientId);

    if (!this._isAdmin(ctx)) {
      await this._assertActiveSubscription(ctx, car.clientId);
    }

    // Validar docId no vacío
    if (!docId || docId.trim() === '') {
      throw new Error('docId no puede estar vacío.');
    }

    // Verificar que el docId no exista ya
    const existingDoc = await ctx.stub.getState(`CARDOC_${carId}_${docId}`);
    if (existingDoc && existingDoc.length > 0) {
      throw new Error(`Ya existe un documento con ID ${docId} para el auto ${carId}.`);
    }

    // Validar tipo de documento
    const tiposValidos = [
      'TITULO_PROPIEDAD', 'POLIZA_SEGURO', 'CERTIFICADO_AUTENTICIDAD',
      'FACTURA_COMPRA', 'HOMOLOGACION', 'OTRO',
    ];
    if (!tiposValidos.includes(tipo.toUpperCase())) {
      throw new Error(
        `Tipo de documento inválido: ${tipo}. ` +
        `Opciones: ${tiposValidos.join(', ')}.`
      );
    }

    // Validar fileHash como SHA256
    if (!this._isValidSHA256(fileHash)) {
      throw new Error(
        `fileHash inválido: ${fileHash}. ` +
        `Debe ser un SHA256 válido (64 caracteres hexadecimales).`
      );
    }

    // Validar descripción no vacía
    if (!descripcion || descripcion.trim() === '') {
      throw new Error('Descripción no puede estar vacía.');
    }

    // Validar fileUrl no vacío
    if (!fileUrl || fileUrl.trim() === '') {
      throw new Error('fileUrl no puede estar vacío.');
    }

    const document: CarDocument = {
      docType:     'carDocument',
      docId,
      carId,
      clientId:    car.clientId,
      tipo:        tipo.toUpperCase() as CarDocument['tipo'],
      descripcion,
      fileHash,
      fileUrl,
      uploadedBy:  ctx.clientIdentity.getID(),
      uploadedAt:  new Date().toISOString(),
      vencimiento: vencimiento || '',
    };

    await ctx.stub.putState(
      `CARDOC_${carId}_${docId}`,
      Buffer.from(JSON.stringify(document)),
    );

    ctx.stub.setEvent(
      'DocumentAdded',
      Buffer.from(JSON.stringify({ docId, carId, clientId: car.clientId, tipo: document.tipo })),
    );

    console.info(`Documento ${docId} (${document.tipo}) agregado al auto ${carId}`);
    return JSON.stringify(document);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * RemovePhoto — Admin o el propio cliente propietario
   *
   * Elimina el registro de la foto del ledger.
   * Si era la foto principal, automáticamente asigna otra como principal.
   * La imagen en S3/IPFS debe eliminarse por separado desde la app.
   */
  @Transaction()
  public async RemovePhoto(
    ctx:    Context,
    photoId: string,
    carId:  string,
  ): Promise<void> {

    const car = await this._getCar(ctx, carId);
    this._assertOwnerOrAdmin(ctx, car.clientId);

    const photoKey   = `CARPHOTO_${carId}_${photoId}`;
    const photoBytes = await ctx.stub.getState(photoKey);
    if (!photoBytes || photoBytes.length === 0) {
      throw new Error(`La foto ${photoId} no existe para el auto ${carId}.`);
    }

    const photo: CarPhoto = JSON.parse(photoBytes.toString());
    const wasPrincipal = photo.esPrincipal;

    // Eliminar la foto
    await ctx.stub.deleteState(photoKey);

    // Si era principal, asignar otra como principal (la más antigua, que es la siguiente más reciente después del borrado)
    if (wasPrincipal) {
      const queryString = JSON.stringify({
        selector: { docType: 'carPhoto', carId },
        sort: [{ uploadedAt: 'asc' }],
        limit: 1,
      });
      const iterator = await ctx.stub.getQueryResult(queryString);
      for await (const result of iterator) {
        const nextPhoto: CarPhoto = JSON.parse(result.value.toString());
        nextPhoto.esPrincipal = true;
        await ctx.stub.putState(
          `CARPHOTO_${carId}_${nextPhoto.photoId}`,
          Buffer.from(JSON.stringify(nextPhoto)),
        );
        console.info(
          `Foto principal de ${carId} reasignada a ${nextPhoto.photoId} después de eliminar ${photoId}`,
        );
        break;
      }
    }

    ctx.stub.setEvent(
      'PhotoRemoved',
      Buffer.from(JSON.stringify({
        photoId,
        carId,
        clientId:  car.clientId,
        removedBy: ctx.clientIdentity.getID(),
        wasPrincipal,
      })),
    );
  }

  /**
   * AddPhoto — Admin o el propio cliente propietario
   *
   * La foto real va a S3/IPFS; aquí solo el hash SHA256 y la URL.
   * Máximo 20 fotos por auto (prevenimos que el ledger crezca sin control).
   *
   * @param photoId    - ID único de la foto (generado por la app)
   * @param carId      - ID del auto
   * @param fileHash   - SHA256 de la imagen
   * @param fileUrl    - URL en S3 / IPFS
   * @param caption    - descripción breve de la foto
   * @param esPrincipal - 'true' si es la foto de portada
   */
  @Transaction()
  public async AddPhoto(
    ctx:          Context,
    photoId:      string,
    carId:        string,
    fileHash:     string,
    fileUrl:      string,
    caption:      string,
    esPrincipal:  string,
  ): Promise<string> {

    const car = await this._getCar(ctx, carId);
    this._assertOwnerOrAdmin(ctx, car.clientId);

    if (!this._isAdmin(ctx)) {
      await this._assertActiveSubscription(ctx, car.clientId);
    }

    // Validar photoId no vacío
    if (!photoId || photoId.trim() === '') {
      throw new Error('photoId no puede estar vacío.');
    }

    // Verificar que no exista ya esa foto
    const existingPhoto = await ctx.stub.getState(`CARPHOTO_${carId}_${photoId}`);
    if (existingPhoto && existingPhoto.length > 0) {
      throw new Error(`Ya existe una foto con ID ${photoId} para el auto ${carId}.`);
    }

    // Validar fileHash como SHA256
    if (!this._isValidSHA256(fileHash)) {
      throw new Error(
        `fileHash inválido: ${fileHash}. ` +
        `Debe ser un SHA256 válido (64 caracteres hexadecimales).`
      );
    }

    // Validar fileUrl no vacío
    if (!fileUrl || fileUrl.trim() === '') {
      throw new Error('fileUrl no puede estar vacío.');
    }

    // Validar caption no vacío
    if (!caption || caption.trim() === '') {
      throw new Error('Caption no puede estar vacío.');
    }

    // Verificar límite de 20 fotos por auto
    const photoCount = await this._countPhotos(ctx, carId);
    if (photoCount >= 20) {
      throw new Error(`El auto ${carId} ya tiene 20 fotos (límite máximo).`);
    }

    // Si esPrincipal=true, desmarcar la foto principal anterior
    if (esPrincipal === 'true') {
      await this._clearMainPhoto(ctx, carId);
    }

    const photo: CarPhoto = {
      docType:     'carPhoto',
      photoId,
      carId,
      clientId:    car.clientId,
      fileHash,
      fileUrl,
      caption,
      esPrincipal: esPrincipal === 'true',
      uploadedBy:  ctx.clientIdentity.getID(),
      uploadedAt:  new Date().toISOString(),
    };

    await ctx.stub.putState(
      `CARPHOTO_${carId}_${photoId}`,
      Buffer.from(JSON.stringify(photo)),
    );

    ctx.stub.setEvent(
      'PhotoAdded',
      Buffer.from(JSON.stringify({ photoId, carId, clientId: car.clientId })),
    );

    return JSON.stringify(photo);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ELIMINAR AUTO
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * DeleteCar — solo Admin (AutoVaultMSP)
   *
   * Elimina el auto y todos sus documentos y fotos del ledger.
   * Solo disponible para admins (el cliente no puede borrar su propia ficha).
   * Requiere que el auto esté en status INACTIVE (no se puede borrar si está
   * activo o en mantenimiento).
   */
  @Transaction()
  public async DeleteCar(ctx: Context, carId: string): Promise<void> {
    this._assertAdmin(ctx);

    const car = await this._getCar(ctx, carId);

    if (car.status !== 'INACTIVE') {
      throw new Error(
        `No se puede eliminar el auto ${carId}: status actual es ${car.status}. ` +
        `Cambia a INACTIVE primero con SetCarStatus().`,
      );
    }

  const adminId = ctx.clientIdentity.getID();
    const deletionTime = new Date().toISOString();

    // Crear registro inmutable de eliminación (auditoría)
    const deletion: CarDeletion = {
      docType:         'carDeletion',
      carId,
      clientId:        car.clientId,
      deletedAt:       deletionTime,
      deletedBy:       adminId,
      carDataSnapshot: car, // snapshot completo antes de borrar
    };

    // Guardar registro de eliminación
    await ctx.stub.putState(
      `CARDEL_${carId}`,
      Buffer.from(JSON.stringify(deletion)),
    );

    // Eliminar documentos del auto
    const docQuery = JSON.stringify({
      selector: { docType: 'carDocument', carId },
    });
    const docIterator = await ctx.stub.getQueryResult(docQuery);
    for await (const result of docIterator) {
      const doc: CarDocument = JSON.parse(result.value.toString());
      await ctx.stub.deleteState(`CARDOC_${carId}_${doc.docId}`);
    }

    // Eliminar fotos del auto
    const photoQuery = JSON.stringify({
      selector: { docType: 'carPhoto', carId },
    });
    const photoIterator = await ctx.stub.getQueryResult(photoQuery);
    for await (const result of photoIterator) {
      const photo: CarPhoto = JSON.parse(result.value.toString());
      await ctx.stub.deleteState(`CARPHOTO_${carId}_${photo.photoId}`);
    }

    // Eliminar el auto
    await ctx.stub.deleteState(`CAR_${carId}`);

    ctx.stub.setEvent(
      'CarDeleted',
      Buffer.from(JSON.stringify({
        carId,
        clientId:  car.clientId,
        deletedBy: adminId,
        deletedAt: deletionTime,
      })),
    );

    console.info(`Auto ${carId} eliminado del ledger por ${adminId} a las ${deletionTime}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // QUERIES (solo lectura)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GetCar — Admin o el propio cliente propietario
   *
   * Las notasInternas (campo privado del asesor) se filtran
   * si quien consulta es el cliente.
   */
  @Transaction(false)
  @Returns('string')
  public async GetCar(ctx: Context, carId: string): Promise<string> {
    const car = await this._getCar(ctx, carId);
    this._assertOwnerOrAdmin(ctx, car.clientId);

    // El cliente no ve las notas internas del asesor
    const response: any = { ...car };
    if (!this._isAdmin(ctx)) {
      delete response.notasInternas;
    }

    return JSON.stringify(response);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GetClientCars — Admin o el propio cliente
   *
   * Retorna todos los autos de un cliente.
   * Requiere CouchDB.
   */
  @Transaction(false)
  @Returns('string')
  public async GetClientCars(ctx: Context, clientId: string): Promise<string> {
    this._assertOwnerOrAdmin(ctx, clientId);

    const queryString = JSON.stringify({
      selector: {
        docType:  'car',
        clientId: clientId,
      },
      sort: [{ createdAt: 'desc' }],
    });

    const iterator = await ctx.stub.getQueryResult(queryString);
    const cars: any[] = [];

    for await (const result of iterator) {
      const car: any = JSON.parse(result.value.toString());
      // Filtrar notas internas si es el cliente
      if (!this._isAdmin(ctx)) delete car.notasInternas;
      cars.push(car);
    }

    return JSON.stringify(cars);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GetCarHistory — Admin o el propio cliente propietario
   *
   * Retorna el historial completo e inmutable del auto: cada vez que
   * algún campo fue modificado, quién lo modificó y cuándo.
   * Esto es la auditoría nativa de Hyperledger Fabric (getHistoryForKey).
   *
   * Extremadamente útil para autos coleccionables: demuestra la cadena
   * de custodia y todos los cambios de valuación a lo largo del tiempo.
   */
  @Transaction(false)
  @Returns('string')
  public async GetCarHistory(ctx: Context, carId: string): Promise<string> {
    const car = await this._getCar(ctx, carId);
    this._assertOwnerOrAdmin(ctx, car.clientId);

    const historyIterator = await ctx.stub.getHistoryForKey(`CAR_${carId}`);
    const history: object[] = [];

    for await (const modification of historyIterator) {
      const entry: any = {
        txId:      modification.txId,
        timestamp: modification.timestamp,
        isDelete:  modification.isDelete,
      };

      if (!modification.isDelete && modification.value) {
        const value: any = JSON.parse(modification.value.toString());
        if (!this._isAdmin(ctx)) delete value.notasInternas;
        entry.value = value;
      }

      history.push(entry);
    }

    return JSON.stringify(history);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GetCarDocuments — Admin o el propio cliente propietario
   *
   * Retorna todos los documentos del auto.
   */
  @Transaction(false)
  @Returns('string')
  public async GetCarDocuments(ctx: Context, carId: string): Promise<string> {
    const car = await this._getCar(ctx, carId);
    this._assertOwnerOrAdmin(ctx, car.clientId);

    const queryString = JSON.stringify({
      selector: { docType: 'carDocument', carId },
      sort: [{ uploadedAt: 'desc' }],
    });

    const iterator = await ctx.stub.getQueryResult(queryString);
    const docs: CarDocument[] = [];
    for await (const result of iterator) {
      docs.push(JSON.parse(result.value.toString()));
    }

    return JSON.stringify(docs);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * GetCarPhotos — Admin o el propio cliente propietario
   */
  @Transaction(false)
  @Returns('string')
  public async GetCarPhotos(ctx: Context, carId: string): Promise<string> {
    const car = await this._getCar(ctx, carId);
    this._assertOwnerOrAdmin(ctx, car.clientId);

    const queryString = JSON.stringify({
      selector: { docType: 'carPhoto', carId },
      sort: [{ uploadedAt: 'desc' }],
    });

    const iterator = await ctx.stub.getQueryResult(queryString);
    const photos: CarPhoto[] = [];
    for await (const result of iterator) {
      photos.push(JSON.parse(result.value.toString()));
    }

    return JSON.stringify(photos);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MÉTODOS PRIVADOS DE APOYO
  // ───────────────────────────────────────────────────────────────────────────

  /** Verifica que el invocador sea de AutoVaultMSP. */
  private _assertAdmin(ctx: Context): void {
    if (ctx.clientIdentity.getMSPID() !== AUTOVAULT_MSP) {
      throw new Error(
        `Acceso denegado. Función reservada para ${AUTOVAULT_MSP}. ` +
        `Tu MSP: ${ctx.clientIdentity.getMSPID()}.`,
      );
    }
  }

  /** Retorna true si el invocador es admin de AutoVault. */
  private _isAdmin(ctx: Context): boolean {
    return ctx.clientIdentity.getMSPID() === AUTOVAULT_MSP;
  }

  /** Verifica que el invocador sea admin o el propietario del recurso. */
  private _assertOwnerOrAdmin(ctx: Context, resourceClientId: string): void {
    if (this._isAdmin(ctx)) return;
    if (ctx.clientIdentity.getID() !== resourceClientId) {
      throw new Error('Acceso denegado: solo puedes gestionar tus propios autos.');
    }
  }

  /** Lee un Car del ledger. Lanza error si no existe. */
  private async _getCar(ctx: Context, carId: string): Promise<Car> {
    const bytes = await ctx.stub.getState(`CAR_${carId}`);
    if (!bytes || bytes.length === 0) {
      throw new Error(`El auto ${carId} no existe en el ledger.`);
    }
    return JSON.parse(bytes.toString()) as Car;
  }

  /** Retorna true si el carId ya existe en el ledger. */
  private async _carExists(ctx: Context, carId: string): Promise<boolean> {
    const bytes = await ctx.stub.getState(`CAR_${carId}`);
    return bytes !== null && bytes.length > 0;
  }

  /**
   * Verifica que el VIN no esté ya registrado para otro auto.
   * Requiere CouchDB (rich query).
   */
  private async _assertVinUnique(ctx: Context, vin: string): Promise<void> {
    const queryString = JSON.stringify({
      selector: {
        docType: 'car',
        vin:     vin.toUpperCase(),
      },
    });
    const iterator = await ctx.stub.getQueryResult(queryString);
    for await (const _ of iterator) {
      throw new Error(
        `El VIN ${vin} ya está registrado. Un mismo auto no puede estar en dos cuentas.`,
      );
    }
  }

  /**
   * Llama a payment-cc via invokeChaincode para:
   *   1. Verificar que la suscripción del cliente esté ACTIVE
   *   2. Contar sus autos actuales y verificar que no exceda el límite del plan
   *
   * Esta es la llamada cruzada entre chaincodes en Hyperledger Fabric.
   * invokeChaincode ejecuta en el mismo canal y en la misma transacción.
   */
  private async _assertSubscriptionAndCarLimit(
    ctx:      Context,
    clientId: string,
  ): Promise<void> {
    // 1. Verificar suscripción activa
    const subResponse = await ctx.stub.invokeChaincode(
      PAYMENT_CC,
      ['GetSubscriptionStatus', clientId],
      CHANNEL_NAME,
    );

    if (subResponse.status !== 200) {
      throw new Error(
        `No se pudo verificar la suscripción del cliente ${clientId}: ` +
        subResponse.message,
      );
    }

    const subscription: SubscriptionResponse = JSON.parse(
      subResponse.payload.toString(),
    );

    if (subscription.status !== 'ACTIVE') {
      throw new Error(
        `El cliente ${clientId} no tiene suscripción ACTIVE. ` +
        `Estado actual: ${subscription.status}. ` +
        `No se puede registrar el auto hasta que renueve su membresía.`,
      );
    }

    // 2. Contar autos actuales del cliente
    const currentCars  = await this._countClientCars(ctx, clientId);
    const maxCars      = MAX_CARS_BY_PLAN[subscription.plan] ?? 0;

    if (currentCars >= maxCars) {
      throw new Error(
        `El cliente ya tiene ${currentCars} auto(s) registrado(s). ` +
        `Su plan ${subscription.plan} permite un máximo de ${maxCars}. ` +
        `Para agregar más autos, debe actualizar su plan de suscripción.`,
      );
    }
  }

  /**
   * Versión simplificada que solo verifica la suscripción (sin contar autos).
   * Usada en updates y uploads donde no aplica el límite.
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

    const subscription: SubscriptionResponse = JSON.parse(
      subResponse.payload.toString(),
    );

    if (subscription.status !== 'ACTIVE') {
      throw new Error(
        `Suscripción inactiva. No puedes modificar datos con status ${subscription.status}.`,
      );
    }
  }

  /** Cuenta cuántos autos tiene registrados un cliente (CouchDB). */
  private async _countClientCars(ctx: Context, clientId: string): Promise<number> {
    const queryString = JSON.stringify({
      selector: { docType: 'car', clientId },
      fields: ['carId'],
    });
    const iterator = await ctx.stub.getQueryResult(queryString);
    let count = 0;
    for await (const _ of iterator) count++;
    return count;
  }

  /** Cuenta cuántas fotos tiene un auto (CouchDB). */
  private async _countPhotos(ctx: Context, carId: string): Promise<number> {
    const queryString = JSON.stringify({
      selector: { docType: 'carPhoto', carId },
      fields: ['photoId'],
    });
    const iterator = await ctx.stub.getQueryResult(queryString);
    let count = 0;
    for await (const _ of iterator) count++;
    return count;
  }

  /**
   * Desmarca la foto principal anterior cuando se sube una nueva foto principal.
   * Así solo hay una foto de portada por auto en todo momento.
   */
  private async _clearMainPhoto(ctx: Context, carId: string): Promise<void> {
    const queryString = JSON.stringify({
      selector: { docType: 'carPhoto', carId, esPrincipal: true },
    });
    const iterator = await ctx.stub.getQueryResult(queryString);
    for await (const result of iterator) {
      const photo: CarPhoto = JSON.parse(result.value.toString());
      photo.esPrincipal = false;
      await ctx.stub.putState(
        `CARPHOTO_${carId}_${photo.photoId}`,
        Buffer.from(JSON.stringify(photo)),
      );
    }
  }

  /**
   * Valida que un hash sea un SHA256 válido (64 caracteres hexadecimales).
   */
  private _isValidSHA256(hash: string): boolean {
    return /^[a-fA-F0-9]{64}$/.test(hash);
  }
}
