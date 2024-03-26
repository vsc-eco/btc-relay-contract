# Smart Contract template

Smart contracts on VSC are compiled using AssemblyScript. This is a template project to get started writing smart contracts.

### General Tips

For smart contract specific functionality, use the `@vsc.eco/sdk/assembly` module. For more general functionality, use the `assemblyscript/std/assembly` module. It contains useful data structures and functions that are usable in the smart contract. Note: If you see a missing module error during testing, it is likely that that part of the AssemblyScript standard library is not yet supported by VSC contracts.

## Scripts

- `build`: compiles a release build of the smart contract
- `asbuild:debug`: compiles a debug build of the smart contract. This is used in both test environments. For now, you need to manually compile this for code changes to reflect in tests.
- `test`: runs the tests using `jest`. This is good for CI or running individual tests without debugging support.
- `test:debug`: runs the tests using `mocha` & `vite`. This runs tests in the browser with sourcemap support allowing breakpoint debugging your smart contract with the original AssemblyScript source code.

## Folder structure

- `assembly`: where your smart contract source code lives
- `build`: where the build artifacts are placed
- `scripts`: placeholder for future scripts
- `tests`: where your tests live

### Files that should NOT be touched

These files will be moved to a separate library at some point and are not intended to be modified for contract development. Modifications may break your tests. You have been warned.

- `assembly/tsconfig.json`
- `index.html`
- `vite.config.ts`
- `.swcrc`
- `asconfig.json`
- `jest.config.cjs`
- `tsconfig.json`
- `tests/debug.ts`
- `tests/mocks.ts`
- `tests/vite-env.d.ts`

## Testing Apperatice

There is a file `tests/mocks.ts`, which contains all the utilities for testing. These utilities are listed below.

- `reset()`: Resets the state of the smart contract and returns it to the initial state. In the example `tests/index.ts`, this is called before each test, but you can call it manually if you want to reset the state during a test. It is also possible to call `reset()` manually in your test suite without using `beforEach()`, but this is advanced usage and not recommended due to the higher likelihood of bugs from the running order of tests.
- `contract`: The instance to your compiled smart contract with type safety.
- `stateCache`: A mock of the persistent state of the contract. This is cleared after each `reset()`.
- `contractEnv`: Envirnoment variables available to the contract.
- `logs`: An array of logs emitted by the smart contract since the last `reset()`.
- `error`: The last error thrown by the smart contract since the last `reset()`.
- `IOGas`: The total gas used by the smart contract since the last `reset()`.
- `memory`: Raw WebAssembly Memory your smart contract can access. This is not persisted between contract calls and is cleared after each `reset()`.
