import type { ObjectId } from "mongodb";


export type TipoMovimiento =
    "ingreso" | "retirada" | "transferencia_emitida" | "transferencia_recibida" | "comision";

export const TIPOS_MOVIMIENTO: TipoMovimiento[] =
    ["ingreso", "retirada", "transferencia_emitida", "transferencia_recibida", "comision"];

export type MovimientoT = {
    _id?: ObjectId,
    cuentaId: ObjectId,
    tipo: TipoMovimiento,
    importe: number,
    saldoResultante: number,
    concepto: string,
    categoria: string,
    transferenciaId?: ObjectId,
    fecha: Date
};
