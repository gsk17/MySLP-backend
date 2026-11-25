import mongoose from 'mongoose';
import { config } from './config.js';

const cached =
  global._myslpMongoose ??
  (global._myslpMongoose = {
    conn: null,
    promise: null,
  });
export async function connectDB(uri = config.mongoUri) {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }
  if (!cached.promise) {
    mongoose.set('strictQuery', true);
    cached.promise = mongoose
      .connect(uri, {
        bufferCommands: false,
        maxPoolSize: 5,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 8000,
        socketTimeoutMS: 20000,
      })
      .catch((err) => {
        // Reset so the next invocation can retry instead of reusing a rejected promise.
        cached.promise = null;
        throw err;
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
export async function disconnectDB() {
  if (cached.conn) {
    await mongoose.disconnect();
    cached.conn = null;
    cached.promise = null;
  }
}

//True when the deployment's MongoDB is a replica set, so transactions are available
export function supportsTransactions() {
  const topology = mongoose.connection.client?.topology?.s?.description?.type;
  return topology === 'ReplicaSetWithPrimary' || topology === 'Sharded';
}
