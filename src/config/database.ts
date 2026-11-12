import { Db, MongoClient } from "mongodb";


export const connectMongo = (): Promise<Db> => {
    const uri = process.env.MONGODB_URI;
    const dbName = process.env.DB_NAME || "banco";

    if (!uri) {
        return Promise.reject(new Error("Falta la variable de entorno MONGODB_URI"));
    }

    const client = new MongoClient(uri);

    return client.connect().then(() => {
        console.log("Conectado a MongoDB");
        return client.db(dbName);
    }).catch((error) => {
        console.log("Error al conectar con Mongo");
        throw error;
    });
};
