import mongoose from 'mongoose';
import { config } from './config.js';

/**
 * Vercel runs this API as a serverless function: the module is re-evaluated on
 * a cold start and the same instance is reused for subsequent invocations.
 * Without caching the connection on `globalThis` every cold start would open a
 * brand new pool and quickly exhaust the Atlas M0 connection limit.
 */

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

/** True when the deployment's MongoDB is a replica set, so transactions are available. */
export function supportsTransactions() {
  // Atlas (even M0) is always a replica set. A bare local mongod is not.
  const topology = mongoose.connection.client?.topology?.s?.description?.type;
  return topology === 'ReplicaSetWithPrimary' || topology === 'Sharded';
}
