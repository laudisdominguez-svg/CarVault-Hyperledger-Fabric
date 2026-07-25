/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  CARVAULT VIP - SERVIDOR EXPRESS COMPLETO CON TODOS LOS ENDPOINTS       ║
 * ║  Backend REST API para Dashboard React + MySQL + Hyperledger Fabric     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import dotenv from 'dotenv';
import { authenticateToken, authorizeRoles, loginUser, registerUser, issueVerifiableCredential, verifyVerifiableCredential, AuthUser } from './src/auth.js';
import { pool as dbPool, query } from './src/db.js';
import { getFabricClient, invokeCarCC, invokeIdentityCC, invokePaymentCC, invokeMaintenanceCC } from './src/fabric-client.js';

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN BÁSICA
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = process.env.HOST || "0.0.0.0";

// MySQL Connection Pool
const mysqlPool = dbPool as any;

mysqlPool.on("error", (err: Error) => {
  console.error("❌ Error en conexión MySQL:", err.message);
});
let fabricStatus = {
  ready: false,
  message: "Fabric SDK aún no inicializado",
};
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════

async function startServer() {
  const app = express();

  // Middleware
  app.use(express.json());

  try {
    await getFabricClient();
    fabricStatus.ready = true;
    fabricStatus.message = "Fabric SDK conectado";
  } catch (error: any) {
    fabricStatus.message = `Error de conexión a Fabric: ${error.message}`;
    console.warn("⚠️ Fabric SDK no disponible:", error.message);
  }

  // Logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ENDPOINT: HEALTH CHECK
  // ═════════════════════════════════════════════════════════════════════════

  app.get("/api/health", async (req: Request, res: Response) => {
    try {
      await query("SELECT NOW()");
      res.json({
        status: "HEALTHY",
        timestamp: new Date().toISOString(),
        services: {
          server: "OK",
          mysql: "OK",
          fabric: fabricStatus.ready ? "OK" : "UNAVAILABLE",
          fabricStatus: fabricStatus.message,
        },
      });
    } catch (error: any) {
      res.status(500).json({ status: "UNHEALTHY", error: error.message });
    }
  });

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const { email, password, displayName, role, ownerId } = req.body;
      if (!email || !password || !displayName) {
        return res.status(400).json({
          error: "Campos requeridos: email, password, displayName",
        });
      }

      const { token, user } = await registerUser({
        email,
        password,
        displayName,
        role,
        ownerId,
      });

      res.status(201).json({ success: true, token, user });
    } catch (error: any) {
      console.error("❌ Error POST /api/auth/register:", error.message);
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({
          error: "Campos requeridos: email, password",
        });
      }

      const { token, user } = await loginUser(email, password);
      res.json({ success: true, token, user });
    } catch (error: any) {
      console.error("❌ Error POST /api/auth/login:", error.message);
      res.status(401).json({ error: error.message });
    }
  });

  app.get("/api/auth/me", authenticateToken, async (req: Request, res: Response) => {
    const user = (req as Request & { user?: AuthUser }).user;
    res.json({ success: true, user });
  });

  app.post("/api/auth/credentials/issue", authenticateToken, async (req: Request, res: Response) => {
    try {
      const user = (req as Request & { user?: AuthUser }).user;
      if (!user) {
        return res.status(401).json({ error: "Usuario no autenticado." });
      }

      const credential = issueVerifiableCredential(user);
      res.json({ success: true, credential });
    } catch (error: any) {
      console.error("❌ Error POST /api/auth/credentials/issue:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/auth/credentials/verify", authenticateToken, async (req: Request, res: Response) => {
    try {
      const { credential } = req.body;
      if (!credential) {
        return res.status(400).json({ error: "Campo requerido: credential" });
      }

      const verified = verifyVerifiableCredential(credential);
      res.json({ success: true, verified });
    } catch (error: any) {
      console.error("❌ Error POST /api/auth/credentials/verify:", error.message);
      res.status(400).json({ error: error.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ENDPOINTS: VEHÍCULOS (car-cc)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/vehicles/register
   * Registrar nuevo vehículo
   */
  app.post("/api/vehicles/register", authenticateToken, authorizeRoles(['VIP_OWNER', 'FLEET_MANAGER']), async (req: Request, res: Response) => {
    try {
      const { vin, marca, modelo, anio, clientId } = req.body;

      if (!vin || !marca || !modelo || !anio || !clientId) {
        return res.status(400).json({
          error: "Campos requeridos: vin, marca, modelo, anio, clientId",
        });
      }

      const carId = `CAR_${uuidv4().slice(0, 8)}`;

      // Invocar blockchain
      const fabricResult = await invokeCarCC(
        "RegisterCar",
        [carId, vin, marca, modelo, anio.toString(), clientId, new Date().toISOString()]
      );

      if (fabricResult.success) {
        // Guardar en MySQL
        try {
          await mysqlPool.execute(
            `INSERT INTO vehicles (car_id, vin, marca, modelo, anio, client_id, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [carId, vin, marca, modelo, anio, clientId, "ACTIVE", new Date()]
          );
        } catch (dbError: any) {
          console.warn("⚠️ BD no disponible, usando solo Fabric:", dbError.message);
        }

        res.status(201).json({
          success: true,
          carId,
          txId: fabricResult.txId,
          message: "✅ Vehículo registrado exitosamente",
        });
      } else {
        res.status(500).json({ success: false, error: fabricResult.error });
      }
    } catch (error: any) {
      console.error("❌ Error POST /api/vehicles/register:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/vehicles/client/:clientId
   * Consultar vehículos de un cliente
   */
  app.get("/api/vehicles/client/:clientId", authenticateToken, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      try {
        const vehicles = await query<any[]>(
          "SELECT * FROM vehicles WHERE client_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
          [clientId]
        );

        res.json({
          success: true,
          count: vehicles.length,
          vehicles,
        });
      } catch (dbError: any) {
        console.warn("⚠️ BD no disponible, retornando datos simulados");
        res.json({
          success: true,
          count: 0,
          vehicles: [],
          note: "Base de datos no inicializada. Ejecuta: npm run db:init",
        });
      }
    } catch (error: any) {
      console.error("❌ Error GET /api/vehicles/client/:clientId:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ENDPOINTS: CLIENTES (identity-cc)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/clients/onboard
   * Onboarding de nuevo cliente
   */
  app.post("/api/clients/onboard", authenticateToken, authorizeRoles(['VIP_OWNER', 'FLEET_MANAGER']), async (req: Request, res: Response) => {
    try {
      const { alias, nombre, email, telefono } = req.body;

      if (!alias || !nombre || !email) {
        return res.status(400).json({
          error: "Campos requeridos: alias, nombre, email",
        });
      }

      const clientProfileId = `VIP_${uuidv4().slice(0, 8)}`;
      const clientId = `CLIENT_${uuidv4().slice(0, 8)}`;

      // Invocar blockchain
      const fabricResult = await invokeIdentityCC(
        "OnboardClient",
        [clientProfileId, clientId, alias, "PENDING_REVIEW", new Date().toISOString()]
      );

      if (fabricResult.success) {
        // Guardar en MySQL
        try {
          await mysqlPool.execute(
            `INSERT INTO clients (client_id, client_profile_id, alias, nombre, email, telefono, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [clientId, clientProfileId, alias, nombre, email, telefono || null, "PENDING_REVIEW", new Date()]
          );
        } catch (dbError: any) {
          console.warn("⚠️ BD no disponible:", dbError.message);
        }

        res.status(201).json({
          success: true,
          clientProfileId,
          clientId,
          status: "PENDING_REVIEW",
          txId: fabricResult.txId,
          message: "✅ Cliente onboarded exitosamente",
        });
      } else {
        res.status(500).json({ success: false, error: fabricResult.error });
      }
    } catch (error: any) {
      console.error("❌ Error POST /api/clients/onboard:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/clients/:clientId
   * Obtener perfil del cliente
   */
  app.get("/api/clients/:clientId", authenticateToken, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      try {
        const clients = await query<any[]>("SELECT * FROM clients WHERE client_id = ?", [clientId]);

        if (clients.length === 0) {
          return res.status(404).json({ error: "Cliente no encontrado" });
        }

        res.json({
          success: true,
          client: clients[0],
        });
      } catch (dbError: any) {
        console.warn("⚠️ BD no disponible");
        res.json({
          success: true,
          client: { clientId, status: "MOCK_DATA" },
          note: "Base de datos no inicializada",
        });
      }
    } catch (error: any) {
      console.error("❌ Error GET /api/clients/:clientId:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ENDPOINTS: PAGOS (payment-cc)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/payments/subscribe
   * Crear suscripción de pago
   */
  app.post("/api/payments/subscribe", authenticateToken, authorizeRoles(['VIP_OWNER', 'FLEET_MANAGER']), async (req: Request, res: Response) => {
    try {
      const { clientId, plan, amount, currency } = req.body;

      if (!clientId || !plan || !amount) {
        return res.status(400).json({
          error: "Campos requeridos: clientId, plan, amount",
        });
      }

      const validPlans = ["SILVER", "GOLD", "PLATINUM"];
      if (!validPlans.includes(plan)) {
        return res.status(400).json({
          error: `Plan inválido. Válidos: ${validPlans.join(", ")}`,
        });
      }

      const subscriptionId = `SUB_${uuidv4().slice(0, 8)}`;

      // Invocar blockchain
      const fabricResult = await invokePaymentCC(
        "CreateSubscription",
        [subscriptionId, clientId, plan, amount.toString(), currency || "USD"]
      );

      if (fabricResult.success) {
        // Guardar en MySQL
        const planDays = {
          SILVER: 30,
          GOLD: 90,
          PLATINUM: 365,
        };
        const startDate = new Date();
        const endDate = new Date(startDate.getTime() + (planDays[plan as keyof typeof planDays] || 30) * 24 * 60 * 60 * 1000);

        try {
          await mysqlPool.execute(
            `INSERT INTO subscriptions (subscription_id, client_id, plan, amount, currency, status, start_date, end_date, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [subscriptionId, clientId, plan, amount, currency || "USD", "ACTIVE", startDate, endDate, new Date()]
          );
        } catch (dbError: any) {
          console.warn("⚠️ BD no disponible:", dbError.message);
        }

        res.status(201).json({
          success: true,
          subscriptionId,
          plan,
          amount,
          currency: currency || "USD",
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          txId: fabricResult.txId,
          message: "✅ Suscripción creada exitosamente",
        });
      } else {
        res.status(500).json({ success: false, error: fabricResult.error });
      }
    } catch (error: any) {
      console.error("❌ Error POST /api/payments/subscribe:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/payments/subscriptions/:clientId
   * Obtener suscripciones del cliente
   */
  app.get("/api/payments/subscriptions/:clientId", authenticateToken, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      try {
        const subscriptions = await query<any[]>(
          "SELECT * FROM subscriptions WHERE client_id = ? ORDER BY created_at DESC",
          [clientId]
        );

        res.json({
          success: true,
          subscriptions,
        });
      } catch (dbError: any) {
        console.warn("⚠️ BD no disponible");
        res.json({
          success: true,
          subscriptions: [],
          note: "Base de datos no inicializada",
        });
      }
    } catch (error: any) {
      console.error("❌ Error GET /api/payments/subscriptions/:clientId:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ENDPOINTS: SERVICIOS (maintenance-cc)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/services/create
   * Crear orden de servicio
   */
  app.post("/api/services/create", authenticateToken, authorizeRoles(['VIP_OWNER', 'FLEET_MANAGER']), async (req: Request, res: Response) => {
    try {
      const { carId, clientId, serviceType, description } = req.body;

      if (!carId || !clientId || !serviceType) {
        return res.status(400).json({
          error: "Campos requeridos: carId, clientId, serviceType",
        });
      }

      const serviceOrderId = `SRV_${uuidv4().slice(0, 8)}`;

      // Invocar blockchain
      const fabricResult = await invokeMaintenanceCC(
        "CreateServiceOrder",
        [serviceOrderId, carId, clientId, serviceType, description || "", new Date().toISOString()]
      );

      if (fabricResult.success) {
        // Guardar en MySQL
        try {
          await mysqlPool.execute(
            `INSERT INTO service_orders (service_order_id, car_id, client_id, service_type, description, status, requested_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [serviceOrderId, carId, clientId, serviceType, description || null, "REQUESTED", new Date(), new Date()]
          );
        } catch (dbError: any) {
          console.warn("⚠️ BD no disponible:", dbError.message);
        }

        res.status(201).json({
          success: true,
          serviceOrderId,
          status: "REQUESTED",
          txId: fabricResult.txId,
          message: "✅ Orden de servicio creada exitosamente",
        });
      } else {
        res.status(500).json({ success: false, error: fabricResult.error });
      }
    } catch (error: any) {
      console.error("❌ Error POST /api/services/create:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/services/client/:clientId
   * Obtener órdenes de servicio del cliente
   */
  app.get("/api/services/client/:clientId", authenticateToken, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      try {
        const serviceOrders = await query<any[]>(
          "SELECT * FROM service_orders WHERE client_id = ? ORDER BY requested_at DESC",
          [clientId]
        );

        res.json({
          success: true,
          serviceOrders,
        });
      } catch (dbError: any) {
        console.warn("⚠️ BD no disponible");
        res.json({
          success: true,
          serviceOrders: [],
          note: "Base de datos no inicializada",
        });
      }
    } catch (error: any) {
      console.error("❌ Error GET /api/services/client/:clientId:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ENDPOINTS: UTILIDAD
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/architect/chat
   * Chat con AI para consultoría técnica
   */
  app.post("/api/architect/chat", async (req: Request, res: Response) => {
    try {
      const { prompt } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: "Campo requerido: prompt" });
      }

      // Respuesta simulada (TODO: Conectar con Gemini real)
      res.json({
        text: `📚 Respuesta sobre: "${prompt}"\n\n✅ Recomendación arquitectónica:\n- Implementar validación en todos los endpoints\n- Usar transactions en blockchain\n- Cachear datos frecuentes\n- Monitorear performance en producción`,
        simulated: true,
      });
    } catch (error: any) {
      console.error("❌ Error POST /api/architect/chat:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/architect/explain-sim
   * Simulación de EXPLAIN PLAN SQL
   */
  app.post("/api/architect/explain-sim", async (req: Request, res: Response) => {
    try {
      const { queryId } = req.body || "default";

      const plans: Record<string, any> = {
        vehicles_by_client: {
          query: "SELECT * FROM vehicles WHERE client_id = $1",
          plan: "Index Scan using idx_vehicles_client_id (cost=0.15..8.21 rows=1)",
          cost: "Bajo (0.15 ms)",
          reason: "Utiliza índice en client_id",
        },
        subscriptions_active: {
          query: "SELECT * FROM subscriptions WHERE status = 'ACTIVE'",
          plan: "Index Scan using idx_subscriptions_status (cost=0.12..6.45 rows=5)",
          cost: "Bajo (0.12 ms)",
          reason: "Índice compuesto en status",
        },
      };

      res.json(plans.vehicles_by_client);
    } catch (error: any) {
      console.error("❌ Error POST /api/architect/explain-sim:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

   const distPath = path.join(process.cwd(), "dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

  // ═════════════════════════════════════════════════════════════════════════
  // ERROR HANDLING GLOBAL
  // ═════════════════════════════════════════════════════════════════════════

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("❌ Error global:", err.message);
    res.status(500).json({
      error: "Error interno del servidor",
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // INICIAR SERVIDOR
  // ═════════════════════════════════════════════════════════════════════════

  app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║  🚀 CarVault VIP Server iniciado exitosamente            ║
╠════════════════════════════════════════════════════════════╣
║  🌐 URL: http://${HOST}:${PORT}                            ║
║  📊 Dashboard: http://${HOST}:${PORT}                      ║
║  📡 API Base: http://${HOST}:${PORT}/api                   ║
║  ✅ MySQL: ${process.env.MYSQL_HOST || "localhost"}:${process.env.MYSQL_PORT}  ║
║  🔗 Fabric: ${fabricStatus.ready ? 'OK' : 'UNAVAILABLE'}                         ║
║                                                            ║
║  🔧 Endpoints disponibles:                                 ║
║  ├─ GET  /api/health                                     ║
║  ├─ POST /api/vehicles/register                          ║
║  ├─ GET  /api/vehicles/client/:clientId                  ║
║  ├─ POST /api/clients/onboard                            ║
║  ├─ GET  /api/clients/:clientId                          ║
║  ├─ POST /api/payments/subscribe                         ║
║  ├─ GET  /api/payments/subscriptions/:clientId           ║
║  ├─ POST /api/services/create                            ║
║  ├─ GET  /api/services/client/:clientId                  ║
║  ├─ POST /api/architect/chat                             ║
║  └─ POST /api/architect/explain-sim                      ║
║                                                            ║
║  ⚡ Para inicializar BD: npm run db:init                  ║
║  🧪 Para validar integración: npm run fabric:test        ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}

// Ejecutar servidor
startServer().catch((error) => {
  console.error("❌ Error iniciando servidor:", error.message);
  process.exit(1);
});
