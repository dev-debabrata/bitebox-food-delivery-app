import mongoose from "mongoose";
import { logger } from "../config/logger.js";

let supported;

/**
 * Transactions need a replica set or sharded cluster (Atlas: yes; a single
 * local mongod: no). DISABLE_TRANSACTIONS=true forces the fallback path (tests).
 */
export async function transactionsSupported() {
  if (supported === undefined && process.env.DISABLE_TRANSACTIONS === "true") supported = false;
  if (supported === undefined) {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName || hello.msg === "isdbgrid");
    if (!supported) logger.warn("MongoDB transactions unavailable (standalone server); using compensating fallback");
  }
  return supported;
}

/**
 * Runs `work(session)` inside a transaction when the deployment supports it.
 * Otherwise runs `work(null)`; callers must then make each step atomic and
 * undo earlier steps on failure (see order.service.js).
 */
export async function withTransaction(work) {
  if (!(await transactionsSupported())) return work(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/** For tests: forget the cached capability check. */
export const resetTransactionSupportCache = () => {
  supported = undefined;
};
