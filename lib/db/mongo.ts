/**
 * MongoDB Atlas クライアント。接続文字列は env（.env.local / 本番 Secret Manager）。
 * 開発時の Hot Reload で接続が増殖しないよう global にキャッシュする定番実装。
 */
import { MongoClient, type Db } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? "kings";

declare global {
  // eslint-disable-next-line no-var
  var _kingsMongo: Promise<MongoClient> | undefined;
}

let clientPromise: Promise<MongoClient> | undefined;

export function getClient(): Promise<MongoClient> {
  if (!uri) {
    throw new Error("MONGODB_URI が未設定です（.env.local を用意してください）");
  }
  if (process.env.NODE_ENV === "development") {
    if (!global._kingsMongo) {
      global._kingsMongo = new MongoClient(uri).connect();
    }
    return global._kingsMongo;
  }
  if (!clientPromise) {
    clientPromise = new MongoClient(uri).connect();
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(dbName);
}
