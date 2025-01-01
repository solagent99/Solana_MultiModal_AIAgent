import Ajv from "ajv";
import type { Step } from "./chain-of-thought";

/**
 * Represents a single "step" in the Chain of Thought.
 */
export interface CoTStep {
  id: string;
  content: string;
  timestamp: number;
  tags?: string[];
  meta?: Record<string, any>;
}

/**
 * ChainOfThoughtContext can hold any relevant data
 * the LLM or game might need to keep track of during reasoning.
 */
export interface ChainOfThoughtContext {
  // For example, a game state might have player info, world state, etc.
  worldState: string;
  queriesAvailable: string;
  availableActions: string;
  actionHistory?: Record<
    number,
    {
      action: CoTAction;
      result: string;
    }
  >;
}

/**
 * Different action types the CoT might execute.
 * You can expand or modify as needed.
 */
export type CoTActionType = "GRAPHQL_FETCH" | "EXECUTE_TRANSACTION";

/**
 * Data necessary for a particular action type.
 * Extend this to fit your actual logic.
 */
export interface CoTAction {
  type: "GRAPHQL_FETCH" | "EXECUTE_TRANSACTION";
  payload: Record<string, any>;
}

export interface LLMStructuredResponse {
  plan?: string;
  meta?: {
    requirements?: {
      resources?: Record<string, number>;
      population?: number;
    };
  };
  actions: CoTAction[];
}

export interface CoTTransaction {
  contractAddress: string;
  entrypoint: string;
  calldata: any[];
}

const queryValidatorSchema = {
  type: "object",
  properties: {
    plan: { type: "string" },
    meta: {
      type: "object",
      properties: {
        requirements: {
          type: "object",
          properties: {
            resources: {
              type: "object",
              additionalProperties: { type: "number" },
            },
            population: { type: "number" },
          },
        },
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["GRAPHQL_FETCH", "EXECUTE_TRANSACTION"],
          },
          payload: {
            type: "object",
          },
        },
        required: ["type", "payload"],
      },
    },
  },
  required: ["plan", "actions"],
  additionalProperties: false,
};

export const queryValidator = (
  response: any
): response is LLMStructuredResponse => {
  if (!response || typeof response !== "object") return false;
  if (!Array.isArray(response.actions)) return false;

  for (const action of response.actions) {
    if (!action.type || !action.payload) return false;
    if (!["GRAPHQL_FETCH", "EXECUTE_TRANSACTION"].includes(action.type))
      return false;
  }

  return true;
};

const transactionValidatorSchema = {
  type: "object",
  properties: {
    contractAddress: { type: "string" },
    entrypoint: { type: "string" },
    calldata: { type: "array" },
  },
  required: ["contractAddress", "entrypoint", "calldata"],
  additionalProperties: false,
};

export const transactionValidator = (
  transaction: any
): transaction is CoTTransaction => {
  if (!transaction || typeof transaction !== "object") return false;
  if (typeof transaction.contractAddress !== "string") return false;
  if (typeof transaction.entrypoint !== "string") return false;
  if (!Array.isArray(transaction.calldata)) return false;
  return true;
};
