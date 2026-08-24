import { v7 as uuidv7 } from "uuid";

// 内部 immutable ID。UUIDv7(時間順序性あり)の hex 32 文字に種別 prefix を付ける。
// 要件 §6.1: ユーザーは通常このIDを意識しない。public handle とは分離(§30.2)。

export type AgentId = `agt_${string}`;
export type AccountId = `acc_${string}`;

const ID_BODY_RE = /^[0-9a-f]{32}$/;

export function generateId<P extends string>(prefix: P): `${P}_${string}` {
  return `${prefix}_${uuidv7().replaceAll("-", "")}` as `${P}_${string}`;
}

export const generateAgentId = (): AgentId => generateId("agt");
export const generateAccountId = (): AccountId => generateId("acc");

export function isId(value: string, prefix: string): boolean {
  return (
    value.startsWith(`${prefix}_`) &&
    ID_BODY_RE.test(value.slice(prefix.length + 1))
  );
}

export const isAgentId = (v: string): v is AgentId => isId(v, "agt");
export const isAccountId = (v: string): v is AccountId => isId(v, "acc");
