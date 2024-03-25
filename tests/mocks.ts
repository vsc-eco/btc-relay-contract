//Crypto imports
import { ripemd160, sha256 } from "bitcoinjs-lib/src/crypto";

if (!globalThis.beforeEach) {
  await import("mocha").then((Mocha) => {
    Mocha.setup("bdd");
    mocha.timeout(0);
    setTimeout(() => Mocha.run(), 1000);
  });
}

/**
 * Raw WebAssembly Memory
 */
export let memory: WebAssembly.Memory;
/**
 * Total gas used in current test
 */
export let IOGas = 0;
/**
 * Error thrown by contract
 */
export let error: any;
/**
 * Logs printed in current test
 */
export let logs: string[] = [];
/**
 * Environment variables available to the contract
 */
export let contractEnv = {
  "block.included_in": null,
  "sender.id": null,
  "sender.type": null,
};
/**
 * Cache for current contract state
 */
export let stateCache = new Map();
/**
 * Contract instance
 */
export let contract: Awaited<
  ReturnType<typeof import("../build/debug").instantiate>
>;

async function instantiateContract<
  R,
  T extends {
    instantiate(
      module: WebAssembly.Module,
      imports: typeof globals
    ): Promise<R>;
  }
>(importPromise: Promise<T>): Promise<R> {
  const { instantiate } = await importPromise;
  return await (async (url) =>
    instantiate(
      await (async () => {
        try {
          return await globalThis.WebAssembly.compileStreaming(
            globalThis.fetch(url)
          );
        } catch {
          return globalThis.WebAssembly.compile(
            await (await import("node:fs/promises")).readFile(url)
          );
        }
      })(),
      globals
    ))(new URL("../build/debug.wasm", import.meta.url));
}

export async function reset() {
  memory = new WebAssembly.Memory({
    initial: 10,
    maximum: 128,
  });
  IOGas = 0;
  error = undefined;
  logs = [];
  contractEnv = {
    "block.included_in": null,
    "sender.id": null,
    "sender.type": null,
  };
  stateCache.clear();
  contract = await instantiateContract(import("@@/build/debug"));
}

/**
 * Contract System calls
 */
const contractCalls = {
  "crypto.sha256": (value) => {
    return sha256(Buffer.from(value, "hex")).toString("hex");
  },
  "crypto.ripemd160": (value) => {
    return ripemd160(Buffer.from(value, "hex")).toString("hex");
  },
};

const globals = {
  env: {
    get memory() {
      return memory;
    },
    abort(msg, file, line, colm) {
      error = {
        msg, //: insta.exports.__getString(msg),
        file, //: insta.exports.__getString(file),
        line,
        colm,
      };
    },
    //Prevent AS loader from allowing any non-deterministic data in.
    //TODO: Load in VRF seed for use in contract
    seed: () => {
      return 0;
    },
  },
  //Same here
  Date: {},
  Math: {},
  sdk: {
    console: {
      get log() {
        return globals.sdk["console.log"];
      },
      get logNumber() {
        return globals.sdk["console.logNumber"];
      },
      get logBool() {
        return globals.sdk["console.logBool"];
      },
    },
    "console.log": (keyPtr) => {
      const logMsg = keyPtr; // (insta as any).exports.__getString(keyPtr);
      logs.push(logMsg);
      IOGas = IOGas + logMsg.length;
    },
    "console.logNumber": (val: number) => {
      logs.push(val.toString());
    },
    "console.logBool": (val) => {
      logs.push(Boolean(val).toString());
    },
    db: {
      get setObject() {
        return globals.sdk["db.setObject"];
      },
      get getObject() {
        return globals.sdk["db.getObject"];
      },
      get delObject() {
        return globals.sdk["db.delObject"];
      },
    },
    "db.setObject": (keyPtr, valPtr) => {
      const key = keyPtr; //(insta as any).exports.__getString(keyPtr);
      const val = valPtr; //(insta as any).exports.__getString(valPtr);

      IOGas = IOGas + key.length + val.length;

      stateCache.set(key, val);
      return 1;
    },
    "db.getObject": (keyPtr) => {
      const key = keyPtr; //(insta as any).exports.__getString(keyPtr);
      const value = stateCache.get(key);

      const val = value;

      IOGas = IOGas + val.length; // Total serialized length of gas

      return val; //insta.exports.__newString(val);
    },
    "db.delObject": (keyPtr) => {
      const key = keyPtr; //(insta as any).exports.__getString(keyPtr);
      stateCache.delete(key);
    },
    system: {
      get getEnv() {
        return globals.sdk["system.getEnv"];
      },
      get call() {
        return globals.sdk["system.call"];
      },
    },
    "system.call": async (callPtr, valPtr) => {
      const callArg = callPtr; //insta.exports.__getString(callPtr);
      const valArg = JSON.parse(valPtr); //insta.exports.__getString(valPtr));
      let resultData;
      if (typeof contractCalls[callArg] === "function") {
        resultData = JSON.stringify({
          result: contractCalls[callArg](valArg.arg0),
        });
      } else {
        resultData = JSON.stringify({
          err: "INVALID_CALL",
        });
      }

      return resultData; //insta.exports.__newString(resultData);
    },
    "system.getEnv": async (envPtr) => {
      const envArg = envPtr; //insta.exports.__getString(envPtr);

      return contractEnv[envArg]; //insta.exports.__newString(contractEnv[envArg]);
    },
  },
};
