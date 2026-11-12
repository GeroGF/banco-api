import { Router } from "express";
import { createCliente, getClientes, getClienteWithID, updateCliente } from "../controllers/clientes.controller.js";


const router = Router();


router.post("/", createCliente);
router.get("/", getClientes);
router.get("/:id", getClienteWithID);
router.patch("/:id", updateCliente);


export default router;
