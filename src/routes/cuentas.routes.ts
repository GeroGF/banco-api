import { Router } from "express";
import {
    cambiarEstadoCuenta,
    createCuenta,
    getCuentas,
    getCuentaWithID,
    getMovimientosCuenta
} from "../controllers/cuentas.controller.js";
import { createIngreso, createRetirada } from "../controllers/operaciones.controller.js";


const router = Router();


router.post("/", createCuenta);
router.get("/", getCuentas);
router.get("/:id", getCuentaWithID);
router.patch("/:id/estado", cambiarEstadoCuenta);
router.get("/:id/movimientos", getMovimientosCuenta);
router.post("/:id/ingresos", createIngreso);
router.post("/:id/retiradas", createRetirada);


export default router;
