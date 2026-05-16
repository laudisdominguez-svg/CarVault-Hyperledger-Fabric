/*
 * AutoVault VIP — identity-cc
 * Chaincode de onboarding, identidad y perfiles VIP para Hyperledger Fabric
 *
 * Flujo de estados de un cliente:
 *
 *   PENDING_REVIEW → VISIT_SCHEDULED → APPROVED → WALLET_ISSUED → ACTIVE
 *                                    → REJECTED  (fin)
 *   ACTIVE → SUSPENDED → ACTIVE  (reactivación)
 *
 * Actores:
 *   Admin / Asesor (AutoVaultMSP): gestiona todo el ciclo de vida
 *   Cliente VIP (ClientesVIP MSP): solo puede actualizar su perfil anónimo
 *
 * Datos sensibles (nombre real, teléfono, dirección):
 *   NO se guardan en el ledger principal.
 *   Se usan Private Data Collections (PDC) — solo Admin + el propio cliente
 *   pueden leer esos datos. El hash de la PDC sí queda en el ledger público.
 *
 * El certificado X.509 lo emite la Fabric CA externamente (fuera del chaincode).
 *   Este chaincode registra el evento "wallet emitida" y el certificateHash
 *   como prueba inmutable de que se emitió.
 *
 * Requiere CouchDB como state database.
 */

import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import './fabric-types-extended';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const AUTOVAULT_MSP = 'AutoVaultMSP';
const CLIENTS_MSP   = 'ClientesVIPMSP';

/**
 * Nombre de la Private Data Collection definida en collections_config.json.
 * Solo los peers de AutoVaultMSP y ClientesVIPMSP tienen acceso a estos datos.
 */
const PDC_CLIENT_PII = 'AutoVaultClientPII';

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS DE DATOS
// ─────────────────────────────────────────────────────────────────────────────

type ClientStatus =
  | 'PENDING_REVIEW'    // solicitud recibida, admin aún no la revisó
  | 'VISIT_SCHEDULED'   // admin aprobó la solicitud y agendó la visita del asesor
  | 'APPROVED'          // asesor completó la visita y firmó la aprobación
  | 'WALLET_ISSUED'     // CA emitió el certificado X.509; cliente aún no activo
  | 'ACTIVE'            // cliente con acceso pleno a la plataforma
  | 'SUSPENDED'         // acceso suspendido por violación de contrato u otro motivo
  | 'REJECTED';         // solicitud rechazada en cualquier etapa

/**
 * ClientProfile: perfil público (anónimo) del cliente en el ledger principal.
 * Clave en el ledger: CLIENT_{clientProfileId}
 *
 * NUNCA contiene nombre real, teléfono, email ni dirección.
 * Esos datos van en la Private Data Collection (ver ClientPII más abajo).
 *
 * El anonimato es la promesa del contrato físico:
 * el cliente se identifica ante la red solo por su certificado X.509.
 */
interface ClientProfile {
  docType: 'clientProfile';

  /**
   * clientProfileId: ID interno generado por la app (ej: VIP-2025-001).
   * Es DISTINTO al ID X.509 del certificado Fabric.
   * El X.509 se guarda en walletCertificateHash una vez emitido.
   */
  clientProfileId: string;

  /**
   * alias: el único nombre visible públicamente del cliente.
   * No tiene que ser real. Ej: "RedFerrari", "Phantom42".
   * El cliente lo elige y puede cambiarlo si tiene status ACTIVE.
   */
  alias: string;

  /**
   * preferredLanguage: para notificaciones y UI.
   * 'ES' | 'EN'
   */
  preferredLanguage: string;

  // ── Onboarding ──
  status:          ClientStatus;
  advisorId:       string;   // ID del asesor que hizo la visita
  visitDate:       string;   // fecha de la visita física (ISO 8601)
  contractSignedAt: string;  // cuándo firmó el contrato físico (ISO 8601)

  /**
   * contractHash: SHA256 del contrato físico escaneado.
   * El PDF original vive en S3. El hash en el ledger prueba que existe
   * y que no ha sido alterado desde que el asesor lo escaneó.
   */
  contractHash: string;

  /**
   * walletCertificateHash: SHA256 del certificado X.509 emitido por la Fabric CA.
   * No es el certificado en sí (demasiado largo para el ledger).
   * Sirve como ancla de identidad: si alguien reclama ser este cliente,
   * el hash de su certificado debe coincidir con este campo.
   */
  walletCertificateHash: string;

  /**
   * fabricClientId: el ID X.509 completo del certificado del cliente
   * tal como lo retorna ctx.clientIdentity.getID() en Fabric.
   * Se guarda aquí para vincular el perfil con las transacciones firmadas
   * por ese certificado en car-cc, maintenance-cc y payment-cc.
   *
   * Ej: "x509::/C=MX/O=ClientesVIP/CN=VIP-2025-001::..."
   */
  fabricClientId: string;

  // ── Control de acceso ──
  suspensionReason: string;
  suspendedAt:      string;
  reactivatedAt:    string;
  rejectionReason:  string;

  // ── Auditoría ──
  appliedAt:   string;
  approvedAt:  string;
  activatedAt: string;
  rejectedAt:  string;
  updatedAt:   string;
  approvedBy:  string;  // ID del asesor que aprobó
  activatedBy: string;  // ID del admin que activó
}

/**
 * ClientPII: datos personales sensibles del cliente.
 * Se guarda EXCLUSIVAMENTE en la Private Data Collection (PDC).
 * La clave en la PDC es: CLIENT_PII_{clientProfileId}
 *
 * El ledger público solo ve el hash de estos datos (Fabric lo calcula
 * automáticamente al usar putPrivateData). Nadie más que AutoVaultMSP
 * y ClientesVIPMSP pueden acceder a estos datos crudos.
 */
interface ClientPII {
  clientProfileId: string;
  nombreCompleto:  string;
  telefono:        string;
  email:           string;
  // La dirección física del cliente para coordinar la visita del asesor
  // y los servicios de mantenimiento domiciliario.
  domicilioCalle:  string;
  domicilioCiudad: string;
  domicilioCP:     string;
  // Nota del asesor post-visita (privada, no visible al cliente)
  notasAsesor:     string;
  updatedAt:       string;
}

/**
 * AdvisorVisit: registro de la visita del asesor al domicilio del cliente.
 * Clave en el ledger: VISIT_{clientProfileId}
 *
 * Documenta que el asesor físicamente verificó los autos y obtuvo la firma.
 * Firmado por el asesor con su propio certificado X.509 al llamar ApproveClient().
 */
interface AdvisorVisit {
  docType:         'advisorVisit';
  clientProfileId: string;
  advisorId:       string;    // ID X.509 del asesor
  visitDate:       string;    // fecha real de la visita
  carsVerified:    number;    // cuántos autos confirmó el asesor físicamente
  contractSigned:  boolean;   // el cliente firmó el contrato físico
  contractHash:    string;    // SHA256 del contrato escaneado
  visitNotes:      string;    // resumen de la visita (no sensible)
  createdAt:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRATO
// ─────────────────────────────────────────────────────────────────────────────

@Info({
  title: 'IdentityContract',
  description: 'Onboarding, identidad y perfiles VIP — AutoVault',
})
export class IdentityContract extends Contract {

  @Transaction()
  public async InitLedger(ctx: Context): Promise<void> {
    console.info('=== IdentityContract inicializado correctamente ===');
  }

  // ─── PASO 1 ───────────────────────────────────────────────────────────────
  // PENDING_REVIEW: el admin registra la solicitud inicial del candidato
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * RegisterApplication — solo Admin / Asesor (AutoVaultMSP)
   *
   * El admin registra la solicitud de ingreso de un candidato VIP.
   * Los datos sensibles (nombre, teléfono, email, domicilio) se guardan
   * en la Private Data Collection — nunca en el ledger principal.
   *
   * El candidato aún NO tiene certificado Fabric en este punto.
   * El perfil queda en PENDING_REVIEW hasta que el admin lo revise y
   * agende la visita del asesor.
   *
   * @param clientProfileId  - ID único del perfil (generado por la app)
   * @param alias            - alias público elegido por el candidato
   * @param preferredLanguage - 'ES' o 'EN'
   *
   * Datos sensibles via transient data (nunca como parámetros directos):
   *   ctx.stub.getTransient() debe contener:
   *   {
   *     "pii": {
   *       "nombreCompleto": "...",
   *       "telefono": "...",
   *       "email": "...",
   *       "domicilioCalle": "...",
   *       "domicilioCiudad": "...",
   *       "domicilioCP": "..."
   *     }
   *   }
   *
   * IMPORTANTE: los datos sensibles DEBEN enviarse via transient data,
   * no como parámetros, para que no queden en el ledger ni en el bloque.
   */
  @Transaction()
  public async RegisterApplication(
    ctx:               Context,
    clientProfileId:   string,
    alias:             string,
    preferredLanguage: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    if (await this._profileExists(ctx, clientProfileId)) {
      throw new Error(`Ya existe un perfil con ID ${clientProfileId}.`);
    }

    // Leer datos sensibles del transient data map
    const transientData = ctx.stub.getTransient();
    if (!transientData || !transientData.get('pii')) {
      throw new Error(
        'Los datos personales (PII) deben enviarse via transient data ' +
        'con la clave "pii". No se recibieron.',
      );
    }

    const piiRaw = transientData.get('pii');
    if (!piiRaw) {
      throw new Error('Transient data "pii" está vacío.');
    }

    const piiInput = JSON.parse(Buffer.from(piiRaw).toString()) as Partial<ClientPII>;

    // Validar que vengan los campos mínimos
    const requiredFields = ['nombreCompleto', 'telefono', 'email', 'domicilioCalle', 'domicilioCiudad'];
    for (const field of requiredFields) {
      if (!(piiInput as any)[field]) {
        throw new Error(`Campo requerido en PII: ${field}`);
      }
    }

    const now = new Date().toISOString();

    // Guardar perfil público en el ledger principal (sin datos sensibles)
    const profile: ClientProfile = {
      docType:               'clientProfile',
      clientProfileId,
      alias,
      preferredLanguage:     preferredLanguage || 'ES',
      status:                'PENDING_REVIEW',
      advisorId:             '',
      visitDate:             '',
      contractSignedAt:      '',
      contractHash:          '',
      walletCertificateHash: '',
      fabricClientId:        '',
      suspensionReason:      '',
      suspendedAt:           '',
      reactivatedAt:         '',
      rejectionReason:       '',
      appliedAt:             now,
      approvedAt:            '',
      activatedAt:           '',
      rejectedAt:            '',
      updatedAt:             now,
      approvedBy:            '',
      activatedBy:           '',
    };

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    // Guardar datos sensibles en la Private Data Collection
    const pii: ClientPII = {
      clientProfileId,
      nombreCompleto:  piiInput.nombreCompleto!,
      telefono:        piiInput.telefono!,
      email:           piiInput.email!,
      domicilioCalle:  piiInput.domicilioCalle!,
      domicilioCiudad: piiInput.domicilioCiudad!,
      domicilioCP:     piiInput.domicilioCP || '',
      notasAsesor:     '',
      updatedAt:       now,
    };

    await ctx.stub.putPrivateData(
      PDC_CLIENT_PII,
      `CLIENT_PII_${clientProfileId}`,
      Buffer.from(JSON.stringify(pii)),
    );

    ctx.stub.setEvent(
      'ClientApplied',
      Buffer.from(JSON.stringify({
        clientProfileId,
        alias,
        appliedAt: now,
      })),
    );

    console.info(`Solicitud ${clientProfileId} registrada. Estado: PENDING_REVIEW`);
    return JSON.stringify(profile);
  }

  // ─── PASO 2 ───────────────────────────────────────────────────────────────
  // VISIT_SCHEDULED: admin agenda la visita del asesor
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ScheduleVisit — solo Admin (AutoVaultMSP)
   *
   * El admin revisó la solicitud y la considera prometedora.
   * Asigna un asesor y una fecha de visita al domicilio del candidato.
   *
   * @param clientProfileId - ID del perfil
   * @param advisorId       - ID X.509 del asesor asignado
   * @param visitDate       - fecha de la visita (ISO 8601)
   */
  @Transaction()
  public async ScheduleVisit(
    ctx:              Context,
    clientProfileId:  string,
    advisorId:        string,
    visitDate:        string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertProfileStatus(profile, ['PENDING_REVIEW'], 'ScheduleVisit');

    profile.status     = 'VISIT_SCHEDULED';
    profile.advisorId  = advisorId;
    profile.visitDate  = visitDate;
    profile.updatedAt  = new Date().toISOString();

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    ctx.stub.setEvent(
      'VisitScheduled',
      Buffer.from(JSON.stringify({
        clientProfileId,
        advisorId,
        visitDate,
      })),
    );

    return JSON.stringify(profile);
  }

  // ─── PASO 3A ──────────────────────────────────────────────────────────────
  // APPROVED: el asesor completa la visita y aprueba al candidato
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ApproveClient — Admin o Asesor (AutoVaultMSP)
   *
   * El asesor regresa de la visita domiciliaria con:
   *   · Confirmación de que los autos existen físicamente
   *   · El contrato físico firmado (escaneado → hash)
   *   · Sus notas de la visita
   *
   * Esta función:
   *   1. Registra el acta de visita (AdvisorVisit) en el ledger
   *   2. Actualiza el contractHash en el perfil
   *   3. Guarda las notas del asesor en la PDC (privadas)
   *   4. Mueve el estado a APPROVED
   *
   * El asesor firma esta transacción con su propio certificado X.509,
   * por lo que queda evidencia inmutable de quién aprobó y cuándo.
   *
   * @param clientProfileId - ID del perfil
   * @param carsVerified    - cantidad de autos confirmados físicamente
   * @param contractHash    - SHA256 del contrato físico escaneado
   * @param visitNotes      - resumen no sensible de la visita (queda en ledger público)
   * @param visitDate       - fecha real de la visita (puede diferir de la agendada)
   *
   * Transient data (clave "advisorNotes"):
   *   { "notasAsesor": "..." }  — notas privadas, van a la PDC
   */
  @Transaction()
  public async ApproveClient(
    ctx:              Context,
    clientProfileId:  string,
    carsVerified:     string,
    contractHash:     string,
    visitNotes:       string,
    visitDate:        string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertProfileStatus(profile, ['VISIT_SCHEDULED'], 'ApproveClient');

    const advisorId = ctx.clientIdentity.getID();
    const now       = new Date().toISOString();

    // Registrar el acta de visita en el ledger (inmutable)
    const visit: AdvisorVisit = {
      docType:         'advisorVisit',
      clientProfileId,
      advisorId,
      visitDate:       visitDate || profile.visitDate,
      carsVerified:    parseInt(carsVerified, 10),
      contractSigned:  true,  // si llama esta función, el contrato fue firmado
      contractHash,
      visitNotes,
      createdAt:       now,
    };

    await ctx.stub.putState(
      `VISIT_${clientProfileId}`,
      Buffer.from(JSON.stringify(visit)),
    );

    // Actualizar notas privadas del asesor en la PDC (si vienen en transient)
    const transientData = ctx.stub.getTransient();
    const advisorNotesRaw = transientData?.get('advisorNotes');
    if (advisorNotesRaw) {
      const { notasAsesor } = JSON.parse(Buffer.from(advisorNotesRaw).toString());

      // Leer PII actual y actualizar solo las notas
      const piiBytes = await ctx.stub.getPrivateData(
        PDC_CLIENT_PII,
        `CLIENT_PII_${clientProfileId}`,
      );
      if (piiBytes && piiBytes.length > 0) {
        const pii: ClientPII = JSON.parse(piiBytes.toString());
        pii.notasAsesor = notasAsesor || '';
        pii.updatedAt   = now;
        await ctx.stub.putPrivateData(
          PDC_CLIENT_PII,
          `CLIENT_PII_${clientProfileId}`,
          Buffer.from(JSON.stringify(pii)),
        );
      }
    }

    // Actualizar perfil
    profile.status           = 'APPROVED';
    profile.advisorId        = advisorId;
    profile.visitDate        = visit.visitDate;
    profile.contractSignedAt = now;
    profile.contractHash     = contractHash;
    profile.approvedAt       = now;
    profile.approvedBy       = advisorId;
    profile.updatedAt        = now;

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    ctx.stub.setEvent(
      'ClientApproved',
      Buffer.from(JSON.stringify({
        clientProfileId,
        advisorId,
        carsVerified: parseInt(carsVerified, 10),
        approvedAt:   now,
      })),
    );

    console.info(`Cliente ${clientProfileId} APROBADO por asesor ${advisorId}. Autos confirmados: ${carsVerified}`);
    return JSON.stringify({ profile, visit });
  }

  // ─── PASO 3B ──────────────────────────────────────────────────────────────
  // REJECTED: rechazo en cualquier etapa previa a APPROVED
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * RejectClient — solo Admin (AutoVaultMSP)
   *
   * El admin rechaza la solicitud. Puede suceder desde PENDING_REVIEW
   * o VISIT_SCHEDULED (ej: el asesor no pudo confirmar los autos,
   * el candidato no cumple los requisitos, etc.).
   *
   * @param clientProfileId - ID del perfil
   * @param reason          - motivo del rechazo (queda en el ledger)
   */
  @Transaction()
  public async RejectClient(
    ctx:              Context,
    clientProfileId:  string,
    reason:           string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertProfileStatus(
      profile,
      ['PENDING_REVIEW', 'VISIT_SCHEDULED'],
      'RejectClient',
    );

    const now = new Date().toISOString();

    profile.status          = 'REJECTED';
    profile.rejectionReason = reason;
    profile.rejectedAt      = now;
    profile.updatedAt       = now;

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    ctx.stub.setEvent(
      'ClientRejected',
      Buffer.from(JSON.stringify({
        clientProfileId,
        reason,
        rejectedAt: now,
      })),
    );

    return JSON.stringify(profile);
  }

  // ─── PASO 4 ───────────────────────────────────────────────────────────────
  // WALLET_ISSUED: admin registra que la CA emitió el certificado X.509
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * IssueWallet — solo Admin (AutoVaultMSP)
   *
   * CONTEXTO IMPORTANTE:
   * La Fabric CA emite el certificado X.509 FUERA de este chaincode,
   * usando el comando:
   *   fabric-ca-client enroll -u https://user:password@ca.autovault.com:7054
   *
   * Una vez que la CA emitió el certificado, el admin llama a esta función
   * para registrar en el ledger:
   *   1. El hash del certificado emitido (prueba de emisión)
   *   2. El fabricClientId (el ID X.509 del cliente, tal como Fabric lo conoce)
   *
   * Después de esto, el cliente puede hacer transacciones en la red
   * firmadas con su certificado.
   *
   * @param clientProfileId     - ID del perfil
   * @param fabricClientId      - ID X.509 completo del certificado emitido
   * @param walletCertificateHash - SHA256 del certificado .pem emitido
   */
  @Transaction()
  public async IssueWallet(
    ctx:                   Context,
    clientProfileId:       string,
    fabricClientId:        string,
    walletCertificateHash: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertProfileStatus(profile, ['APPROVED'], 'IssueWallet');

    // Verificar que ese fabricClientId no esté ya en uso por otro perfil
    await this._assertFabricIdUnique(ctx, fabricClientId, clientProfileId);

    const now = new Date().toISOString();

    profile.status                = 'WALLET_ISSUED';
    profile.fabricClientId        = fabricClientId;
    profile.walletCertificateHash = walletCertificateHash;
    profile.updatedAt             = now;

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    // Índice compuesto para buscar perfiles por fabricClientId
    // Permite encontrar el perfil VIP dado el ID X.509 de Fabric
    const indexKey = await ctx.stub.createCompositeKey(
      'fabricId~profileId',
      [fabricClientId, clientProfileId],
    );
    await ctx.stub.putState(indexKey, Buffer.from('\u0000'));

    ctx.stub.setEvent(
      'WalletIssued',
      Buffer.from(JSON.stringify({
        clientProfileId,
        fabricClientId,
        walletCertificateHash,
        issuedAt: now,
      })),
    );

    console.info(`Wallet emitida para ${clientProfileId} → fabricClientId: ${fabricClientId}`);
    return JSON.stringify(profile);
  }

  // ─── PASO 5 ───────────────────────────────────────────────────────────────
  // ACTIVE: admin activa el acceso pleno del cliente
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ActivateClient — solo Admin (AutoVaultMSP)
   *
   * El último paso del onboarding. El admin confirma que:
   *   · El certificado X.509 fue entregado al cliente
   *   · El cliente guardó su clave privada de forma segura
   *   · La suscripción anual fue pagada (payment-cc la gestiona aparte)
   *
   * Después de esto el cliente puede:
   *   · Registrar sus autos (car-cc)
   *   · Solicitar servicios de mantenimiento (maintenance-cc)
   *   · Ver su historial de pagos (payment-cc)
   *
   * @param clientProfileId - ID del perfil a activar
   */
  @Transaction()
  public async ActivateClient(
    ctx:              Context,
    clientProfileId:  string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertProfileStatus(profile, ['WALLET_ISSUED'], 'ActivateClient');

    const now = new Date().toISOString();

    profile.status      = 'ACTIVE';
    profile.activatedAt = now;
    profile.activatedBy = ctx.clientIdentity.getID();
    profile.updatedAt   = now;

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    ctx.stub.setEvent(
      'ClientActivated',
      Buffer.from(JSON.stringify({
        clientProfileId,
        fabricClientId: profile.fabricClientId,
        alias:          profile.alias,
        activatedAt:    now,
      })),
    );

    console.info(`Cliente ${clientProfileId} (${profile.alias}) ACTIVO en la plataforma`);
    return JSON.stringify(profile);
  }

  // ─── SUSPENSIÓN Y REACTIVACIÓN ────────────────────────────────────────────

  /**
   * SuspendClient — solo Admin (AutoVaultMSP)
   *
   * Suspende el acceso de un cliente activo.
   * Motivos comunes:
   *   · Compartió sus claves privadas (violación del contrato)
   *   · Publicó información falsa sobre sus autos
   *   · Suscripción vencida y no renovada
   *
   * La suspensión revoca el acceso lógicamente en esta app,
   * pero revocar el certificado X.509 en la Fabric CA debe hacerse
   * por separado con: fabric-ca-client revoke
   *
   * @param clientProfileId  - ID del perfil
   * @param reason           - motivo de la suspensión
   */
  @Transaction()
  public async SuspendClient(
    ctx:              Context,
    clientProfileId:  string,
    reason:           string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertProfileStatus(profile, ['ACTIVE'], 'SuspendClient');

    const now = new Date().toISOString();

    profile.status           = 'SUSPENDED';
    profile.suspensionReason = reason;
    profile.suspendedAt      = now;
    profile.updatedAt        = now;

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    ctx.stub.setEvent(
      'ClientSuspended',
      Buffer.from(JSON.stringify({
        clientProfileId,
        reason,
        suspendedAt: now,
      })),
    );

    return JSON.stringify(profile);
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ReactivateClient — solo Admin (AutoVaultMSP)
   *
   * Reactiva un cliente suspendido una vez que se resolvió la causa.
   *
   * @param clientProfileId - ID del perfil a reactivar
   */
  @Transaction()
  public async ReactivateClient(
    ctx:              Context,
    clientProfileId:  string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertProfileStatus(profile, ['SUSPENDED'], 'ReactivateClient');

    const now = new Date().toISOString();

    profile.status           = 'ACTIVE';
    profile.suspensionReason = '';
    profile.reactivatedAt    = now;
    profile.updatedAt        = now;

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    ctx.stub.setEvent(
      'ClientReactivated',
      Buffer.from(JSON.stringify({
        clientProfileId,
        reactivatedAt: now,
      })),
    );

    return JSON.stringify(profile);
  }

  // ─── PERFIL ANÓNIMO ───────────────────────────────────────────────────────

  /**
   * UpdateAnonymousProfile — Admin o el propio cliente (ACTIVE)
   *
   * El cliente puede actualizar su alias y preferencias de idioma.
   * NADA MÁS. No puede cambiar su fabricClientId, contractHash,
   * ni ningún campo de auditoría.
   *
   * El cliente firmó en el contrato físico la obligación de mantener
   * su perfil anónimo: no puede revelar su identidad real en estos campos.
   *
   * @param clientProfileId  - ID del perfil
   * @param newAlias         - nuevo alias público (vacío para no cambiar)
   * @param preferredLanguage - 'ES' o 'EN' (vacío para no cambiar)
   */
  @Transaction()
  public async UpdateAnonymousProfile(
    ctx:               Context,
    clientProfileId:   string,
    newAlias:          string,
    preferredLanguage: string,
  ): Promise<string> {

    const profile = await this._getProfile(ctx, clientProfileId);

    // Solo el propio cliente o el admin pueden actualizar el perfil
    this._assertOwnerOrAdmin(ctx, profile.fabricClientId);

    // Solo un cliente ACTIVE puede actualizar su propio perfil
    if (!this._isAdmin(ctx) && profile.status !== 'ACTIVE') {
      throw new Error(
        `Solo puedes actualizar tu perfil cuando tu estado es ACTIVE. ` +
        `Estado actual: ${profile.status}.`,
      );
    }

    if (newAlias)          profile.alias              = newAlias;
    if (preferredLanguage) profile.preferredLanguage  = preferredLanguage;
    profile.updatedAt = new Date().toISOString();

    await ctx.stub.putState(
      `CLIENT_${clientProfileId}`,
      Buffer.from(JSON.stringify(profile)),
    );

    return JSON.stringify(profile);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUERIES (solo lectura)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GetClientProfile — Admin o el propio cliente
   *
   * Retorna el perfil público (sin datos PII).
   * Los datos sensibles están en la PDC y se consultan con GetClientPII().
   */
  @Transaction(false)
  @Returns('string')
  public async GetClientProfile(
    ctx:              Context,
    clientProfileId:  string,
  ): Promise<string> {

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertOwnerOrAdmin(ctx, profile.fabricClientId);
    return JSON.stringify(profile);
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GetClientPII — Admin o el propio cliente
   *
   * Lee los datos sensibles desde la Private Data Collection.
   * Solo funciona si el peer del invocador tiene acceso a PDC_CLIENT_PII.
   * Los peers de otras organizaciones no pueden leer este dato.
   */
  @Transaction(false)
  @Returns('string')
  public async GetClientPII(
    ctx:              Context,
    clientProfileId:  string,
  ): Promise<string> {

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertOwnerOrAdmin(ctx, profile.fabricClientId);

    const piiBytes = await ctx.stub.getPrivateData(
      PDC_CLIENT_PII,
      `CLIENT_PII_${clientProfileId}`,
    );

    if (!piiBytes || piiBytes.length === 0) {
      throw new Error(`No se encontraron datos PII para el perfil ${clientProfileId}.`);
    }

    return piiBytes.toString();
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GetAdvisorVisit — Admin o el propio cliente
   *
   * Retorna el acta de visita del asesor para un cliente.
   */
  @Transaction(false)
  @Returns('string')
  public async GetAdvisorVisit(
    ctx:              Context,
    clientProfileId:  string,
  ): Promise<string> {

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertOwnerOrAdmin(ctx, profile.fabricClientId);

    const visitBytes = await ctx.stub.getState(`VISIT_${clientProfileId}`);
    if (!visitBytes || visitBytes.length === 0) {
      throw new Error(
        `No existe acta de visita para el perfil ${clientProfileId}. ` +
        `La visita aún no fue completada.`,
      );
    }

    return visitBytes.toString();
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GetProfileByFabricId — solo Admin
   *
   * Dado el fabricClientId (ID X.509 de Fabric), encuentra el perfil VIP.
   * Útil para que el admin identifique a qué perfil pertenece una transacción
   * cuando revisa el ledger.
   *
   * Usa el índice compuesto creado en IssueWallet().
   */
  @Transaction(false)
  @Returns('string')
  public async GetProfileByFabricId(
    ctx:           Context,
    fabricClientId: string,
  ): Promise<string> {

    this._assertAdmin(ctx);

    const iterator = await ctx.stub.getStateByPartialCompositeKey(
      'fabricId~profileId',
      [fabricClientId],
    );

    for await (const result of iterator) {
      const [, , profileId] = ctx.stub.splitCompositeKey(result.key);
      const profileBytes    = await ctx.stub.getState(`CLIENT_${profileId}`);
      if (profileBytes && profileBytes.length > 0) {
        return profileBytes.toString();
      }
    }

    throw new Error(`No se encontró perfil para el fabricClientId: ${fabricClientId}`);
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GetPendingApplications — solo Admin
   *
   * Retorna todos los candidatos en PENDING_REVIEW o VISIT_SCHEDULED.
   * Panel de control del admin para gestionar el pipeline de onboarding.
   */
  @Transaction(false)
  @Returns('string')
  public async GetPendingApplications(ctx: Context): Promise<string> {
    this._assertAdmin(ctx);

    const queryString = JSON.stringify({
      selector: {
        docType: 'clientProfile',
        status:  { $in: ['PENDING_REVIEW', 'VISIT_SCHEDULED'] },
      },
      sort: [{ appliedAt: 'asc' }],
    });

    const iterator = await ctx.stub.getQueryResult(queryString);
    const results: ClientProfile[] = [];
    for await (const result of iterator) {
      results.push(JSON.parse(result.value.toString()));
    }

    return JSON.stringify(results);
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GetClientHistory — Admin o el propio cliente
   *
   * Historial inmutable completo del perfil: cada cambio de estado
   * con txId, actor y timestamp. Evidencia de todo el proceso de onboarding.
   */
  @Transaction(false)
  @Returns('string')
  public async GetClientHistory(
    ctx:              Context,
    clientProfileId:  string,
  ): Promise<string> {

    const profile = await this._getProfile(ctx, clientProfileId);
    this._assertOwnerOrAdmin(ctx, profile.fabricClientId);

    const historyIterator = await ctx.stub.getHistoryForKey(`CLIENT_${clientProfileId}`);
    const history: object[] = [];

    for await (const modification of historyIterator) {
      const entry: any = {
        txId:      modification.txId,
        timestamp: modification.timestamp,
        isDelete:  modification.isDelete,
      };
      if (!modification.isDelete && modification.value) {
        const value: any = JSON.parse(modification.value.toString());
        // Nunca exponer datos sensibles — van en la PDC
        entry.value = value;
      }
      history.push(entry);
    }

    return JSON.stringify(history);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MÉTODOS PRIVADOS DE APOYO
  // ─────────────────────────────────────────────────────────────────────────

  private _assertAdmin(ctx: Context): void {
    if (ctx.clientIdentity.getMSPID() !== AUTOVAULT_MSP) {
      throw new Error(
        `Acceso denegado. Función reservada para ${AUTOVAULT_MSP}. ` +
        `Tu MSP: ${ctx.clientIdentity.getMSPID()}.`,
      );
    }
  }

  private _isAdmin(ctx: Context): boolean {
    return ctx.clientIdentity.getMSPID() === AUTOVAULT_MSP;
  }

  private _assertOwnerOrAdmin(ctx: Context, fabricClientId: string): void {
    if (this._isAdmin(ctx)) return;
    // El cliente se identifica con su fabricClientId en el certificado X.509
    if (ctx.clientIdentity.getID() !== fabricClientId) {
      throw new Error('Acceso denegado: solo puedes consultar tu propio perfil.');
    }
  }

  private async _getProfile(
    ctx:              Context,
    clientProfileId:  string,
  ): Promise<ClientProfile> {
    const bytes = await ctx.stub.getState(`CLIENT_${clientProfileId}`);
    if (!bytes || bytes.length === 0) {
      throw new Error(`El perfil ${clientProfileId} no existe en el ledger.`);
    }
    return JSON.parse(bytes.toString()) as ClientProfile;
  }

  private async _profileExists(ctx: Context, clientProfileId: string): Promise<boolean> {
    const bytes = await ctx.stub.getState(`CLIENT_${clientProfileId}`);
    return bytes !== null && bytes.length > 0;
  }

  private _assertProfileStatus(
    profile:         ClientProfile,
    allowedStatuses: ClientStatus[],
    functionName:    string,
  ): void {
    if (!allowedStatuses.includes(profile.status)) {
      throw new Error(
        `${functionName}() requiere status: [${allowedStatuses.join(' | ')}]. ` +
        `Estado actual del perfil ${profile.clientProfileId}: ${profile.status}.`,
      );
    }
  }

  /**
   * Verifica que el fabricClientId no esté ya asociado a otro perfil.
   * Un certificado X.509 solo puede pertenecer a un perfil VIP.
   */
  private async _assertFabricIdUnique(
    ctx:              Context,
    fabricClientId:   string,
    currentProfileId: string,
  ): Promise<void> {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(
      'fabricId~profileId',
      [fabricClientId],
    );
    for await (const result of iterator) {
      const [, , profileId] = ctx.stub.splitCompositeKey(result.key);
      if (profileId !== currentProfileId) {
        throw new Error(
          `El fabricClientId ${fabricClientId} ya está asociado al perfil ${profileId}. ` +
          `Un certificado X.509 solo puede pertenecer a un perfil VIP.`,
        );
      }
    }
  }
}
