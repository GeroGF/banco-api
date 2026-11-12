import type { Request, Response } from "express";
import { ObjectId, type Collection } from "mongodb";
import type { CuentaT } from "../models/cuentas.model.js";
import type { MovimientoT } from "../models/movimientos.model.js";
import { validarIban } from "./cuentas.controller.js";


let cuentasCollection: Collection<CuentaT>;
let movimientosCollection: Collection<MovimientoT>;


export const configOperacionesCollections = (
    cuentas: Collection<CuentaT>,
    movimientos: Collection<MovimientoT>
) => {
    cuentasCollection = cuentas;
    movimientosCollection = movimientos;
};


const LIMITE_DIARIO = 100000;


// Error "controlado" para cortar una cadena de promesas con un código HTTP concreto
class ErrorOperacion extends Error {
    status: number;
    constructor(status: number, mensaje: string) {
        super(mensaje);
        this.status = status;
    }
}

const responderError = (res: Response, error: unknown, mensaje500: string) => {
    if (error instanceof ErrorOperacion) {
        res.status(error.status).json({ error: error.message });
        return;
    }
    console.log(error);
    res.status(500).json({ error: mensaje500 });
};


// Suma (en positivo) de lo que ha salido hoy de la cuenta por retiradas y transferencias emitidas.
// Las comisiones no cuentan para el límite.
const retiradoHoy = (cuentaId: ObjectId): Promise<number> => {
    const inicioDia = new Date();
    inicioDia.setHours(0, 0, 0, 0);

    return movimientosCollection.aggregate<{ total: number }>([
        {
            $match: {
                cuentaId,
                tipo: { $in: ["retirada", "transferencia_emitida"] },
                fecha: { $gte: inicioDia }
            }
        },
        { $group: { _id: null, total: { $sum: "$importe" } } }
    ]).toArray().then((resultado) => {
        return Math.abs(resultado[0]?.total ?? 0);
    });
};


// Valida importe / concepto / categoria comunes a ingresos, retiradas y transferencias.
// Devuelve el mensaje de error o null si todo está bien.
const validarBodyOperacion = (body: any): string | null => {
    if (typeof body.importe !== "number" || !Number.isInteger(body.importe) || body.importe <= 0) {
        return "El importe debe ser un número entero de céntimos mayor que 0";
    }
    if (!Number.isSafeInteger(body.importe)) {
        return "El importe es demasiado grande";
    }
    if (typeof body.concepto !== "string" || body.concepto.trim() === "") {
        return "El concepto es obligatorio";
    }
    if (body.categoria !== undefined && (typeof body.categoria !== "string" || body.categoria.trim() === "")) {
        return "La categoría, si se indica, debe ser un texto no vacío";
    }
    return null;
};


// Comprueba saldo + descubierto y límite diario para una salida de dinero
const comprobarSalida = (cuenta: CuentaT, importe: number, totalADescontar: number): Promise<void> => {
    const disponible = cuenta.saldo + cuenta.descubiertoMax;

    if (totalADescontar > disponible) {
        return Promise.reject(new ErrorOperacion(409,
            `Saldo insuficiente: disponible ${disponible} céntimos (incluido descubierto), solicitado ${totalADescontar}`
        ));
    }

    return retiradoHoy(cuenta._id!).then((yaRetirado) => {
        if (yaRetirado + importe > LIMITE_DIARIO) {
            throw new ErrorOperacion(409,
                `Límite diario superado: hoy ya han salido ${yaRetirado} céntimos, solicitado ${importe}, máximo ${LIMITE_DIARIO}`
            );
        }
    });
};


// ---------------------------------------------------------------------------
// POST /cuentas/:id/ingresos
// ---------------------------------------------------------------------------

export const createIngreso = (
    req: Request,
    res: Response
) => {
    const id = String(req.params.id);

    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        res.status(400).json({ error: "El id no es un ObjectId válido" });
        return;
    }

    const body = req.body ?? {};
    const errorValidacion = validarBodyOperacion(body);
    if (errorValidacion) {
        res.status(400).json({ error: errorValidacion });
        return;
    }

    const cuentaId = new ObjectId(id);
    const importe: number = body.importe;

    cuentasCollection.findOne({ _id: cuentaId }).then((cuenta) => {
        if (!cuenta) throw new ErrorOperacion(404, "Cuenta no encontrada");
        if (cuenta.estado === "cerrada") {
            throw new ErrorOperacion(409, "La cuenta está cerrada y no admite operaciones");
        }

        // $inc atómico condicionado a que la cuenta siga sin estar cerrada
        return cuentasCollection.findOneAndUpdate(
            { _id: cuentaId, estado: { $ne: "cerrada" } },
            { $inc: { saldo: importe } },
            { returnDocument: "after" }
        );
    }).then((cuentaActualizada) => {
        if (!cuentaActualizada) throw new ErrorOperacion(409, "La cuenta ha cambiado de estado, inténtalo de nuevo");

        const movimiento: MovimientoT = {
            cuentaId,
            tipo: "ingreso",
            importe,
            saldoResultante: cuentaActualizada.saldo,
            concepto: body.concepto.trim(),
            categoria: body.categoria?.trim() ?? "otros",
            fecha: new Date()
        };

        return movimientosCollection.insertOne(movimiento).then((result) => {
            res.status(201).json({ _id: result.insertedId, ...movimiento });
        });
    }).catch((error) => {
        responderError(res, error, "Error inesperado al realizar el ingreso");
    });
};


// ---------------------------------------------------------------------------
// POST /cuentas/:id/retiradas
// ---------------------------------------------------------------------------

export const createRetirada = (
    req: Request,
    res: Response
) => {
    const id = String(req.params.id);

    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        res.status(400).json({ error: "El id no es un ObjectId válido" });
        return;
    }

    const body = req.body ?? {};
    const errorValidacion = validarBodyOperacion(body);
    if (errorValidacion) {
        res.status(400).json({ error: errorValidacion });
        return;
    }

    const cuentaId = new ObjectId(id);
    const importe: number = body.importe;

    cuentasCollection.findOne({ _id: cuentaId }).then((cuenta) => {
        if (!cuenta) throw new ErrorOperacion(404, "Cuenta no encontrada");
        if (cuenta.estado !== "activa") {
            throw new ErrorOperacion(409, `La cuenta está ${cuenta.estado} y no admite retiradas`);
        }

        return comprobarSalida(cuenta, importe, importe);
    }).then(() => {
        // Descuento atómico: solo se aplica si sigue activa y el saldo + descubierto alcanza
        return cuentasCollection.findOneAndUpdate(
            {
                _id: cuentaId,
                estado: "activa",
                $expr: { $gte: [{ $add: ["$saldo", "$descubiertoMax"] }, importe] }
            },
            { $inc: { saldo: -importe } },
            { returnDocument: "after" }
        );
    }).then((cuentaActualizada) => {
        if (!cuentaActualizada) {
            throw new ErrorOperacion(409, "La cuenta ha cambiado durante la operación (saldo o estado), inténtalo de nuevo");
        }

        const movimiento: MovimientoT = {
            cuentaId,
            tipo: "retirada",
            importe: -importe,
            saldoResultante: cuentaActualizada.saldo,
            concepto: body.concepto.trim(),
            categoria: body.categoria?.trim() ?? "otros",
            fecha: new Date()
        };

        return movimientosCollection.insertOne(movimiento).then((result) => {
            res.status(201).json({ _id: result.insertedId, ...movimiento });
        });
    }).catch((error) => {
        responderError(res, error, "Error inesperado al realizar la retirada");
    });
};


// ---------------------------------------------------------------------------
// POST /transferencias
// ---------------------------------------------------------------------------

export const createTransferencia = (
    req: Request,
    res: Response
) => {
    const body = req.body ?? {};

    if (typeof body.ibanOrigen !== "string" || typeof body.ibanDestino !== "string") {
        res.status(400).json({ error: "ibanOrigen e ibanDestino son obligatorios" });
        return;
    }

    const ibanOrigen = body.ibanOrigen.replace(/\s/g, "").toUpperCase();
    const ibanDestino = body.ibanDestino.replace(/\s/g, "").toUpperCase();

    if (!validarIban(ibanOrigen)) {
        res.status(400).json({ error: "El IBAN de origen no es válido" });
        return;
    }
    if (!validarIban(ibanDestino)) {
        res.status(400).json({ error: "El IBAN de destino no es válido" });
        return;
    }
    if (ibanOrigen === ibanDestino) {
        res.status(400).json({ error: "El IBAN de origen y el de destino deben ser distintos" });
        return;
    }

    const errorValidacion = validarBodyOperacion(body);
    if (errorValidacion) {
        res.status(400).json({ error: errorValidacion });
        return;
    }

    const importe: number = body.importe;
    const concepto: string = body.concepto.trim();
    const categoria: string = body.categoria?.trim() ?? "otros";
    const transferenciaId = new ObjectId();

    let origen: CuentaT;
    let destino: CuentaT;
    let comision = 0;
    let total = 0;
    let saldoOrigenFinal = 0;

    Promise.all([
        cuentasCollection.findOne({ iban: ibanOrigen }),
        cuentasCollection.findOne({ iban: ibanDestino })
    ]).then(([cuentaOrigen, cuentaDestino]) => {
        if (!cuentaOrigen) throw new ErrorOperacion(404, "La cuenta de origen no existe");
        if (!cuentaDestino) throw new ErrorOperacion(404, "La cuenta de destino no existe");

        if (cuentaOrigen.estado !== "activa") {
            throw new ErrorOperacion(409, `La cuenta de origen está ${cuentaOrigen.estado} y no puede emitir transferencias`);
        }
        if (cuentaDestino.estado === "cerrada") {
            throw new ErrorOperacion(409, "La cuenta de destino está cerrada y no puede recibir transferencias");
        }

        origen = cuentaOrigen;
        destino = cuentaDestino;

        // Gratis entre cuentas del mismo cliente; si no, 0,5 % con mínimo 100, redondeando hacia arriba
        if (!origen.clienteId.equals(destino.clienteId)) {
            comision = Math.max(100, Math.ceil(importe * 5 / 1000));
        }
        total = importe + comision;

        return comprobarSalida(origen, importe, total);
    }).then(() => {
        // 1) Cargo atómico en origen (importe + comisión)
        return cuentasCollection.findOneAndUpdate(
            {
                _id: origen._id!,
                estado: "activa",
                $expr: { $gte: [{ $add: ["$saldo", "$descubiertoMax"] }, total] }
            },
            { $inc: { saldo: -total } },
            { returnDocument: "after" }
        );
    }).then((origenActualizado) => {
        if (!origenActualizado) {
            throw new ErrorOperacion(409, "La cuenta de origen ha cambiado durante la operación (saldo o estado), inténtalo de nuevo");
        }
        saldoOrigenFinal = origenActualizado.saldo;

        // 2) Abono atómico en destino (activa o bloqueada)
        return cuentasCollection.findOneAndUpdate(
            { _id: destino._id!, estado: { $in: ["activa", "bloqueada"] } },
            { $inc: { saldo: importe } },
            { returnDocument: "after" }
        ).then((destinoActualizado) => {
            if (!destinoActualizado) {
                // Compensación: devolvemos al origen lo que se le había cargado
                return cuentasCollection.updateOne(
                    { _id: origen._id! },
                    { $inc: { saldo: total } }
                ).then(() => {
                    throw new ErrorOperacion(409, "La cuenta de destino ha cambiado de estado, transferencia cancelada");
                });
            }
            return destinoActualizado;
        });
    }).then((destinoActualizado) => {
        const fecha = new Date();

        const movimientos: MovimientoT[] = [
            {
                cuentaId: origen._id!,
                tipo: "transferencia_emitida",
                importe: -importe,
                saldoResultante: saldoOrigenFinal + comision,
                concepto,
                categoria,
                transferenciaId,
                fecha
            }
        ];

        if (comision > 0) {
            movimientos.push({
                cuentaId: origen._id!,
                tipo: "comision",
                importe: -comision,
                saldoResultante: saldoOrigenFinal,
                concepto: `Comisión transferencia: ${concepto}`,
                categoria: "comisiones",
                transferenciaId,
                fecha
            });
        }

        movimientos.push({
            cuentaId: destino._id!,
            tipo: "transferencia_recibida",
            importe,
            saldoResultante: destinoActualizado.saldo,
            concepto,
            categoria,
            transferenciaId,
            fecha
        });

        return movimientosCollection.insertMany(movimientos).then(() => {
            res.status(201).json({
                transferenciaId,
                ibanOrigen,
                ibanDestino,
                importe,
                comision,
                saldoOrigen: saldoOrigenFinal,
                concepto,
                categoria,
                fecha
            });
        });
    }).catch((error) => {
        responderError(res, error, "Error inesperado al realizar la transferencia");
    });
};
