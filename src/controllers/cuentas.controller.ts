import type { Request, Response } from "express";
import { randomInt } from "node:crypto";
import { ObjectId, type Collection, type Filter } from "mongodb";
import type { ClienteT } from "../models/clientes.model.js";
import { ESTADOS_CUENTA, TIPOS_CUENTA, type CuentaT, type EstadoCuenta, type TipoCuenta } from "../models/cuentas.model.js";
import { TIPOS_MOVIMIENTO, type MovimientoT, type TipoMovimiento } from "../models/movimientos.model.js";


let clientesCollection: Collection<ClienteT>;
let cuentasCollection: Collection<CuentaT>;
let movimientosCollection: Collection<MovimientoT>;


export const configCuentasCollections = (
    clientes: Collection<ClienteT>,
    cuentas: Collection<CuentaT>,
    movimientos: Collection<MovimientoT>
) => {
    clientesCollection = clientes;
    cuentasCollection = cuentas;
    movimientosCollection = movimientos;
};


// ---------------------------------------------------------------------------
// IBAN (ISO 13616, módulo 97)
// ---------------------------------------------------------------------------

// Sustituye cada letra por su número: A=10 ... Z=35 (E=14, S=28)
const letrasANumeros = (texto: string): string => {
    return texto.split("").map((c) => {
        if (c >= "A" && c <= "Z") return String(c.charCodeAt(0) - 55);
        return c;
    }).join("");
};

// Calcula numero mod 97 por trozos para no salirnos del rango de Number
const mod97 = (numero: string): number => {
    let resto = 0;
    for (let i = 0; i < numero.length; i += 7) {
        resto = Number(String(resto) + numero.slice(i, i + 7)) % 97;
    }
    return resto;
};

export const generarIban = (): string => {
    let bban = "";
    for (let i = 0; i < 20; i++) {
        bban += String(randomInt(0, 10));
    }
    const control = 98 - mod97(letrasANumeros(bban + "ES00"));
    return "ES" + String(control).padStart(2, "0") + bban;
};

export const validarIban = (iban: string): boolean => {
    if (!/^ES\d{22}$/.test(iban)) return false;
    const reordenado = iban.slice(4) + iban.slice(0, 4);
    return mod97(letrasANumeros(reordenado)) === 1;
};


// ---------------------------------------------------------------------------
// POST /cuentas
// ---------------------------------------------------------------------------

export const createCuenta = (
    req: Request,
    res: Response
) => {
    const body = req.body ?? {};
    const clienteId = body.clienteId;
    const tipo = body.tipo;

    if (typeof clienteId !== "string" || !/^[0-9a-fA-F]{24}$/.test(clienteId)) {
        res.status(400).json({ error: "clienteId es obligatorio y debe ser un ObjectId válido" });
        return;
    }
    if (!TIPOS_CUENTA.includes(tipo)) {
        res.status(400).json({ error: `tipo es obligatorio y debe ser uno de: ${TIPOS_CUENTA.join(", ")}` });
        return;
    }

    const clienteObjectId = new ObjectId(clienteId);

    // Inserta la cuenta y, si el IBAN choca con el índice único, lo reintenta con otro
    const insertarConIbanNuevo = (intentosRestantes: number): Promise<CuentaT> => {
        const nuevaCuenta: CuentaT = {
            iban: generarIban(),
            clienteId: clienteObjectId,
            tipo: tipo as TipoCuenta,
            saldo: 0,
            descubiertoMax: tipo === "corriente" ? 50000 : 0,
            estado: "activa",
            creadaEn: new Date()
        };

        return cuentasCollection.insertOne(nuevaCuenta).then((result) => {
            return { _id: result.insertedId, ...nuevaCuenta };
        }).catch((error) => {
            if (error?.code === 11000 && error.keyPattern?.iban && intentosRestantes > 1) {
                return insertarConIbanNuevo(intentosRestantes - 1);
            }
            throw error;
        });
    };

    clientesCollection.findOne({ _id: clienteObjectId }).then((cliente) => {
        if (!cliente) {
            res.status(404).json({ error: "Cliente no encontrado" });
            return;
        }

        return cuentasCollection.countDocuments({
            clienteId: clienteObjectId,
            estado: { $ne: "cerrada" }
        }).then((cuentasAbiertas) => {
            if (cuentasAbiertas >= 3) {
                res.status(409).json({ error: "El cliente ya tiene 3 cuentas no cerradas" });
                return;
            }

            return insertarConIbanNuevo(5).then((cuenta) => {
                res.status(201).json(cuenta);
            });
        });
    }).catch((error) => {
        console.log(error);
        res.status(500).json({ error: "Error inesperado al crear la cuenta" });
    });
};


// ---------------------------------------------------------------------------
// GET /cuentas?clienteId=&tipo=&estado=&pagina=&limite=
// ---------------------------------------------------------------------------

export const getCuentas = (
    req: Request,
    res: Response
) => {
    const filtro: Filter<CuentaT> = {};
    const { clienteId, tipo, estado } = req.query;

    if (clienteId !== undefined) {
        if (typeof clienteId !== "string" || !/^[0-9a-fA-F]{24}$/.test(clienteId)) {
            res.status(400).json({ error: "clienteId no es un ObjectId válido" });
            return;
        }
        filtro.clienteId = new ObjectId(clienteId);
    }
    if (tipo !== undefined) {
        if (typeof tipo !== "string" || !TIPOS_CUENTA.includes(tipo as TipoCuenta)) {
            res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_CUENTA.join(", ")}` });
            return;
        }
        filtro.tipo = tipo as TipoCuenta;
    }
    if (estado !== undefined) {
        if (typeof estado !== "string" || !ESTADOS_CUENTA.includes(estado as EstadoCuenta)) {
            res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS_CUENTA.join(", ")}` });
            return;
        }
        filtro.estado = estado as EstadoCuenta;
    }

    const pagina = req.query.pagina === undefined ? 1 : Number(req.query.pagina);
    const limitePedido = req.query.limite === undefined ? 20 : Number(req.query.limite);

    if (!Number.isInteger(pagina) || pagina < 1 || !Number.isInteger(limitePedido) || limitePedido < 1) {
        res.status(400).json({ error: "pagina y limite deben ser enteros mayores que 0" });
        return;
    }
    const limite = Math.min(limitePedido, 100);

    Promise.all([
        cuentasCollection.find(filtro)
            .sort({ creadaEn: -1, _id: -1 })
            .skip((pagina - 1) * limite)
            .limit(limite)
            .toArray(),
        cuentasCollection.countDocuments(filtro)
    ]).then(([cuentas, total]) => {
        res.json({
            datos: cuentas,
            pagina,
            limite,
            totalElementos: total,
            totalPaginas: Math.ceil(total / limite)
        });
    }).catch((error) => {
        console.log(error);
        res.status(500).json({ error: "Error inesperado al listar las cuentas" });
    });
};


// ---------------------------------------------------------------------------
// GET /cuentas/:id  (con nombre y email del titular)
// ---------------------------------------------------------------------------

export const getCuentaWithID = (
    req: Request,
    res: Response
) => {
    const id = String(req.params.id);

    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        res.status(400).json({ error: "El id no es un ObjectId válido" });
        return;
    }

    cuentasCollection.findOne({ _id: new ObjectId(id) }).then((cuenta) => {
        if (!cuenta) {
            res.status(404).json({ error: "Cuenta no encontrada" });
            return;
        }

        return clientesCollection.findOne(
            { _id: cuenta.clienteId },
            { projection: { nombre: 1, email: 1 } }
        ).then((titular) => {
            res.json({
                ...cuenta,
                titular: titular ? { nombre: titular.nombre, email: titular.email } : null
            });
        });
    }).catch((error) => {
        console.log(error);
        res.status(500).json({ error: "Error inesperado al buscar la cuenta" });
    });
};


// ---------------------------------------------------------------------------
// PATCH /cuentas/:id/estado
// ---------------------------------------------------------------------------

const TRANSICIONES: Record<EstadoCuenta, EstadoCuenta[]> = {
    activa: ["bloqueada", "cerrada"],
    bloqueada: ["activa", "cerrada"],
    cerrada: []
};

export const cambiarEstadoCuenta = (
    req: Request,
    res: Response
) => {
    const id = String(req.params.id);

    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        res.status(400).json({ error: "El id no es un ObjectId válido" });
        return;
    }

    const nuevoEstado = (req.body ?? {}).estado;

    if (!ESTADOS_CUENTA.includes(nuevoEstado)) {
        res.status(400).json({
            error: `Estado "${nuevoEstado}" inexistente. Valores válidos: ${ESTADOS_CUENTA.join(", ")}`
        });
        return;
    }

    const cuentaId = new ObjectId(id);

    cuentasCollection.findOne({ _id: cuentaId }).then((cuenta) => {
        if (!cuenta) {
            res.status(404).json({ error: "Cuenta no encontrada" });
            return;
        }

        if (!TRANSICIONES[cuenta.estado].includes(nuevoEstado)) {
            res.status(409).json({
                error: `Transición no permitida: estado actual "${cuenta.estado}", solicitado "${nuevoEstado}"`
            });
            return;
        }

        if (nuevoEstado === "cerrada" && cuenta.saldo !== 0) {
            res.status(409).json({
                error: `No se puede cerrar una cuenta con saldo distinto de 0 (saldo actual: ${cuenta.saldo})`
            });
            return;
        }

        // Actualización condicionada: si entre medias ha cambiado el estado o el saldo, no se aplica
        const condicion: Filter<CuentaT> = { _id: cuentaId, estado: cuenta.estado };
        if (nuevoEstado === "cerrada") condicion.saldo = 0;

        return cuentasCollection.findOneAndUpdate(
            condicion,
            { $set: { estado: nuevoEstado } },
            { returnDocument: "after" }
        ).then((actualizada) => {
            if (!actualizada) {
                res.status(409).json({ error: "La cuenta ha cambiado durante la operación, inténtalo de nuevo" });
                return;
            }
            res.json(actualizada);
        });
    }).catch((error) => {
        console.log(error);
        res.status(500).json({ error: "Error inesperado al cambiar el estado de la cuenta" });
    });
};


// ---------------------------------------------------------------------------
// GET /cuentas/:id/movimientos  (extracto)
// ---------------------------------------------------------------------------

export const getMovimientosCuenta = (
    req: Request,
    res: Response
) => {
    const id = String(req.params.id);

    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        res.status(400).json({ error: "El id no es un ObjectId válido" });
        return;
    }

    const cuentaId = new ObjectId(id);
    const filtro: Filter<MovimientoT> = { cuentaId };
    const { tipo, categoria, desde, hasta, orden } = req.query;

    // ?tipo=retirada,ingreso
    if (tipo !== undefined) {
        if (typeof tipo !== "string") {
            res.status(400).json({ error: "tipo debe indicarse una sola vez, separando valores por comas" });
            return;
        }
        const tipos = tipo.split(",").map((t) => t.trim()).filter((t) => t !== "");
        const invalidos = tipos.filter((t) => !TIPOS_MOVIMIENTO.includes(t as TipoMovimiento));
        if (tipos.length === 0 || invalidos.length > 0) {
            res.status(400).json({
                error: `Tipo de movimiento no válido: ${invalidos.join(", ") || "(vacío)"}. Valores válidos: ${TIPOS_MOVIMIENTO.join(", ")}`
            });
            return;
        }
        filtro.tipo = { $in: tipos as TipoMovimiento[] };
    }

    // ?categoria=vivienda
    if (categoria !== undefined) {
        if (typeof categoria !== "string" || categoria.trim() === "") {
            res.status(400).json({ error: "categoria no válida" });
            return;
        }
        filtro.categoria = categoria.trim();
    }

    // ?desde=2026-10-01&hasta=2026-10-31 (hasta incluye el día entero si viene sin hora)
    const rangoFecha: { $gte?: Date, $lt?: Date, $lte?: Date } = {};
    if (desde !== undefined) {
        const fechaDesde = new Date(String(desde));
        if (typeof desde !== "string" || isNaN(fechaDesde.getTime())) {
            res.status(400).json({ error: "desde no es una fecha válida" });
            return;
        }
        rangoFecha.$gte = fechaDesde;
    }
    if (hasta !== undefined) {
        const fechaHasta = new Date(String(hasta));
        if (typeof hasta !== "string" || isNaN(fechaHasta.getTime())) {
            res.status(400).json({ error: "hasta no es una fecha válida" });
            return;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
            fechaHasta.setUTCDate(fechaHasta.getUTCDate() + 1);
            rangoFecha.$lt = fechaHasta;
        } else {
            rangoFecha.$lte = fechaHasta;
        }
    }
    if (rangoFecha.$gte && (rangoFecha.$lt ?? rangoFecha.$lte) && rangoFecha.$gte > (rangoFecha.$lt ?? rangoFecha.$lte)!) {
        res.status(400).json({ error: "desde no puede ser posterior a hasta" });
        return;
    }
    if (Object.keys(rangoFecha).length > 0) filtro.fecha = rangoFecha;

    // ?orden=fecha | -fecha (por defecto, más recientes primero)
    if (orden !== undefined && orden !== "fecha" && orden !== "-fecha") {
        res.status(400).json({ error: "orden debe ser fecha o -fecha" });
        return;
    }
    const sentido = orden === "fecha" ? 1 : -1;

    const pagina = req.query.pagina === undefined ? 1 : Number(req.query.pagina);
    const limitePedido = req.query.limite === undefined ? 20 : Number(req.query.limite);

    if (!Number.isInteger(pagina) || pagina < 1 || !Number.isInteger(limitePedido) || limitePedido < 1) {
        res.status(400).json({ error: "pagina y limite deben ser enteros mayores que 0" });
        return;
    }
    const limite = Math.min(limitePedido, 100);

    cuentasCollection.findOne({ _id: cuentaId }, { projection: { _id: 1 } }).then((cuenta) => {
        if (!cuenta) {
            res.status(404).json({ error: "Cuenta no encontrada" });
            return;
        }

        return Promise.all([
            movimientosCollection.find(filtro)
                .sort({ fecha: sentido, _id: sentido })
                .skip((pagina - 1) * limite)
                .limit(limite)
                .toArray(),
            movimientosCollection.countDocuments(filtro)
        ]).then(([movimientos, total]) => {
            res.json({
                datos: movimientos,
                pagina,
                limite,
                totalElementos: total,
                totalPaginas: Math.ceil(total / limite)
            });
        });
    }).catch((error) => {
        console.log(error);
        res.status(500).json({ error: "Error inesperado al obtener los movimientos" });
    });
};
