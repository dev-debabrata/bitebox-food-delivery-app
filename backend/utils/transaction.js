import mongoose from "mongoose";
import { logger } from "../config/logger.js";

let supported;

export async function transactionsSupported() {
  if (supported === undefined && process.env.DISABLE_TRANSACTIONS === "true")
    supported = false;
  if (supported === undefined) {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName || hello.msg === "isdbgrid");
    if (!supported)
      logger.warn(
        "MongoDB transactions unavailable (standalone server); using compensating fallback",
      );
  }
  return supported;
}

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
