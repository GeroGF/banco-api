import express, { type NextFunction, type Request, type Response } from "express";
import type { Collection } from "mongodb";
import { connectMongo } from "./config/database.js";
import clientesRoutes from "./routes/clientes.routes.js";
import cuentasRoutes from "./routes/cuentas.routes.js";
import transferenciasRoutes from "./routes/transferencias.routes.js";
import { configClientesCollection } from "./controllers/clientes.controller.js";
import { configCuentasCollections } from "./controllers/cuentas.controller.js";
import { configOperacionesCollections } from "./controllers/operaciones.controller.js";
import type { ClienteT } from "./models/clientes.model.js";
import type { CuentaT } from "./models/cuentas.model.js";
import type { MovimientoT } from "./models/movimientos.model.js";


const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());


const startServer = () => {

    connectMongo().then((db) => {
        const clientesCollection: Collection<ClienteT> = db.collection("clientes");
        const cuentasCollection: Collection<CuentaT> = db.collection("cuentas");
        const movimientosCollection: Collection<MovimientoT> = db.collection("movimientos");

        // Índices: los únicos son los que garantizan email/dni/iban sin duplicados
        return Promise.all([
            clientesCollection.createIndex({ email: 1 }, { unique: true }),
            clientesCollection.createIndex({ dni: 1 }, { unique: true }),
            cuentasCollection.createIndex({ iban: 1 }, { unique: true }),
            cuentasCollection.createIndex({ clienteId: 1, estado: 1 }),
            movimientosCollection.createIndex({ cuentaId: 1, fecha: -1 }),
            movimientosCollection.createIndex({ transferenciaId: 1 })
        ]).then(() => {
            configClientesCollection(clientesCollection);
            configCuentasCollections(clientesCollection, cuentasCollection, movimientosCollection);
            configOperacionesCollections(cuentasCollection, movimientosCollection);

            app.use("/clientes", clientesRoutes);
            app.use("/cuentas", cuentasRoutes);
            app.use("/transferencias", transferenciasRoutes);

            // Ruta inexistente
            app.use((req: Request, res: Response) => {
                res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
            });

            // JSON mal formado u otro error no capturado
            app.use((err: any, req: Request, res: Response, next: NextFunction) => {
                if (err?.type === "entity.parse.failed") {
                    res.status(400).json({ error: "El body no es un JSON válido" });
                    return;
                }
                console.log(err);
                res.status(500).json({ error: "Error inesperado" });
            });

            app.listen(PORT, () => {
                console.log(`API del banco funcionando en el puerto ${PORT}`);
            });
        });

    }).catch((error) => {
        console.log("No se ha podido arrancar la API:", error?.message ?? error);
        process.exit(1);
    });

};

startServer();
