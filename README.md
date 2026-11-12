# API Banco

API REST para gestionar clientes, cuentas y movimientos de un banco con MongoDB (driver oficial `mongodb`), Express 5 y TypeScript.

## Puesta en marcha

```bash
npm install
cp .env.example .env   # y rellena MONGODB_URI / DB_NAME / PORT
npm run dev
```

Variables de entorno (`.env`):

| Variable    | Ejemplo                       |
|-------------|-------------------------------|
| `MONGODB_URI` | `mongodb://localhost:27017`   |
| `DB_NAME`   | `banco`                       |
| `PORT`      | `3000`                        |

## Estructura

```
src/
├── index.ts                      # arranque, índices, rutas y manejo de errores
├── config/database.ts            # conexión a Mongo
├── models/                       # tipos de clientes, cuentas y movimientos
├── controllers/
│   ├── clientes.controller.ts
│   ├── cuentas.controller.ts     # alta (IBAN mód. 97), listados, estado, extracto
│   └── operaciones.controller.ts # ingresos, retiradas y transferencias
└── routes/
    ├── clientes.routes.ts
    ├── cuentas.routes.ts
    └── transferencias.routes.ts
```

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/clientes` | Alta de cliente |
| GET | `/clientes?pagina=&limite=` | Lista paginada |
| GET | `/clientes/:id` | Un cliente |
| PATCH | `/clientes/:id` | Modifica `nombre` y/o `email` |
| POST | `/cuentas` | Alta de cuenta (`clienteId`, `tipo`) |
| GET | `/cuentas?clienteId=&tipo=&estado=&pagina=&limite=` | Lista filtrada y paginada |
| GET | `/cuentas/:id` | Cuenta + `titular: { nombre, email }` |
| PATCH | `/cuentas/:id/estado` | Cambia el estado |
| GET | `/cuentas/:id/movimientos` | Extracto (`tipo`, `categoria`, `desde`, `hasta`, `orden`, `pagina`, `limite`) |
| POST | `/cuentas/:id/ingresos` | Ingreso |
| POST | `/cuentas/:id/retiradas` | Retirada |
| POST | `/transferencias` | Transferencia por IBAN |

## Decisiones de diseño

- **Unicidad**: `email`, `dni` e `iban` tienen índice único (se crean al arrancar). Los duplicados se detectan capturando el error `11000` de Mongo, no con una consulta previa. Si un IBAN generado colisiona, se reintenta con otro.
- **Saldo sin carreras**: los cargos usan `findOneAndUpdate` con `$inc` y la condición `saldo + descubiertoMax >= importe` (y el estado) en el propio filtro, así dos retiradas simultáneas no pueden dejar la cuenta por debajo del descubierto.
- **Transferencias**: primero se carga el origen (importe + comisión) y luego se abona el destino; si el abono falla, se devuelve el dinero al origen.
- **Límite diario (100000)**: suma retiradas y transferencias emitidas del día natural (hora del servidor). Las comisiones no cuentan para el límite, pero sí para el saldo.
- **Comisión**: `max(100, ceil(importe × 0,5 %))` entre clientes distintos; 0 entre cuentas del mismo cliente.
- **Extracto**: `hasta` en formato `YYYY-MM-DD` incluye ese día completo. `limite` por encima de 100 se recorta a 100.
- **ObjectId**: se valida que tenga 24 caracteres hexadecimales; si no, 400. Los `_id` se devuelven como string (serialización JSON de `ObjectId`).
- Todos los errores devuelven `{ "error": "..." }`, incluido un JSON mal formado (400) y una ruta inexistente (404).
