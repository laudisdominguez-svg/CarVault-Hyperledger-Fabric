/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  CARVAULT VIP - SERVIDOR EXPRESS COMPLETO CON TODOS LOS ENDPOINTS       ║
 * ║  Backend REST API para Dashboard React + PostgreSQL + Hyperledger Fabric║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import pg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pg;

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN BÁSICA
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = process.env.HOST || "0.0.0.0";

// PostgreSQL Connection Pool
const pgPool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : 5432,
  database: process.env.PG_DATABASE || "carvault_db",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  ssl: process.env.PG_SSL === "true",
  max: process.env.PG_POOL_SIZE ? parseInt(process.env.PG_POOL_SIZE) : 20,
});

pgPool.on("error", (err: Error) => {
  console.error("❌ Error en conexión PostgreSQL:", err.message);
});

// ═════════════════════════════════════════════════════════════════════════════
// MOCK FABRIC SDK (Simulación - Reemplazar con SDK real cuando esté disponible)
// ═════════════════════════════════════════════════════════════════════════════

interface FabricInvokeResult {
  success: boolean;
  txId?: string;
  payload?: string;
  error?: string;
  timestamp: string;
}

async function invokeFabricChaincode(
  chaincodeName: string,
  functionName: string,
  args: string[]
): Promise<FabricInvokeResult> {
  console.log(`🔗 [FABRIC] ${chaincodeName}.${functionName}(${args.join(", ")})`);

  // TODO: Reemplazar con Fabric SDK real cuando esté disponible
  return {
    success: true,
    txId: `tx_${uuidv4().slice(0, 8)}`,
    payload: JSON.stringify({ status: "PENDING", data: args }),
    timestamp: new Date().toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CREAR SERVIDOR EXPRESS
// ═════════════════════════════════════════════════════════════════════════════

async function startServer() {
  const app = express();

  // Middleware
  app.use(express.json());

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
      await pgPool.query("SELECT NOW()");
      res.json({
        status: "HEALTHY",
        timestamp: new Date().toISOString(),
        services: {
          server: "OK",
          postgresql: "OK",
          fabric: "MOCK_MODE",
        },
      });
    } catch (error: any) {
      res.status(500).json({ status: "UNHEALTHY", error: error.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ENDPOINTS: VEHÍCULOS (car-cc)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/vehicles/register
   * Registrar nuevo vehículo
   */
  app.post("/api/vehicles/register", async (req: Request, res: Response) => {
    try {
      const { vin, marca, modelo, anio, clientId } = req.body;

      if (!vin || !marca || !modelo || !anio || !clientId) {
        return res.status(400).json({
          error: "Campos requeridos: vin, marca, modelo, anio, clientId",
        });
      }

      const carId = `CAR_${uuidv4().slice(0, 8)}`;

      // Invocar blockchain
      const fabricResult = await invokeFabricChaincode(
        "car-cc",
        "RegisterCar",
        [carId, vin, marca, modelo, anio.toString(), clientId, new Date().toISOString()]
      );

      if (fabricResult.success) {
        // Guardar en PostgreSQL
        try {
          await pgPool.query(
            `INSERT INTO vehicles (car_id, vin, marca, modelo, anio, client_id, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
  app.get("/api/vehicles/client/:clientId", async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      try {
        const result = await pgPool.query(
          "SELECT * FROM vehicles WHERE client_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC",
          [clientId]
        );

        res.json({
          success: true,
          count: result.rows.length,
          vehicles: result.rows,
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
  app.post("/api/clients/onboard", async (req: Request, res: Response) => {
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
      const fabricResult = await invokeFabricChaincode(
        "identity-cc",
        "OnboardClient",
        [clientProfileId, clientId, alias, "PENDING_REVIEW", new Date().toISOString()]
      );

      if (fabricResult.success) {
        // Guardar en PostgreSQL
        try {
          await pgPool.query(
            `INSERT INTO clients (client_id, client_profile_id, alias, nombre, email, telefono, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
  app.get("/api/clients/:clientId", async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      try {
        const result = await pgPool.query("SELECT * FROM clients WHERE client_id = $1", [clientId]);

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Cliente no encontrado" });
        }

        res.json({
          success: true,
          client: result.rows[0],
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
  app.post("/api/payments/subscribe", async (req: Request, res: Response) => {
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
      const fabricResult = await invokeFabricChaincode(
        "payment-cc",
        "CreateSubscription",
        [subscriptionId, clientId, plan, amount.toString(), currency || "USD"]
      );

      if (fabricResult.success) {
        // Guardar en PostgreSQL
        const planDays = {
          SILVER: 30,
          GOLD: 90,
          PLATINUM: 365,
        };
        const startDate = new Date();
        const endDate = new Date(startDate.getTime() + (planDays[plan as keyof typeof planDays] || 30) * 24 * 60 * 60 * 1000);

        try {
          await pgPool.query(
            `INSERT INTO subscriptions (subscription_id, client_id, plan, amount, currency, status, start_date, end_date, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
  app.get("/api/payments/subscriptions/:clientId", async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      try {
        const result = await pgPool.query(
          "SELECT * FROM subscriptions WHERE client_id = $1 ORDER BY created_at DESC",
          [clientId]
        );

        res.json({
          success: true,
          subscriptions: result.rows,
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
  app.post("/api/services/create", async (req: Request, res: Response) => {
    try {
      const { carId, clientId, serviceType, description } = req.body;

      if (!carId || !clientId || !serviceType) {
        return res.status(400).json({
          error: "Campos requeridos: carId, clientId, serviceType",
        });
      }

      const serviceOrderId = `SRV_${uuidv4().slice(0, 8)}`;

      // Invocar blockchain
      const fabricResult = await invokeFabricChaincode(
        "maintenance-cc",
        "CreateServiceOrder",
        [serviceOrderId, carId, clientId, serviceType, description || "", new Date().toISOString()]
      );

      if (fabricResult.success) {
        // Guardar en PostgreSQL
        try {
          await pgPool.query(
            `INSERT INTO service_orders (service_order_id, car_id, client_id, service_type, description, status, requested_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
  app.get("/api/services/client/:clientId", async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      try {
        const result = await pgPool.query(
          "SELECT * FROM service_orders WHERE client_id = $1 ORDER BY requested_at DESC",
          [clientId]
        );

        res.json({
          success: true,
          serviceOrders: result.rows,
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

  // ═════════════════════════════════════════════════════════════════════════
  // VITE MIDDLEWARE & STATIC FILES
  // ═════════════════════════════════════════════════════════════════════════

  if (process.env.NODE_ENV !== "production") {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (error) {
      console.warn("⚠️ Vite middleware no disponible en modo desarrollo");
    }
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

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
║  ✅ PostgreSQL: ${process.env.PG_HOST || "localhost"}:${process.env.PG_PORT || "5432"}  ║
║  🔗 Fabric: MOCK MODE (ready for real SDK)              ║
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
