import type { Request, Response } from "express";
import { ObjectId, type Collection } from "mongodb";
import type { ClienteT } from "../models/clientes.model.js";


let clientesCollection: Collection<ClienteT>;


export const configClientesCollection = (collection: Collection<ClienteT>) => {
    clientesCollection = collection;
};


// POST /clientes
export const createCliente = (
    req: Request,
    res: Response
) => {
    const body = req.body ?? {};
    const { nombre, email, dni } = body;

    if (typeof nombre !== "string" || nombre.trim() === "") {
        res.status(400).json({ error: "El nombre es obligatorio" });
        return;
    }
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        res.status(400).json({ error: "El email es obligatorio y debe tener un formato válido" });
        return;
    }
    if (typeof dni !== "string" || !/^\d{8}[A-Za-z]$/.test(dni.trim())) {
        res.status(400).json({ error: "El DNI es obligatorio y debe tener 8 dígitos y una letra" });
        return;
    }

    const nuevoCliente: ClienteT = {
        nombre: nombre.trim(),
        email: email.trim().toLowerCase(),
        dni: dni.trim().toUpperCase(),
        creadoEn: new Date()
    };

    // La unicidad la garantiza el índice único: si choca, Mongo lanza el error 11000
    clientesCollection.insertOne(nuevoCliente).then((result) => {
        res.status(201).json({
            _id: result.insertedId,
            ...nuevoCliente
        });
    }).catch((error) => {
        if (error?.code === 11000) {
            const campo = error.keyPattern?.dni ? "DNI" : "email";
            res.status(409).json({ error: `Ya existe un cliente con ese ${campo}` });
            return;
        }
        console.log(error);
        res.status(500).json({ error: "Error inesperado al crear el cliente" });
    });
};


// GET /clientes?pagina=1&limite=20
export const getClientes = (
    req: Request,
    res: Response
) => {
    const pagina = req.query.pagina === undefined ? 1 : Number(req.query.pagina);
    const limitePedido = req.query.limite === undefined ? 20 : Number(req.query.limite);

    if (!Number.isInteger(pagina) || pagina < 1 || !Number.isInteger(limitePedido) || limitePedido < 1) {
        res.status(400).json({ error: "pagina y limite deben ser enteros mayores que 0" });
        return;
    }
    const limite = Math.min(limitePedido, 100);

    Promise.all([
        clientesCollection.find()
            .sort({ creadoEn: -1, _id: -1 })
            .skip((pagina - 1) * limite)
            .limit(limite)
            .toArray(),
        clientesCollection.countDocuments()
    ]).then(([clientes, total]) => {
        res.json({
            datos: clientes,
            pagina,
            limite,
            totalElementos: total,
            totalPaginas: Math.ceil(total / limite)
        });
    }).catch((error) => {
        console.log(error);
        res.status(500).json({ error: "Error inesperado al listar los clientes" });
    });
};


// GET /clientes/:id
export const getClienteWithID = (
    req: Request,
    res: Response
) => {
    const id = String(req.params.id);

    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        res.status(400).json({ error: "El id no es un ObjectId válido" });
        return;
    }

    clientesCollection.findOne({ _id: new ObjectId(id) }).then((cliente) => {
        if (!cliente) {
            res.status(404).json({ error: "Cliente no encontrado" });
            return;
        }
        res.json(cliente);
    }).catch((error) => {
        console.log(error);
        res.status(500).json({ error: "Error inesperado al buscar el cliente" });
    });
};


// PATCH /clientes/:id  (solo nombre y/o email)
export const updateCliente = (
    req: Request,
    res: Response
) => {
    const id = String(req.params.id);

    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        res.status(400).json({ error: "El id no es un ObjectId válido" });
        return;
    }

    const body = req.body ?? {};

    if (body.dni !== undefined) {
        res.status(400).json({ error: "El DNI no se puede modificar" });
        return;
    }

    const cambios: { nombre?: string, email?: string } = {};

    if (body.nombre !== undefined) {
        if (typeof body.nombre !== "string" || body.nombre.trim() === "") {
            res.status(400).json({ error: "El nombre no puede estar vacío" });
            return;
        }
        cambios.nombre = body.nombre.trim();
    }

    if (body.email !== undefined) {
        if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
            res.status(400).json({ error: "El email no tiene un formato válido" });
            return;
        }
        cambios.email = body.email.trim().toLowerCase();
    }

    if (Object.keys(cambios).length === 0) {
        res.status(400).json({ error: "Debes indicar nombre o email para modificar" });
        return;
    }

    clientesCollection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: cambios },
        { returnDocument: "after" }
    ).then((cliente) => {
        if (!cliente) {
            res.status(404).json({ error: "Cliente no encontrado" });
            return;
        }
        res.json(cliente);
    }).catch((error) => {
        if (error?.code === 11000) {
            res.status(409).json({ error: "Ya existe un cliente con ese email" });
            return;
        }
        console.log(error);
        res.status(500).json({ error: "Error inesperado al modificar el cliente" });
    });
};
